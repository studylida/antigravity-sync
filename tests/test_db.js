import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert';

const db = new DatabaseSync('C:/Users/dam/.gemini/antigravity/conversation_summaries.db');
const rows = db.prepare('SELECT * FROM conversation_summaries').all();
console.log('Read rows count:', rows.length);

const serialized = rows.map(r => {
  const item = { ...r };
  if (item.raw_summary instanceof Uint8Array || Buffer.isBuffer(item.raw_summary)) {
    item.raw_summary = Buffer.from(item.raw_summary).toString('base64');
  }
  return item;
});

const memDb = new DatabaseSync(':memory:');
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").get();
memDb.exec(schema.sql);

const cols = Object.keys(serialized[0]);
const placeholders = cols.map(() => '?').join(', ');
const stmt = memDb.prepare(`INSERT INTO conversation_summaries (${cols.join(', ')}) VALUES (${placeholders})`);

for (const s of serialized) {
  const values = cols.map(c => {
    if (c === 'raw_summary' && typeof s[c] === 'string') {
      return Buffer.from(s[c], 'base64');
    }
    return s[c];
  });
  stmt.run(...values);
}

const memCount = memDb.prepare('SELECT count(*) as c FROM conversation_summaries').get();
console.log('In-memory inserted rows count:', memCount.c);
assert.strictEqual(memCount.c, rows.length);

const restoredRow = memDb.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(rows[0].conversation_id);
assert.strictEqual(restoredRow.title, rows[0].title);
assert.deepStrictEqual(restoredRow.raw_summary, rows[0].raw_summary);
console.log('Serialization & In-Memory restoration test passed perfectly!');
