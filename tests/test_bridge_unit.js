import { getBridgeDiff, bridgeLocalClients } from '../src/bridge.js';
import { exportSummaries, importAndMergeSummaries } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const testDir = path.join(process.cwd(), 'tests', 'test_bridge_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const desktopDir = path.join(testDir, 'antigravity');
const cliDir = path.join(testDir, 'antigravity-cli');
const backupDir = path.join(testDir, 'backups');

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

  const dryRes = bridgeLocalClients({ desktopDir, cliDir, backupDir }, { direction: 'both', dryRun: true });
  assert.strictEqual(dryRes.dryRun, true);
  assert.strictEqual(dryRes.snapshotPath, null);

  // 2. Execute bidirectional bridge
  const res = bridgeLocalClients({ desktopDir, cliDir, backupDir }, { direction: 'both' });
  assert.strictEqual(res.dryRun, false);
  assert(fs.existsSync(res.snapshotPath), 'bridge must create backup snapshot');
  assert.strictEqual(res.cliToDesktop.mergeStats.added, 1);
  assert.strictEqual(res.cliToDesktop.mergeStats.updated, 1);
  assert.strictEqual(res.desktopToCli.mergeStats.added, 1);

  // Verify Desktop has cli-1 with Desktop conventions
  const deskAfter = exportSummaries(path.join(desktopDir, 'conversation_summaries.db'));
  const deskCliRow = deskAfter.conversations.find(c => c.conversation_id === 'cli-1');
  assert.strictEqual(deskCliRow.app_data_dir, 'antigravity');
  assert.strictEqual(deskCliRow.source, 'CORTEX_TRAJECTORY_SOURCE_CLI');
  assert(fs.existsSync(path.join(desktopDir, 'conversations', 'cli-1.db')));
  assert(fs.existsSync(path.join(desktopDir, 'brain', 'cli-1', 'plan.md')));

  // Verify CLI has desk-1 with CLI conventions & preserved shared-1 identity
  const cliAfter = exportSummaries(path.join(cliDir, 'conversation_summaries.db'));
  const cliDeskRow = cliAfter.conversations.find(c => c.conversation_id === 'desk-1');
  const cliSharedRow = cliAfter.conversations.find(c => c.conversation_id === 'shared-1');
  assert.strictEqual(cliDeskRow.app_data_dir, 'antigravity');
  assert.strictEqual(cliDeskRow.source, '');
  assert.strictEqual(cliSharedRow.app_data_dir, 'antigravity-cli');
  assert(fs.existsSync(path.join(cliDir, 'conversations', 'desk-1.db')));
  assert(fs.existsSync(path.join(cliDir, 'brain', 'desk-1', 'notes.md')));

  // 3. Re-running bridge should be idempotent (zero diff)
  const diffAfter = getBridgeDiff(desktopDir, cliDir);
  assert.strictEqual(diffAfter.desktopOnly.length, 0);
  assert.strictEqual(diffAfter.cliOnly.length, 0);
  assert.strictEqual(diffAfter.newerInCli.length, 0);
  assert.strictEqual(diffAfter.newerInDesktop.length, 0);

  console.log('All bridge.js unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
