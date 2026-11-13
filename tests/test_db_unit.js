import { exportSummaries, importAndMergeSummaries } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const tempDbPath = path.join(process.cwd(), 'tests', 'temp_test_summaries.db');
const tempCliDbPath = path.join(process.cwd(), 'tests', 'temp_test_cli_summaries.db');
for (const p of [tempDbPath, tempCliDbPath]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

try {
  const sourceDbPath = 'C:/Users/dam/.gemini/antigravity/conversation_summaries.db';
  const exported = exportSummaries(sourceDbPath);
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

  console.log('All db.js unit tests passed successfully! 🎉');
} finally {
  for (const p of [tempDbPath, tempCliDbPath]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
