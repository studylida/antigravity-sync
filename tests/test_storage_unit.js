import { createSnapshot, listSnapshots, exportToSyncDir, importFromSyncDir } from '../src/storage.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const testDir = path.join(process.cwd(), 'tests', 'test_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const mockAgy = 'C:/Users/dam/.gemini/antigravity';
const mockSyncDir = path.join(testDir, 'sync-repo');
const mockBackupDir = path.join(testDir, 'backups');
const mockDestAgy = path.join(testDir, 'dest-antigravity');

try {
  // Test 1: Snapshot creation
  const snapshotPath = createSnapshot(mockAgy, mockBackupDir);
  console.log('Created snapshot at:', snapshotPath);
  assert(fs.existsSync(snapshotPath));
  const snapshots = listSnapshots(mockBackupDir);
  console.log('Snapshots found:', snapshots.length);
  assert.strictEqual(snapshots.length, 1);

  // Test 2: Export to sync dir
  const exportResult = exportToSyncDir(mockAgy, mockSyncDir);
  console.log('Export result:', exportResult);
  assert(fs.existsSync(path.join(mockSyncDir, 'conversations_index.json')));
  assert(fs.existsSync(path.join(mockSyncDir, 'conversations')));
  assert(fs.existsSync(path.join(mockSyncDir, 'brain')));

  // Test 3: Import into clean destination
  const importResult = await importFromSyncDir(mockSyncDir, mockDestAgy);
  console.log('Import result:', importResult);
  assert(fs.existsSync(path.join(mockDestAgy, 'conversation_summaries.db')));
  assert.strictEqual(importResult.mergeStats.added, exportResult.indexCount);

  console.log('All storage.js unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
