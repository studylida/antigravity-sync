import { exportSummaries, importAndMergeSummaries } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const tempSourceDbPath = path.join(process.cwd(), 'tests', 'temp_source_summaries.db');
const tempDbPath = path.join(process.cwd(), 'tests', 'temp_test_summaries.db');
const tempCliDbPath = path.join(process.cwd(), 'tests', 'temp_test_cli_summaries.db');
for (const p of [tempSourceDbPath, tempDbPath, tempCliDbPath]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

try {
  importAndMergeSummaries(tempSourceDbPath, {
    version: 2,
    sourceHomeDir: 'C:/Users/dam',
    conversations: [
      {
        conversation_id: 'desk-seed-1',
        title: 'Seed Conv 1',
        preview: 'preview 1',
        step_count: 10,
        last_modified_time: '2026-11-13T05:00:00Z',
        workspace_uris: '["file:///C:/Users/dam/repo"]',
        status: 'CASCADE_RUN_STATUS_IDLE',
        source: '',
        project_id: 'proj-1',
        agent_name: '',
        parent_conversation_id: '',
        nesting_depth: 0,
        battle_id: '',
        winning_conversation_id: '',
        not_fully_idle: 0,
        killed: 0,
        last_user_input_time: '2026-11-13T05:00:00Z',
        last_user_input_step_index: 9,
        app_data_dir: 'antigravity',
        raw_summary: null,
        group_id: ''
      },
      {
        conversation_id: 'desk-seed-2',
        title: 'Seed Conv 2',
        preview: 'preview 2',
        step_count: 6,
        last_modified_time: '2026-11-13T04:00:00Z',
        workspace_uris: '["file:///C:/Users/dam/repo2"]',
        status: 'CASCADE_RUN_STATUS_IDLE',
        source: '',
        project_id: 'proj-2',
        agent_name: '',
        parent_conversation_id: '',
        nesting_depth: 0,
        battle_id: '',
        winning_conversation_id: '',
        not_fully_idle: 0,
        killed: 0,
        last_user_input_time: '2026-11-13T04:00:00Z',
        last_user_input_step_index: 5,
        app_data_dir: 'antigravity',
        raw_summary: null,
        group_id: ''
      }
    ]
  }, { targetHome: 'C:/Users/dam' });

  const exported = exportSummaries(tempSourceDbPath, 'C:/Users/dam');
  console.log('Exported conversations count:', exported.conversations.length);
  assert(exported.conversations.length >= 2);
  assert.strictEqual(exported.version, 2);

  // Test merge into fresh DB
  const result1 = importAndMergeSummaries(tempDbPath, exported);
  console.log('First merge result (fresh):', result1);
  assert.strictEqual(result1.added, exported.conversations.length);
  assert.strictEqual(result1.updated, 0);
  assert.strictEqual(result1.skipped, 0);

  // Test merge again (should be skipped because same timestamps)
  const result2 = importAndMergeSummaries(tempDbPath, exported);
  console.log('Second merge result (identical):', result2);
  assert.strictEqual(result2.added, 0);
  assert.strictEqual(result2.updated, 0);
  assert.strictEqual(result2.skipped, exported.conversations.length);

  // Test updating a conversation with newer timestamp
  const modified = JSON.parse(JSON.stringify(exported));
  modified.conversations[0].title = 'Updated Title by Remote';
  modified.conversations[0].last_modified_time = new Date(Date.now() + 10000).toISOString();
  const result3 = importAndMergeSummaries(tempDbPath, modified);
  console.log('Third merge result (with 1 update):', result3);
  assert.strictEqual(result3.added, 0);
  assert.strictEqual(result3.updated, 1);
  assert.strictEqual(result3.skipped, exported.conversations.length - 1);

  // Verify updated title in tempDb
  const reExported = exportSummaries(tempDbPath);
  const found = reExported.conversations.find(c => c.conversation_id === modified.conversations[0].conversation_id);
  assert.strictEqual(found.title, 'Updated Title by Remote');

  // Test CLI conversation_parents export & merge
  const cliIndex = {
    version: 2,
    sourceHomeDir: 'C:/Users/work',
    conversations: [
      {
        conversation_id: 'cli-child-1',
        title: 'Forked CLI Session',
        preview: 'test',
        step_count: 5,
        last_modified_time: new Date().toISOString(),
        workspace_uris: '["file:///{{USER_HOME}}/proj"]',
        status: 'CASCADE_RUN_STATUS_IDLE',
        source: '',
        project_id: 'default-cli-project',
        agent_name: '',
        parent_conversation_id: 'cli-parent-1',
        nesting_depth: 1,
        battle_id: '',
        winning_conversation_id: '',
        not_fully_idle: 0,
        killed: 0,
        last_user_input_time: new Date().toISOString(),
        last_user_input_step_index: 3,
        app_data_dir: 'antigravity-cli',
        raw_summary: null,
        group_id: ''
      }
    ],
    parents: [{ conversation_id: 'cli-child-1', parent_id: 'cli-parent-1' }]
  };

  const cliMergeRes = importAndMergeSummaries(tempCliDbPath, cliIndex, { includeParentsTable: true });
  assert.strictEqual(cliMergeRes.added, 1);
  assert.strictEqual(cliMergeRes.parentsMerged, 1);

  const reExportedCli = exportSummaries(tempCliDbPath);
  assert.strictEqual(reExportedCli.parents.length, 1);
  assert.strictEqual(reExportedCli.parents[0].parent_id, 'cli-parent-1');

  const rawDb = new DatabaseSync(tempCliDbPath, { readOnly: true });
  const parentTable = rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_parents'").get();
  rawDb.close();
  assert(parentTable, 'conversation_parents table must exist in CLI DB');

  // Test read-safe export when -wal sidecar exists & union of row columns on import & null timestamps
  const walSeedPath = path.join(process.cwd(), 'tests', 'temp_wal_seed.db');
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(walSeedPath + ext)) fs.unlinkSync(walSeedPath + ext);
  }
  try {
    importAndMergeSummaries(walSeedPath, {
      version: 2,
      conversations: [
        {
          conversation_id: 'wal-1',
          title: 'Initial Title',
          workspace_uris: '[]',
          last_modified_time: '2026-11-13T01:00:00Z',
          last_user_input_time: '2026-11-13T01:00:00Z'
        },
        {
          conversation_id: 'empty-ts',
          title: 'Empty Timestamp Row',
          workspace_uris: '[]',
          last_modified_time: '',
          last_user_input_time: '2026-11-13T01:00:00Z',
          group_id: 'grp-9'
        }
      ]
    });
    // Write uncommitted update to WAL while connection remains open during exportSummaries
    const activeConn = new DatabaseSync(walSeedPath);
    activeConn.exec("PRAGMA journal_mode = WAL;");
    activeConn.prepare("UPDATE conversation_summaries SET title = 'WAL Live Title' WHERE conversation_id = 'wal-1'").run();
    const walExported = exportSummaries(walSeedPath);
    activeConn.close();

    const walRow = walExported.conversations.find(c => c.conversation_id === 'wal-1');
    assert.strictEqual(walRow.title, 'WAL Live Title');
    const emptyRow = walExported.conversations.find(c => c.conversation_id === 'empty-ts');
    assert.strictEqual(emptyRow.group_id, 'grp-9');

    // Merge empty/invalid timestamp should not overwrite valid timestamp, and valid timestamp should update empty timestamp
    const emptyTestTarget = path.join(process.cwd(), 'tests', 'temp_null_target.db');
    if (fs.existsSync(emptyTestTarget)) fs.unlinkSync(emptyTestTarget);
    try {
      importAndMergeSummaries(emptyTestTarget, {
        version: 2,
        conversations: [
          {
            conversation_id: 'c1',
            title: 'Valid Ts',
            workspace_uris: '[]',
            last_modified_time: '2026-11-13T01:00:00Z',
            last_user_input_time: '2026-11-13T01:00:00Z'
          },
          {
            conversation_id: 'c2',
            title: 'Empty Ts',
            workspace_uris: '[]',
            last_modified_time: '',
            last_user_input_time: ''
          }
        ]
      });
      const resNullMerge = importAndMergeSummaries(emptyTestTarget, {
        version: 2,
        conversations: [
          {
            conversation_id: 'c1',
            title: 'Should Not Overwrite With Empty',
            workspace_uris: '[]',
            last_modified_time: '',
            last_user_input_time: ''
          },
          {
            conversation_id: 'c2',
            title: 'Replaced By Valid',
            workspace_uris: '[]',
            last_modified_time: '2026-11-13T02:00:00Z',
            last_user_input_time: '2026-11-13T02:00:00Z'
          }
        ]
      });
      assert.strictEqual(resNullMerge.updated, 1);
      assert.strictEqual(resNullMerge.skipped, 1);
      const afterNullMerge = exportSummaries(emptyTestTarget);
      assert.strictEqual(afterNullMerge.conversations.find(c => c.conversation_id === 'c1').title, 'Valid Ts');
      assert.strictEqual(afterNullMerge.conversations.find(c => c.conversation_id === 'c2').title, 'Replaced By Valid');
    } finally {
      for (const ext of ['', '-wal', '-shm']) {
        if (fs.existsSync(emptyTestTarget + ext)) fs.unlinkSync(emptyTestTarget + ext);
      }
    }
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(walSeedPath + ext)) fs.unlinkSync(walSeedPath + ext);
    }
  }

  console.log('All db.js unit tests passed successfully! 🎉');
} finally {
  for (const p of [tempSourceDbPath, tempDbPath, tempCliDbPath]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
