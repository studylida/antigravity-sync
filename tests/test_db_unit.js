import { exportSummaries, importAndMergeSummaries, ensureSummariesDb } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const tempDbPath = path.join(process.cwd(), 'tests', 'temp_test_summaries.db');
if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

try {
  const sourceDbPath = 'C:/Users/dam/.gemini/antigravity/conversation_summaries.db';
  const exported = exportSummaries(sourceDbPath);
  console.log('Exported conversations count:', exported.conversations.length);
  assert(exported.conversations.length >= 2);

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

  console.log('All db.js unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
}
