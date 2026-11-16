import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { importAndMergeSummaries, exportSummaries } from '../src/db.js';
import { bridgeLocalClients } from '../src/bridge.js';
import { healClientDbsFromGuard, recordMetadataGuard, loadMetadataGuard } from '../src/metadata_guard.js';
import { createWatchController, computeClientFingerprint } from '../src/watch.js';
import { parseOptions } from '../bin/agy-sync.js';

const testDir = path.join(process.cwd(), 'tests', 'test_guard_watch_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

try {
  // 1. Metadata Guard test: record valid Desktop + CLI state, simulate scanAndRefresh corruption on BOTH DBs, then heal
  const desktopDir = path.join(testDir, 'desktop');
  const cliDir = path.join(testDir, 'cli');
  const backupDir = path.join(testDir, 'backups');
  const guardPath = path.join(testDir, 'metadata_guard.json');
  const desktopDbPath = path.join(desktopDir, 'conversation_summaries.db');
  const cliDbPath = path.join(cliDir, 'conversation_summaries.db');

  fs.mkdirSync(path.join(desktopDir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'conversations'), { recursive: true });

  const sampleRawWithField17 = Buffer.concat([
    Buffer.from([0x0a, 0x05]),
    Buffer.from('hello', 'utf8'),
    Buffer.from([0x8a, 0x01, 22, 0x92, 0x01, 19]),
    Buffer.from('proj-workspace-uuid', 'utf8')
  ]);

  importAndMergeSummaries(desktopDbPath, {
    version: 2,
    conversations: [
      {
        conversation_id: 'd-conv-1',
        title: 'Desktop Important Title',
        workspace_uris: '["file:///C:/repo"]',
        project_id: 'proj-workspace-uuid',
        source: '',
        app_data_dir: 'antigravity',
        last_modified_time: '2026-11-16T01:00:00Z',
        last_user_input_time: '2026-11-16T01:00:00Z',
        raw_summary: sampleRawWithField17.toString('base64')
      }
    ]
  });

  importAndMergeSummaries(cliDbPath, {
    version: 2,
    conversations: [
      {
        conversation_id: 'c-conv-1',
        title: 'CLI Original Title',
        workspace_uris: '["file:///C:/Users/user"]',
        project_id: 'default-cli-project',
        source: '',
        app_data_dir: 'antigravity-cli',
        last_modified_time: '2026-11-16T01:05:00Z',
        last_user_input_time: '2026-11-16T01:05:00Z'
      }
    ]
  }, { includeParentsTable: true });

  fs.writeFileSync(path.join(desktopDir, 'conversations', 'd-conv-1.db'), 'desk');
  fs.writeFileSync(path.join(cliDir, 'conversations', 'c-conv-1.db'), 'cli');
  fs.writeFileSync(path.join(desktopDir, 'agyhub_summaries_proto.pb'), Buffer.alloc(0));

  // Initial bridge records metadata guard ledger
  bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath }, { direction: 'both' });
  const guardAfterFirst = loadMetadataGuard(guardPath);
  assert.strictEqual(guardAfterFirst.conversations['d-conv-1'].title, 'Desktop Important Title');
  assert.strictEqual(guardAfterFirst.conversations['d-conv-1'].desktopSource, '');
  assert.strictEqual(guardAfterFirst.conversations['d-conv-1'].desktopProjectId, 'proj-workspace-uuid');
  assert.strictEqual(guardAfterFirst.conversations['c-conv-1'].title, 'CLI Original Title');

  // Simulate worst-case Desktop scanAndRefresh corruption on BOTH Desktop and CLI DBs simultaneously
  const dConn = new DatabaseSync(desktopDbPath);
  dConn.prepare("UPDATE conversation_summaries SET title = '', source = 'CORTEX_TRAJECTORY_SOURCE_CLI', project_id = 'default-cli-project', last_modified_time = '2026-11-16T02:00:00Z' WHERE conversation_id = 'd-conv-1'").run();
  dConn.close();
  const cConn = new DatabaseSync(cliDbPath);
  cConn.prepare("UPDATE conversation_summaries SET title = '' WHERE conversation_id = 'd-conv-1'").run();
  cConn.close();

  // Next bridge auto-heals BEFORE diffing & without needing manual snapshot recovery
  const healedBridge = bridgeLocalClients({ desktopDir, cliDir, backupDir, guardPath }, { direction: 'both' });
  assert.strictEqual(healedBridge.guardHeal.desktopHealed, 1);
  assert.strictEqual(healedBridge.guardHeal.cliHealed, 1);

  const dAfterHeal = exportSummaries(desktopDbPath);
  const dRow = dAfterHeal.conversations.find(c => c.conversation_id === 'd-conv-1');
  assert.strictEqual(dRow.title, 'Desktop Important Title');
  assert.strictEqual(dRow.source, '');
  assert.strictEqual(dRow.project_id, 'proj-workspace-uuid');
  assert(Buffer.from(dRow.raw_summary, 'base64').includes(Buffer.from('Desktop Important Title', 'utf8')));
  assert(fs.existsSync(path.join(desktopDir, 'annotations', 'd-conv-1.pbtxt')));

  const cAfterHeal = exportSummaries(cliDbPath);
  assert.strictEqual(cAfterHeal.conversations.find(c => c.conversation_id === 'd-conv-1').title, 'Desktop Important Title');

  // Standalone recordMetadataGuard preserves non-empty title even if DB later has empty title
  const directGuard = healClientDbsFromGuard({ desktopDir, cliDir, desktopDbPath, cliDbPath, guardPath });
  assert.strictEqual(directGuard.desktopHealed, 0);
  recordMetadataGuard({ desktopDbPath, cliDbPath, guardPath });

  // 2. Watch controller state machine tests
  let fakeNow = 1000;
  let fakeRunning = { desktop: false, cli: false };
  let bridgeCalls = 0;
  let fakeFp = computeClientFingerprint(desktopDir, cliDir);

  const controller = createWatchController({
    cfg: { desktopDir, cliDir, backupDir, guardPath },
    settleMs: 1500,
    deps: {
      getRunningProcesses: () => fakeRunning,
      computeClientFingerprint: () => fakeFp,
      now: () => fakeNow,
      bridgeLocalClients: () => {
        bridgeCalls++;
        return {
          cleanedCliDbCount: 0,
          cliToDesktop: { mergeStats: { added: 0, updated: 0 } },
          desktopToCli: { mergeStats: { added: 0, updated: 0 } }
        };
      }
    }
  });

  // Initial idle tick performs one guarded sync check
  assert.strictEqual(controller.step().action, 'bridged');
  assert.strictEqual(bridgeCalls, 1);
  assert.strictEqual(controller.step().action, 'idle');

  // App opens -> active, never bridges while running
  fakeRunning = { desktop: true, cli: false };
  fakeFp = fakeFp + '|changed-while-open';
  assert.strictEqual(controller.step().action, 'active');
  assert.strictEqual(bridgeCalls, 1);

  // App closes -> settles for settleMs before bridging
  fakeRunning = { desktop: false, cli: false };
  assert.strictEqual(controller.step().action, 'settling');
  fakeNow += 1000;
  assert.strictEqual(controller.step().action, 'settling');
  fakeNow += 1000;
  assert.strictEqual(controller.step().action, 'bridged');
  assert.strictEqual(bridgeCalls, 2);

  // App opens and closes WITHOUT changing DB -> unchanged, skips bridge
  fakeRunning = { desktop: false, cli: true };
  assert.strictEqual(controller.step().action, 'active');
  fakeRunning = { desktop: false, cli: false };
  assert.strictEqual(controller.step().action, 'settling');
  fakeNow += 2000;
  assert.strictEqual(controller.step().action, 'unchanged');
  assert.strictEqual(bridgeCalls, 2);

  // 3. CLI watch flags parsing
  const watchParsed = parseOptions(['--daemon', '--interval=5000']);
  assert.strictEqual(watchParsed.options.daemon, true);
  assert.strictEqual(watchParsed.options.interval, 5000);
  assert.throws(() => parseOptions(['--interval=100']), /500 이상의 ms/);

  console.log('All metadata_guard.js and watch.js unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
