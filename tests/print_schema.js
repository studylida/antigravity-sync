import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/dam/.gemini/antigravity/conversation_summaries.db');
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").get();
console.log('SCHEMA:\n' + schema.sql);
