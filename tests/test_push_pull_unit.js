import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { exportSummaries, importAndMergeSummaries } from '../src/db.js';
import { initGitRepo, gitPull, gitCommitAndPush } from '../src/git.js';
import { loadMetadataGuard, recordMetadataGuard } from '../src/metadata_guard.js';
import { exportToSyncDir, importFromSyncDir } from '../src/storage.js';

const testDir = path.join(process.cwd(), 'tests', 'test_push_pull_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

function seedConversation(dbPath, rows, homeDir = 'C:/Users/pcA', includeParents = false, parents = []) {
  importAndMergeSummaries(dbPath, {
    version: 2,
    sourceHomeDir: homeDir,
    conversations: rows,
    parents
  }, { targetHome: homeDir, includeParentsTable: includeParents });
}

function makeConv(id, title, time, steps = 5, overrides = {}) {
  return {
    conversation_id: id,
    title,
    preview: `preview ${id}`,
    step_count: steps,
    last_modified_time: time,
    workspace_uris: '["file:///{{USER_HOME}}/workspace"]',
    status: 'CASCADE_RUN_STATUS_IDLE',
    source: '',
    project_id: 'proj-default',
    agent_name: '',
    parent_conversation_id: '',
    nesting_depth: 0,
    battle_id: '',
    winning_conversation_id: '',
    not_fully_idle: 0,
    killed: 0,
    last_user_input_time: time,
    last_user_input_step_index: Math.max(0, steps - 1),
    app_data_dir: 'antigravity',
    raw_summary: null,
    group_id: '',
    ...overrides
  };
}

try {
  // 1. Non-destructive push union merge across two PCs + timestamp beats Git mtime
  {
    const syncDir = path.join(testDir, 'case1-sync');
    const pcA = {
      desktopDir: path.join(testDir, 'pcA-desk'),
      cliDir: path.join(testDir, 'pcA-cli'),
      geminiConfigDir: path.join(testDir, 'pcA-cfg'),
      projectsDir: path.join(testDir, 'pcA-cfg', 'projects'),
      syncDir,
      targets: { desktop: true, cli: true, config: true }
    };
    const pcB = {
      desktopDir: path.join(testDir, 'pcB-desk'),
      cliDir: path.join(testDir, 'pcB-cli'),
      geminiConfigDir: path.join(testDir, 'pcB-cfg'),
      projectsDir: path.join(testDir, 'pcB-cfg', 'projects'),
      syncDir,
      targets: { desktop: true, cli: true, config: true }
    };

    for (const base of [pcA.desktopDir, pcA.cliDir, pcB.desktopDir, pcB.cliDir]) {
      fs.mkdirSync(path.join(base, 'conversations'), { recursive: true });
      fs.mkdirSync(path.join(base, 'cache'), { recursive: true });
    }
    fs.mkdirSync(pcA.projectsDir, { recursive: true });
    fs.mkdirSync(pcB.projectsDir, { recursive: true });

    // PC A pushes conv-a and shared conv-shared (NEWER in remote: 12:00Z, step 20)
    seedConversation(path.join(pcA.desktopDir, 'conversation_summaries.db'), [
      makeConv('conv-a', 'PC A Only', '2026-11-16T11:00:00Z', 8),
      makeConv('conv-shared', 'Shared Newer From A', '2026-11-16T12:00:00Z', 20)
    ], 'C:/Users/pcA');
    fs.writeFileSync(path.join(pcA.desktopDir, 'conversations', 'conv-a.db'), 'DB_A');
    fs.writeFileSync(path.join(pcA.desktopDir, 'conversations', 'conv-shared.db'), 'REMOTE_NEWER_BYTES');
    fs.writeFileSync(path.join(pcA.cliDir, 'settings.json'), JSON.stringify({ trustedWorkspaces: ['C:\\Users\\pcA\\repoA'] }));
    fs.writeFileSync(path.join(pcA.cliDir, 'cache', 'last_conversations.json'), JSON.stringify({ 'C:\\Users\\pcA\\repoA': 'cli-a' }));
    fs.writeFileSync(path.join(pcA.geminiConfigDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { srvA: { command: 'a' } } }));

    exportToSyncDir(pcA, { homeDir: 'C:/Users/pcA' });

    // PC B (without having pulled A) has conv-b AND an OLDER copy of conv-shared whose .db mtime is artificially newer
    seedConversation(path.join(pcB.desktopDir, 'conversation_summaries.db'), [
      makeConv('conv-b', 'PC B Only', '2026-11-16T13:00:00Z', 9),
      makeConv('conv-shared', 'Shared Older On B', '2026-11-16T10:00:00Z', 5)
    ], 'C:/Users/pcB');
    const bSharedDb = path.join(pcB.desktopDir, 'conversations', 'conv-shared.db');
    fs.writeFileSync(path.join(pcB.desktopDir, 'conversations', 'conv-b.db'), 'DB_B');
    fs.writeFileSync(bSharedDb, 'LOCAL_OLDER_BYTES');
    const futureDate = new Date(Date.now() + 120_000);
    fs.utimesSync(bSharedDb, futureDate, futureDate);
    fs.writeFileSync(path.join(pcB.cliDir, 'settings.json'), JSON.stringify({ trustedWorkspaces: ['C:\\Users\\pcB\\repoB'] }));
    fs.writeFileSync(path.join(pcB.cliDir, 'cache', 'last_conversations.json'), JSON.stringify({ 'C:\\Users\\pcB\\repoB': 'cli-b' }));
    fs.writeFileSync(path.join(pcB.geminiConfigDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { srvB: { command: 'b' } } }));

    // PC B pushes: union merge must preserve conv-a, srvA, repoA AND refuse overwriting REMOTE_NEWER_BYTES!
    exportToSyncDir(pcB, { homeDir: 'C:/Users/pcB' });

    const syncedDeskIdx = JSON.parse(fs.readFileSync(path.join(syncDir, 'desktop', 'conversations_index.json'), 'utf8'));
    const ids = new Set(syncedDeskIdx.conversations.map(c => c.conversation_id));
    assert(ids.has('conv-a'), 'Remote-only conv-a must survive PC B push');
    assert(ids.has('conv-b'), 'Local conv-b must be added by PC B push');
    assert.strictEqual(syncedDeskIdx.conversations.find(c => c.conversation_id === 'conv-shared').title, 'Shared Newer From A');
    assert.strictEqual(fs.readFileSync(path.join(syncDir, 'desktop', 'conversations', 'conv-shared.db'), 'utf8'), 'REMOTE_NEWER_BYTES', 'Older local DB with newer mtime must not overwrite newer remote DB');

    const syncedSettings = JSON.parse(fs.readFileSync(path.join(syncDir, 'cli', 'settings.json'), 'utf8'));
    assert.strictEqual(syncedSettings.trustedWorkspaces.length, 2, 'trustedWorkspaces must union-merge on push');
    const syncedLast = JSON.parse(fs.readFileSync(path.join(syncDir, 'cli', 'last_conversations.json'), 'utf8'));
    assert.strictEqual(Object.keys(syncedLast).length, 2, 'last_conversations.json must union-merge on push');
    const syncedMcp = JSON.parse(fs.readFileSync(path.join(syncDir, 'config', 'mcp_config.json'), 'utf8'));
    assert(syncedMcp.mcpServers.srvA && syncedMcp.mcpServers.srvB, 'mcp_config.json servers must union-merge on push');

    // Now test PULL freshness overrides future local mtime when remote is genuinely newer,
    // AND protects local DB when remote is older (even if git checkout gave remote a future mtime)
    seedConversation(path.join(pcB.desktopDir, 'conversation_summaries.db'), [
      makeConv('conv-local-newer', 'Local Is Newer', '2026-11-16T15:00:00Z', 15)
    ], 'C:/Users/pcB');
    fs.writeFileSync(path.join(pcB.desktopDir, 'conversations', 'conv-local-newer.db'), 'LOCAL_REALLY_NEWER');

    syncedDeskIdx.conversations.push(makeConv('conv-local-newer', 'Remote Older Copy', '2026-11-16T09:00:00Z', 2));
    fs.writeFileSync(path.join(syncDir, 'desktop', 'conversations_index.json'), JSON.stringify(syncedDeskIdx, null, 2));
    const syncLocalNewerDb = path.join(syncDir, 'desktop', 'conversations', 'conv-local-newer.db');
    fs.writeFileSync(syncLocalNewerDb, 'REMOTE_REALLY_OLDER');
    const furtherFuture = new Date(Date.now() + 240_000);
    fs.utimesSync(syncLocalNewerDb, furtherFuture, furtherFuture);

    await importFromSyncDir(pcB, { targetHome: 'C:/Users/pcB' });
    assert.strictEqual(fs.readFileSync(bSharedDb, 'utf8'), 'REMOTE_NEWER_BYTES', 'Pull must update older local DB even if local mtime was artificially newer');
    assert.strictEqual(fs.readFileSync(path.join(pcB.desktopDir, 'conversations', 'conv-local-newer.db'), 'utf8'), 'LOCAL_REALLY_NEWER', 'Pull must NOT overwrite strictly newer local DB even if sync mtime is newer');
  }

  // 2. Smart Project Locator discoveredMappings propagate into Desktop & CLI conversations on pull
  {
    const syncDir = path.join(testDir, 'case2-sync');
    const searchRoot = path.join(testDir, 'case2-bob-dev');
    const relocatedRepo = path.join(searchRoot, 'cool-app');
    fs.mkdirSync(relocatedRepo, { recursive: true });

    const srcDesktop = path.join(testDir, 'case2-src-desk');
    const srcConfig = path.join(testDir, 'case2-src-cfg');
    const srcProjects = path.join(srcConfig, 'projects');
    fs.mkdirSync(srcProjects, { recursive: true });
    fs.mkdirSync(path.join(srcDesktop, 'brain', 'conv-loc-1', '.system_generated', 'logs'), { recursive: true });

    seedConversation(path.join(srcDesktop, 'conversation_summaries.db'), [
      makeConv('conv-loc-1', 'Relocated Project Session', '2026-11-16T12:00:00Z', 10, {
        workspace_uris: '["file:///C:/Users/alice/old-folder/cool-app"]',
        project_id: 'proj-cool-app'
      })
    ], 'C:/Users/alice');
    fs.writeFileSync(
      path.join(srcDesktop, 'brain', 'conv-loc-1', '.system_generated', 'logs', 'transcript.jsonl'),
      JSON.stringify({ path: 'C:\\Users\\alice\\old-folder\\cool-app\\index.js' }) + '\n'
    );
    fs.writeFileSync(
      path.join(srcProjects, 'proj-cool-app.json'),
      JSON.stringify({
        id: 'proj-cool-app',
        name: 'cool-app',
        projectResources: {
          resources: [{ gitFolder: { folderUri: 'file:///C:/Users/alice/old-folder/cool-app' } }]
        }
      }, null, 2)
    );

    exportToSyncDir({
      desktopDir: srcDesktop,
      cliDir: '',
      geminiConfigDir: srcConfig,
      projectsDir: srcProjects,
      syncDir,
      targets: { desktop: true, cli: false, config: true }
    }, { homeDir: 'C:/Users/alice' });

    const destDesktop = path.join(testDir, 'case2-dest-desk');
    const destConfig = path.join(testDir, 'case2-dest-cfg');
    const destProjects = path.join(destConfig, 'projects');
    await importFromSyncDir({
      desktopDir: destDesktop,
      cliDir: '',
      geminiConfigDir: destConfig,
      projectsDir: destProjects,
      syncDir,
      targets: { desktop: true, cli: false, config: true }
    }, {
      targetHome: 'C:/Users/bob',
      autoYes: true,
      searchRoots: [searchRoot]
    });

    const destIdx = exportSummaries(path.join(destDesktop, 'conversation_summaries.db'), 'C:/Users/bob');
    const importedConv = destIdx.conversations.find(c => c.conversation_id === 'conv-loc-1');
    const normRelocated = relocatedRepo.replace(/\\/g, '/').toLowerCase();
    assert(importedConv.workspace_uris.toLowerCase().includes(normRelocated), `Expected remapped workspace_uris containing ${normRelocated}, got ${importedConv.workspace_uris}`);
    const importedTranscript = fs.readFileSync(
      path.join(destDesktop, 'brain', 'conv-loc-1', '.system_generated', 'logs', 'transcript.jsonl'),
      'utf8'
    );
    assert(importedTranscript.toLowerCase().includes(normRelocated.replace(/\//g, '\\\\')) || importedTranscript.toLowerCase().includes(normRelocated));
  }

  // 3. Guard ledger sync + CLI additionalDirs safety + CLI metadata cache sync on push/pull
  {
    const syncDir = path.join(testDir, 'case3-sync');
    const pcADesk = path.join(testDir, 'case3-a-desk');
    const pcACli = path.join(testDir, 'case3-a-cli');
    const guardA = path.join(testDir, 'case3-a-guard.json');

    fs.mkdirSync(path.join(pcADesk, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(pcACli, 'conversations'), { recursive: true });

    seedConversation(path.join(pcADesk, 'conversation_summaries.db'), [
      makeConv('desk-guarded', 'Guarded Title', '2026-11-16T12:00:00Z', 7, { source: '', project_id: 'proj-real' })
    ], 'C:/Users/pcA');
    seedConversation(path.join(pcACli, 'conversation_summaries.db'), [
      makeConv('cli-own', 'CLI Own', '2026-11-16T12:00:00Z', 4, { project_id: 'default-cli-project', app_data_dir: 'antigravity-cli' }),
      makeConv('desk-guarded', 'Guarded Title', '2026-11-16T12:00:00Z', 7, { project_id: 'proj-real', app_data_dir: 'antigravity-cli' })
    ], 'C:/Users/pcA', true);
    fs.writeFileSync(path.join(pcACli, 'conversations', 'cli-own.db'), 'CLI_DB');
    // Simulate stale poisoned Desktop DB inside CLI conversations dir in sync source
    fs.writeFileSync(path.join(pcACli, 'conversations', 'desk-guarded.db'), 'POISON_DB');

    recordMetadataGuard({
      desktopDbPath: path.join(pcADesk, 'conversation_summaries.db'),
      cliDbPath: path.join(pcACli, 'conversation_summaries.db'),
      guardPath: guardA
    });

    // Simulate Desktop rescan corrupting desk-guarded right before push
    seedConversation(path.join(pcADesk, 'conversation_summaries.db'), [
      makeConv('desk-guarded', '', '2026-11-16T12:05:00Z', 8, { source: 'CORTEX_TRAJECTORY_SOURCE_CLI', project_id: 'default-cli-project' })
    ], 'C:/Users/pcA');

    exportToSyncDir({
      desktopDir: pcADesk,
      cliDir: pcACli,
      geminiConfigDir: '',
      projectsDir: '',
      syncDir,
      targets: { desktop: true, cli: true, config: false }
    }, { homeDir: 'C:/Users/pcA', guardPath: guardA });

    const pcBDesk = path.join(testDir, 'case3-b-desk');
    const pcBCli = path.join(testDir, 'case3-b-cli');
    const guardB = path.join(testDir, 'case3-b-guard.json');
    fs.mkdirSync(path.join(pcBCli, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(pcBCli, 'cache', 'conversation_metadata.json'),
      JSON.stringify({ conversations: { 'cli-own': { summary: { Title: '', AppDataDir: 'antigravity', ProjectID: 'default-cli-project', NumSteps: 0 } } } })
    );

    await importFromSyncDir({
      desktopDir: pcBDesk,
      cliDir: pcBCli,
      geminiConfigDir: '',
      projectsDir: '',
      syncDir,
      targets: { desktop: true, cli: true, config: false }
    }, { targetHome: 'C:/Users/pcB', guardPath: guardB });

    const bDeskRow = exportSummaries(path.join(pcBDesk, 'conversation_summaries.db')).conversations.find(c => c.conversation_id === 'desk-guarded');
    assert.strictEqual(bDeskRow.title, 'Guarded Title', 'Guard must heal title before export');
    assert.strictEqual(bDeskRow.source, '', 'Guard must heal source before export');
    assert.strictEqual(bDeskRow.project_id, 'proj-real', 'Guard must heal project_id before export');

    assert(fs.existsSync(path.join(pcBCli, 'conversations', 'cli-own.db')), 'CLI-native DB must be pulled');
    assert(!fs.existsSync(path.join(pcBCli, 'conversations', 'desk-guarded.db')), 'Desktop-project DB must NOT be copied into cli/conversations');

    const bCliRow = exportSummaries(path.join(pcBCli, 'conversation_summaries.db')).conversations.find(c => c.conversation_id === 'desk-guarded');
    assert.strictEqual(bCliRow.app_data_dir, 'antigravity', 'Desktop-project row in CLI must keep app_data_dir="antigravity"');

    const bCliCache = JSON.parse(fs.readFileSync(path.join(pcBCli, 'cache', 'conversation_metadata.json'), 'utf8'));
    assert.strictEqual(bCliCache.conversations['cli-own'].summary.Title, 'CLI Own', 'CLI metadata cache must sync on pull');

    const loadedGuardB = loadMetadataGuard(guardB);
    assert.strictEqual(loadedGuardB.conversations['desk-guarded'].title, 'Guarded Title', 'Guard ledger must sync to PC B');
  }

  // 4. Git conflict recovery & non-fast-forward push retry + ahead-only push
  {
    const bareRemote = path.join(testDir, 'case4-remote.git');
    const repoA = path.join(testDir, 'case4-repoA');
    const repoB = path.join(testDir, 'case4-repoB');
    fs.mkdirSync(bareRemote, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bareRemote, stdio: 'ignore' });

    initGitRepo(repoA, bareRemote);
    fs.writeFileSync(path.join(repoA, 'index.json'), '{"v":1}\n');
    gitCommitAndPush(repoA, 'initial');

    initGitRepo(repoB, bareRemote);
    gitPull(repoB, { recoverConflictByReset: true });

    // Repo A pushes remote commit
    fs.writeFileSync(path.join(repoA, 'index.json'), '{"v":2,"a":true}\n');
    gitCommitAndPush(repoA, 'from A');

    // Repo B modifies same file independently & commits without pulling (divergent conflict!)
    fs.writeFileSync(path.join(repoB, 'index.json'), '{"v":2,"b":true}\n');
    const retryRes = gitCommitAndPush(repoB, 'from B', {
      onPushConflict: () => {
        const remoteJson = JSON.parse(fs.readFileSync(path.join(repoB, 'index.json'), 'utf8'));
        fs.writeFileSync(path.join(repoB, 'index.json'), JSON.stringify({ ...remoteJson, b: true }) + '\n');
      }
    });
    assert.strictEqual(retryRes.pushed, true, 'Non-fast-forward conflict must auto-recover and push cleanly');
    assert.strictEqual(retryRes.retried, true);

    // Pull in Repo A and verify merged state without conflict markers
    gitPull(repoA, { recoverConflictByReset: true });
    const finalJson = JSON.parse(fs.readFileSync(path.join(repoA, 'index.json'), 'utf8'));
    assert.strictEqual(finalJson.a, true);
    assert.strictEqual(finalJson.b, true);

    // Test ahead-only commit push when working tree has 0 new changes
    fs.writeFileSync(path.join(repoA, 'offline.txt'), 'offline commit\n');
    execFileSync('git', ['add', '-A'], { cwd: repoA, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'offline commit'], { cwd: repoA, stdio: 'ignore' });
    const aheadPush = gitCommitAndPush(repoA, 'noop');
    assert.strictEqual(aheadPush.committed, false);
    assert.strictEqual(aheadPush.pushed, true, 'Ahead unpushed local commits must push even without new working tree changes');
  }

  console.log('All push/pull multi-PC scenario unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
