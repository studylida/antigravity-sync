import { getBridgeDiff, bridgeLocalClients } from '../src/bridge.js';
import { exportSummaries, importAndMergeSummaries } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const testDir = path.join(process.cwd(), 'tests', 'test_bridge_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const desktopDir = path.join(testDir, 'antigravity');
const cliDir = path.join(testDir, 'antigravity-cli');
const backupDir = path.join(testDir, 'backups');
const guardPath = path.join(testDir, 'metadata_guard.json');

function makeRow(id, title, appDataDir, source = '', stepCount = 5, time = '2026-11-13T05:00:00Z') {
  return {
    conversation_id: id,
    title,
    preview: 'preview',
    step_count: stepCount,
    last_modified_time: time,
    workspace_uris: '["file:///C:/git/my-app"]',
    status: 'CASCADE_RUN_STATUS_IDLE',
    source,
    project_id: appDataDir === 'antigravity-cli' ? 'default-cli-project' : 'proj-uuid',
    agent_name: '',
    parent_conversation_id: '',
    nesting_depth: 0,
    battle_id: '',
    winning_conversation_id: '',
    not_fully_idle: 0,
    killed: 0,
    last_user_input_time: time,
    last_user_input_step_index: stepCount - 1,
    app_data_dir: appDataDir,
    raw_summary: null,
    group_id: ''
  };
}

try {
  fs.mkdirSync(path.join(desktopDir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(desktopDir, 'brain', 'desk-1'), { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'brain', 'cli-1'), { recursive: true });

  // Seed Desktop with desk-1 and an older shared-1
  importAndMergeSummaries(path.join(desktopDir, 'conversation_summaries.db'), {
    version: 2,
    sourceHomeDir: 'C:/Users/dam',
    conversations: [
      makeRow('desk-1', 'Desktop Native', 'antigravity', '', 10, '2026-11-13T05:00:00Z'),
      makeRow('shared-1', 'Shared Old', 'antigravity', 'CORTEX_TRAJECTORY_SOURCE_CLI', 4, '2026-11-13T04:00:00Z')
    ]
  });
  fs.writeFileSync(path.join(desktopDir, 'conversations', 'desk-1.db'), 'desk-db');
  fs.writeFileSync(path.join(desktopDir, 'brain', 'desk-1', 'notes.md'), 'desktop artifact');

  // Seed CLI with cli-1 and a newer shared-1
  importAndMergeSummaries(path.join(cliDir, 'conversation_summaries.db'), {
    version: 2,
    sourceHomeDir: 'C:/Users/dam',
    conversations: [
      makeRow('cli-1', 'CLI Native', 'antigravity-cli', '', 12, '2026-11-13T06:00:00Z'),
      makeRow('shared-1', 'Shared Newer in CLI', 'antigravity-cli', '', 20, '2026-11-13T07:00:00Z')
    ],
    parents: [{ conversation_id: 'cli-1', parent_id: 'root-0' }]
  }, { includeParentsTable: true });
  fs.writeFileSync(path.join(cliDir, 'conversations', 'cli-1.db'), 'cli-db');
  fs.writeFileSync(path.join(cliDir, 'brain', 'cli-1', 'plan.md'), 'cli artifact');

  // 1. Diff / dry-run check
  const diff = getBridgeDiff(desktopDir, cliDir);
  assert.strictEqual(diff.desktopOnly.length, 1);
  assert.strictEqual(diff.cliOnly.length, 1);
  assert.strictEqual(diff.newerInCli.length, 1);
  assert.strictEqual(diff.newerInDesktop.length, 0);

  const dryRes = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath }, { direction: 'both', dryRun: true });
  assert.strictEqual(dryRes.dryRun, true);
  assert.strictEqual(dryRes.snapshotPath, null);

  // 2. Execute bidirectional bridge
  const res = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath }, { direction: 'both' });
  assert.strictEqual(res.dryRun, false);
  assert(fs.existsSync(res.snapshotPath), 'bridge must create backup snapshot');
  assert.strictEqual(res.cliToDesktop.mergeStats.added, 1);
  assert.strictEqual(res.cliToDesktop.mergeStats.updated, 1);
  assert.strictEqual(res.desktopToCli.mergeStats.added, 1);

  // Verify Desktop has cli-1 with Desktop visibility (empty source + mapped project_id)
  const deskAfter = exportSummaries(path.join(desktopDir, 'conversation_summaries.db'));
  const deskCliRow = deskAfter.conversations.find(c => c.conversation_id === 'cli-1');
  assert.strictEqual(deskCliRow.app_data_dir, 'antigravity');
  assert.strictEqual(deskCliRow.source, '');
  assert.strictEqual(deskCliRow.project_id, 'outside-of-project');
  assert(fs.existsSync(path.join(desktopDir, 'conversations', 'cli-1.db')));
  assert(fs.existsSync(path.join(desktopDir, 'brain', 'cli-1', 'plan.md')));

  // Verify CLI has desk-1 with CLI conventions & preserved shared-1 identity
  const cliAfter = exportSummaries(path.join(cliDir, 'conversation_summaries.db'));
  const cliDeskRow = cliAfter.conversations.find(c => c.conversation_id === 'desk-1');
  const cliSharedRow = cliAfter.conversations.find(c => c.conversation_id === 'shared-1');
  assert.strictEqual(cliDeskRow.app_data_dir, 'antigravity');
  assert.strictEqual(cliDeskRow.source, '');
  assert.strictEqual(cliSharedRow.app_data_dir, 'antigravity-cli');
  // Desktop-native .db must NOT be copied into cli/conversations (otherwise Desktop additionalDirs scanner overwrites source=CLI and clears titles)
  assert(!fs.existsSync(path.join(cliDir, 'conversations', 'desk-1.db')));
  assert(fs.existsSync(path.join(cliDir, 'brain', 'desk-1', 'notes.md')));

  // Verify updating an existing CLI .db when Desktop copy is newer works
  const oldTime = new Date(Date.now() - 10000);
  fs.writeFileSync(path.join(cliDir, 'conversations', 'shared-1.db'), 'old-cli-db');
  fs.utimesSync(path.join(cliDir, 'conversations', 'shared-1.db'), oldTime, oldTime);
  // Seed a stale poisoned Desktop-native .db duplicate in cliDir/conversations to verify automatic cleanup
  fs.writeFileSync(path.join(cliDir, 'conversations', 'desk-1.db'), 'poisoned-copy');
  fs.utimesSync(path.join(cliDir, 'conversations', 'desk-1.db'), oldTime, oldTime);
  fs.writeFileSync(path.join(desktopDir, 'conversations', 'shared-1.db'), 'updated-shared-from-desktop');
  const sharedDeskMod = exportSummaries(path.join(desktopDir, 'conversation_summaries.db'));
  const sharedDeskItem = sharedDeskMod.conversations.find(c => c.conversation_id === 'shared-1');
  sharedDeskItem.last_modified_time = '2026-11-13T08:00:00Z';
  sharedDeskItem.step_count = 25;
  importAndMergeSummaries(path.join(desktopDir, 'conversation_summaries.db'), sharedDeskMod);
  const resSharedUpdate = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath }, { direction: 'desktop-to-cli' });
  assert.strictEqual(resSharedUpdate.cleanedCliDbCount, 1);
  assert(!fs.existsSync(path.join(cliDir, 'conversations', 'desk-1.db')), 'poisoned Desktop .db must be removed from cliDir');
  assert.strictEqual(resSharedUpdate.desktopToCli.copiedDbCount, 1);
  assert.strictEqual(fs.readFileSync(path.join(cliDir, 'conversations', 'shared-1.db'), 'utf8'), 'updated-shared-from-desktop');

  // Verify newer empty-title Desktop row never wipes existing CLI title, and both-way bridge heals Desktop
  const cliMod = exportSummaries(path.join(cliDir, 'conversation_summaries.db'));
  const cliDeskEntry = cliMod.conversations.find(c => c.conversation_id === 'desk-1');
  cliDeskEntry.title = 'Protected CLI Title';
  cliDeskEntry.last_modified_time = '2026-11-13T08:30:00Z';
  importAndMergeSummaries(path.join(cliDir, 'conversation_summaries.db'), cliMod, { includeParentsTable: true });
  const deskRawConn = new DatabaseSync(path.join(desktopDir, 'conversation_summaries.db'));
  deskRawConn.prepare("UPDATE conversation_summaries SET title = '', last_modified_time = '2026-11-13T09:00:00Z' WHERE conversation_id = 'desk-1'").run();
  deskRawConn.close();
  const noGuardYet = path.join(testDir, 'guard-empty-protect.json');
  bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath: noGuardYet }, { direction: 'desktop-to-cli' });
  const cliFinal = exportSummaries(path.join(cliDir, 'conversation_summaries.db'));
  assert.strictEqual(cliFinal.conversations.find(c => c.conversation_id === 'desk-1').title, 'Protected CLI Title');
  bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath: noGuardYet }, { direction: 'both' });
  const deskHealed = exportSummaries(path.join(desktopDir, 'conversation_summaries.db'));
  assert.strictEqual(deskHealed.conversations.find(c => c.conversation_id === 'desk-1').title, 'Protected CLI Title');

  // Verify missing Desktop .db for an indexed CLI conversation is repaired even when diff has 0 summary changes
  fs.rmSync(path.join(desktopDir, 'conversations', 'cli-1.db'), { force: true });
  const healMissingDbRes = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath }, { direction: 'cli-to-desktop' });
  assert.strictEqual(healMissingDbRes.cliToDesktop.copiedDbCount, 1);
  assert(fs.existsSync(path.join(desktopDir, 'conversations', 'cli-1.db')));

  // Verify CLI workspace_uris maps to matching Desktop project UUID from projectsDir
  const mockProjectsDir = path.join(testDir, 'projects');
  fs.mkdirSync(mockProjectsDir, { recursive: true });
  fs.writeFileSync(
    path.join(mockProjectsDir, 'my-proj-uuid.json'),
    JSON.stringify({
      id: 'my-proj-uuid',
      projectResources: { resources: [{ gitFolder: { folderUri: 'file:///C:/git/my-app' } }] }
    })
  );
  bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath, projectsDir: mockProjectsDir }, { direction: 'cli-to-desktop' });
  const deskMapped = exportSummaries(path.join(desktopDir, 'conversation_summaries.db'));
  assert.strictEqual(deskMapped.conversations.find(c => c.conversation_id === 'cli-1').project_id, 'my-proj-uuid');
  assert.strictEqual(deskMapped.conversations.find(c => c.conversation_id === 'cli-1').source, '');

  // Round-trip: User adds new turns to bridged cli-1 in Desktop, then runs bridge -> CLI must keep default-cli-project and cli-1.db!
  const deskModRound = new DatabaseSync(path.join(desktopDir, 'conversation_summaries.db'));
  deskModRound.prepare("UPDATE conversation_summaries SET step_count = 99, last_modified_time = '2026-11-13T10:00:00Z' WHERE conversation_id = 'cli-1'").run();
  deskModRound.close();
  bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath, projectsDir: mockProjectsDir }, { direction: 'both' });
  const cliRound = exportSummaries(path.join(cliDir, 'conversation_summaries.db'));
  assert.strictEqual(cliRound.conversations.find(c => c.conversation_id === 'cli-1').project_id, 'default-cli-project');
  assert.strictEqual(cliRound.conversations.find(c => c.conversation_id === 'cli-1').step_count, 99);
  assert(fs.existsSync(path.join(cliDir, 'conversations', 'cli-1.db')), 'CLI-native cli-1.db must survive round-trip');

  // Imported Desktop conversation edited in CLI (newer in CLI):
  // 1) --direction=desktop-to-cli must NOT delete newer CLI-modified desk-1.db
  // 2) --direction=both must copy newer desk-1.db to Desktop, remove CLI duplicate, and reset CLI app_data_dir='antigravity'
  const futureTime = new Date(Date.now() + 20000);
  fs.writeFileSync(path.join(cliDir, 'conversations', 'desk-1.db'), 'cli-continued-turns');
  fs.utimesSync(path.join(cliDir, 'conversations', 'desk-1.db'), futureTime, futureTime);
  const cliImportMod = new DatabaseSync(path.join(cliDir, 'conversation_summaries.db'));
  cliImportMod.prepare("UPDATE conversation_summaries SET app_data_dir = 'antigravity-cli', step_count = 88, last_modified_time = '2026-11-13T11:00:00Z' WHERE conversation_id = 'desk-1'").run();
  cliImportMod.close();

  const oneWayRes = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath, projectsDir: mockProjectsDir }, { direction: 'desktop-to-cli' });
  assert.strictEqual(oneWayRes.cleanedCliDbCount, 0);
  assert(fs.existsSync(path.join(cliDir, 'conversations', 'desk-1.db')), 'newer CLI-edited Desktop DB must not be deleted without cli-to-desktop');

  const bothRes = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath, projectsDir: mockProjectsDir }, { direction: 'both' });
  assert.strictEqual(bothRes.cleanedCliDbCount, 1);
  assert(!fs.existsSync(path.join(cliDir, 'conversations', 'desk-1.db')));
  assert.strictEqual(fs.readFileSync(path.join(desktopDir, 'conversations', 'desk-1.db'), 'utf8'), 'cli-continued-turns');
  const cliAfterClean = exportSummaries(path.join(cliDir, 'conversation_summaries.db'));
  assert.strictEqual(cliAfterClean.conversations.find(c => c.conversation_id === 'desk-1').app_data_dir, 'antigravity');

  // Verify identical desktopDir and cliDir are rejected
  assert.throws(
    () => bridgeLocalClients({ desktopDir, cliDir: desktopDir, backupDir }, { direction: 'both' }),
    /경로가 동일/
  );

  // 3. Re-running bridge should be idempotent (zero diff) and NOT copy unrelated DB/brain files
  fs.writeFileSync(path.join(cliDir, 'conversations', 'unindexed-only.db'), 'unindexed-cli');
  const diffAfter = getBridgeDiff(desktopDir, cliDir);
  assert.strictEqual(diffAfter.desktopOnly.length, 0);
  assert.strictEqual(diffAfter.cliOnly.length, 0);
  assert.strictEqual(diffAfter.newerInCli.length, 0);
  assert.strictEqual(diffAfter.newerInDesktop.length, 0);

  const zeroRes = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath }, { direction: 'both' });
  assert.strictEqual(zeroRes.cliToDesktop.copiedDbCount, 0);
  assert.strictEqual(zeroRes.cliToDesktop.copiedBrainCount, 0);
  assert.strictEqual(zeroRes.desktopToCli.copiedDbCount, 0);
  assert.strictEqual(zeroRes.desktopToCli.copiedBrainCount, 0);
  assert(!fs.existsSync(path.join(desktopDir, 'conversations', 'unindexed-only.db')));

  console.log('All bridge.js unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
