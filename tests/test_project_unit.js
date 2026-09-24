import { createSnapshot, listSnapshots, exportToSyncDir, importFromSyncDir } from '../src/storage.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const testDir = path.join(process.cwd(), 'tests', 'test_project_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const mockAgy = 'C:/Users/dam/.gemini/antigravity';
const mockProjectsDir = path.join(testDir, 'local-projects');
const mockSyncDir = path.join(testDir, 'sync-repo');
const mockBackupDir = path.join(testDir, 'backups');
const mockDestProjectsDir = path.join(testDir, 'dest-projects');
const mockDestAgy = path.join(testDir, 'dest-antigravity');

fs.mkdirSync(mockProjectsDir, { recursive: true });

// Create sample project JSON with Windows file URI
const sampleProject = {
  id: 'test-project-123',
  name: 'ontology-map-lite',
  projectResources: {
    resources: [
      {
        gitFolder: {
          folderUri: 'file:///c%3A/Users/dam/ontology-map-lite',
          defaultBranch: 'main'
        }
      }
    ]
  },
  settings: {},
  isWorkspaceOnly: false
};

fs.writeFileSync(
  path.join(mockProjectsDir, 'test-project-123.json'),
  JSON.stringify(sampleProject, null, 2),
  'utf8'
);

try {
  // Test 1: Snapshot includes projects
  const snapshotPath = createSnapshot(mockAgy, mockBackupDir, mockProjectsDir);
  assert(fs.existsSync(path.join(snapshotPath, 'projects', 'test-project-123.json')));
  console.log('Project snapshot verified! ✅');

  // Test 2: Export templatizes folderUri in projects
  const exportResult = exportToSyncDir(mockAgy, mockSyncDir, mockProjectsDir);
  console.log('Export result:', exportResult);
  assert.strictEqual(exportResult.projectCount, 1);

  const syncProjectRaw = fs.readFileSync(
    path.join(mockSyncDir, 'projects', 'test-project-123.json'),
    'utf8'
  );
  assert(syncProjectRaw.includes('{{USER_HOME}}'), 'folderUri must be templatized with {{USER_HOME}}');
  console.log('Project export templatization verified! ✅');

  // Test 3: Import expands folderUri into target home
  const targetHome = 'C:/Users/alice';
  const importResult = importFromSyncDir(mockSyncDir, mockDestAgy, mockDestProjectsDir, {
    targetHome
  });
  console.log('Import result:', importResult);
  assert.strictEqual(importResult.copiedProjectCount, 1);

  const destProjectRaw = fs.readFileSync(
    path.join(mockDestProjectsDir, 'test-project-123.json'),
    'utf8'
  );
  assert(destProjectRaw.includes('C:/Users/alice') || destProjectRaw.includes('c%3A/Users/alice') || destProjectRaw.includes('C%3A/Users/alice'));
  console.log('Project import expansion verified! ✅');

  console.log('All project sync unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
