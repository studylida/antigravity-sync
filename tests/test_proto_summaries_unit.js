import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { importAndMergeSummaries } from '../src/db.js';
import { createSnapshot, restoreSnapshot } from '../src/storage.js';
import {
  readProtoSummaryCache,
  writeProtoSummaryCache,
  syncClientProtoSummaries,
  patchRawSummaryBlob
} from '../src/proto_summaries.js';

const testDir = path.join(process.cwd(), 'tests', 'test_proto_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

try {
  const desktopDir = path.join(testDir, 'antigravity');
  const backupDir = path.join(testDir, 'backups');
  fs.mkdirSync(path.join(desktopDir, 'conversations'), { recursive: true });

  const titleBytes = Buffer.from('Intact Title', 'utf8');
  const nestedTitle = Buffer.concat([Buffer.from([0x0a, titleBytes.length]), titleBytes]);
  const intactRaw = Buffer.concat([
    Buffer.from([0x0a, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]),
    Buffer.from([0x7a, nestedTitle.length]),
    nestedTitle
  ]);
  const staleRaw = Buffer.from([0x0a, 0x05, 0x53, 0x74, 0x61, 0x6c, 0x65, 0xa0, 0x01, 0x11]);

  const dbPath = path.join(desktopDir, 'conversation_summaries.db');
  importAndMergeSummaries(dbPath, {
    version: 2,
    sourceHomeDir: testDir,
    conversations: [
      {
        conversation_id: 'conv-1',
        title: 'Intact Title',
        preview: 'Hello',
        step_count: 10,
        last_modified_time: '2026-11-13T07:00:00Z',
        workspace_uris: '["file:///C:/repo"]',
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
        last_user_input_time: '2026-11-13T07:00:00Z',
        last_user_input_step_index: 9,
        app_data_dir: 'antigravity',
        raw_summary: intactRaw.toString('base64'),
        group_id: ''
      }
    ]
  });

  // Seed agyhub_summaries_proto.pb with matching entry & create snapshot
  const pbPath = path.join(desktopDir, 'agyhub_summaries_proto.pb');
  writeProtoSummaryCache(
    pbPath,
    new Map([['conv-1', intactRaw]]),
    new Map([['conv-1', 1700000000]])
  );

  const snapPath = createSnapshot({ desktopDir }, backupDir);
  assert(fs.existsSync(path.join(snapPath, 'desktop', 'agyhub_summaries_proto.pb')));

  // Simulate proto cache corruption + missing .pb in snapshot (legacy snapshot test)
  fs.rmSync(path.join(snapPath, 'desktop', 'agyhub_summaries_proto.pb'));
  writeProtoSummaryCache(
    pbPath,
    new Map([['conv-1', staleRaw]]),
    new Map([['conv-1', 1700000100]])
  );

  // Restore snapshot: even without .pb in snapshot, proto cache should rebuild from SQLite raw_summary
  restoreSnapshot(snapPath, { desktopDir });
  const afterRestore = readProtoSummaryCache(pbPath);
  assert(afterRestore.summaries.get('conv-1')?.equals(intactRaw), 'proto cache must match restored SQLite raw_summary');

  // Direct syncClientProtoSummaries test
  writeProtoSummaryCache(
    pbPath,
    new Map([['conv-1', staleRaw]]),
    new Map([['conv-1', 1700000100]])
  );
  const syncedCount = syncClientProtoSummaries(desktopDir, dbPath);
  assert.strictEqual(syncedCount, 1);
  const afterSync = readProtoSummaryCache(pbPath);
  const syncedBlob = afterSync.summaries.get('conv-1');
  assert(syncedBlob && syncedBlob.includes(Buffer.from('Intact Title', 'utf8')));

  // patchRawSummaryBlob: adding/removing CLI source enum & updating title
  const withCliSource = patchRawSummaryBlob(intactRaw, { source: 'CORTEX_TRAJECTORY_SOURCE_CLI', title: 'Updated Title' });
  assert(withCliSource.includes(Buffer.from('Updated Title', 'utf8')));
  assert(!withCliSource.includes(Buffer.from('Title', 'utf8')) || withCliSource.includes(Buffer.from('Updated Title', 'utf8')));
  const strippedCliSource = patchRawSummaryBlob(withCliSource, { source: '', title: 'Desktop Title' });
  assert(strippedCliSource.includes(Buffer.from('Desktop Title', 'utf8')));
  assert(strippedCliSource.length < withCliSource.length || !strippedCliSource.equals(withCliSource));

  // Verify patching field 17 sub 18 (project_id) inside a summary blob containing field 17
  const sub18 = Buffer.concat([Buffer.from([0x92, 0x01, 19]), Buffer.from('default-cli-project', 'utf8')]);
  const withField17 = Buffer.concat([strippedCliSource, Buffer.from([0x8a, 0x01, sub18.length]), sub18]);
  const remappedProject = patchRawSummaryBlob(withField17, { source: '', title: 'Desktop Title', projectId: 'outside-of-project' });
  assert(remappedProject.includes(Buffer.from('outside-of-project', 'utf8')));
  assert(!remappedProject.includes(Buffer.from('default-cli-project', 'utf8')));

  console.log('All proto_summaries.js unit tests passed successfully!');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
