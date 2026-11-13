import { createSnapshot, listSnapshots, restoreSnapshot, exportToSyncDir, importFromSyncDir } from '../src/storage.js';
import { importAndMergeSummaries } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const testDir = path.join(process.cwd(), 'tests', 'test_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const mockDesktop = 'C:/Users/dam/.gemini/antigravity';
const mockCli = path.join(testDir, 'src-cli');
const mockConfig = path.join(testDir, 'src-config');
const mockProjects = path.join(mockConfig, 'projects');
const mockSyncDir = path.join(testDir, 'sync-repo');
const mockBackupDir = path.join(testDir, 'backups');

const destDesktop = path.join(testDir, 'dest-desktop');
const destCli = path.join(testDir, 'dest-cli');
const destConfig = path.join(testDir, 'dest-config');
const destProjects = path.join(destConfig, 'projects');

// Setup mock CLI & Config
fs.mkdirSync(path.join(mockCli, 'conversations'), { recursive: true });
fs.mkdirSync(path.join(mockCli, 'brain', 'cli-conv-1', '.system_generated', 'logs'), { recursive: true });
fs.mkdirSync(path.join(mockCli, 'cache'), { recursive: true });
fs.mkdirSync(mockProjects, { recursive: true });

importAndMergeSummaries(path.join(mockCli, 'conversation_summaries.db'), {
  version: 2,
  sourceHomeDir: 'C:/Users/work',
  conversations: [
    {
      conversation_id: 'cli-conv-1',
      title: 'CLI Work Session',
      preview: 'hello cli',
      step_count: 10,
      last_modified_time: '2026-11-13T06:00:00Z',
      workspace_uris: '["file:///C:/Users/work/repo-a"]',
      status: 'CASCADE_RUN_STATUS_IDLE',
      source: '',
      project_id: 'default-cli-project',
      agent_name: '',
      parent_conversation_id: '',
      nesting_depth: 0,
      battle_id: '',
      winning_conversation_id: '',
      not_fully_idle: 0,
      killed: 0,
      last_user_input_time: '2026-11-13T06:00:00Z',
      last_user_input_step_index: 8,
      app_data_dir: 'antigravity-cli',
      raw_summary: null,
      group_id: ''
    }
  ],
  parents: [{ conversation_id: 'cli-conv-1', parent_id: 'cli-parent-0' }]
}, { includeParentsTable: true, targetHome: 'C:/Users/work' });

fs.writeFileSync(path.join(mockCli, 'conversations', 'cli-conv-1.db'), 'dummy-sqlite-bytes');
fs.writeFileSync(
  path.join(mockCli, 'brain', 'cli-conv-1', '.system_generated', 'logs', 'transcript.jsonl'),
  JSON.stringify({ step_index: 0, content: 'C:\\Users\\work\\repo-a' }) + '\n'
);
fs.writeFileSync(
  path.join(mockCli, 'settings.json'),
  JSON.stringify({ model: 'Gemini 4 Hydrogen (Medium)', trustedWorkspaces: ['C:\\Users\\work\\repo-a'] }, null, 2)
);
fs.writeFileSync(
  path.join(mockCli, 'cache', 'last_conversations.json'),
  JSON.stringify({ 'C:\\Users\\work\\repo-a': 'cli-conv-1' }, null, 2)
);
fs.writeFileSync(
  path.join(mockConfig, 'mcp_config.json'),
  JSON.stringify({ mcpServers: { localTool: { command: 'node', args: ['C:\\Users\\work\\tool.js'] } } }, null, 2)
);

try {
  // Test 1: v2 Snapshot creation & restore
  const srcCfg = {
    desktopDir: mockDesktop,
    cliDir: mockCli,
    geminiConfigDir: mockConfig,
    projectsDir: mockProjects,
    syncDir: mockSyncDir,
    backupDir: mockBackupDir,
    targets: { desktop: true, cli: true, config: true }
  };

  const snapshotPath = createSnapshot(srcCfg, mockBackupDir);
  assert(fs.existsSync(path.join(snapshotPath, 'snapshot_manifest.json')));
  assert(fs.existsSync(path.join(snapshotPath, 'desktop', 'conversation_summaries.db')));
  assert(fs.existsSync(path.join(snapshotPath, 'cli', 'settings.json')));
  assert(fs.existsSync(path.join(snapshotPath, 'config', 'mcp_config.json')));
  assert.strictEqual(listSnapshots(mockBackupDir).length, 1);

  // Test 2: v2 Export to sync dir
  const exportResult = exportToSyncDir(srcCfg, { homeDir: 'C:/Users/work' });
  assert.strictEqual(exportResult.schemaVersion, 2);
  assert(fs.existsSync(path.join(mockSyncDir, 'manifest.json')));
  assert(fs.existsSync(path.join(mockSyncDir, 'desktop', 'conversations_index.json')));
  assert(fs.existsSync(path.join(mockSyncDir, 'cli', 'conversations_index.json')));
  assert(fs.existsSync(path.join(mockSyncDir, 'cli', 'settings.json')));
  assert(fs.existsSync(path.join(mockSyncDir, 'cli', 'last_conversations.json')));
  assert(fs.existsSync(path.join(mockSyncDir, 'config', 'mcp_config.json')));

  const exportedSettings = fs.readFileSync(path.join(mockSyncDir, 'cli', 'settings.json'), 'utf8');
  assert(exportedSettings.includes('{{USER_HOME_JSON}}'), 'settings.json paths must be templatized');

  // Test 3: Seed destination with local-only trustedWorkspace & mcpServer to verify non-destructive merge
  fs.mkdirSync(destCli, { recursive: true });
  fs.writeFileSync(
    path.join(destCli, 'settings.json'),
    JSON.stringify({ trustedWorkspaces: ['C:\\Users\\home\\local-only'] }, null, 2)
  );
  fs.mkdirSync(destConfig, { recursive: true });
  fs.writeFileSync(
    path.join(destConfig, 'mcp_config.json'),
    JSON.stringify({ mcpServers: { homeOnly: { command: 'python' } } }, null, 2)
  );

  const destCfg = {
    desktopDir: destDesktop,
    cliDir: destCli,
    geminiConfigDir: destConfig,
    projectsDir: destProjects,
    syncDir: mockSyncDir,
    backupDir: mockBackupDir,
    targets: { desktop: true, cli: true, config: true }
  };

  const importResult = await importFromSyncDir(destCfg, { targetHome: 'C:/Users/home' });
  assert.strictEqual(importResult.schemaVersion, 2);
  assert.strictEqual(importResult.desktop.mergeStats.added, exportResult.desktop.indexCount);
  assert.strictEqual(importResult.cli.mergeStats.added, 1);
  assert.strictEqual(importResult.cli.mergeStats.parentsMerged, 1);
  assert.strictEqual(importResult.cli.settingsMerged, true);
  assert.strictEqual(importResult.cli.lastConversationsMerged, true);
  assert.strictEqual(importResult.config.mcpMerged, true);

  const mergedSettings = JSON.parse(fs.readFileSync(path.join(destCli, 'settings.json'), 'utf8'));
  assert(mergedSettings.trustedWorkspaces.includes('C:\\Users\\home\\local-only'));
  assert(mergedSettings.trustedWorkspaces.includes('C:\\Users\\home\\repo-a'));

  const mergedLast = JSON.parse(fs.readFileSync(path.join(destCli, 'cache', 'last_conversations.json'), 'utf8'));
  assert.strictEqual(mergedLast['C:\\Users\\home\\repo-a'], 'cli-conv-1');

  const mergedMcp = JSON.parse(fs.readFileSync(path.join(destConfig, 'mcp_config.json'), 'utf8'));
  assert(mergedMcp.mcpServers.homeOnly);
  assert(mergedMcp.mcpServers.localTool);

  // Test 4: Restore snapshot into fresh destination
  const restoredDest = path.join(testDir, 'restored-dest');
  const restoreRes = restoreSnapshot(snapshotPath, {
    desktopDir: path.join(restoredDest, 'desktop'),
    cliDir: path.join(restoredDest, 'cli'),
    geminiConfigDir: path.join(restoredDest, 'config'),
    projectsDir: path.join(restoredDest, 'config', 'projects')
  });
  assert.strictEqual(restoreRes.version, 2);
  assert.strictEqual(restoreRes.desktop.summary, true);
  assert.strictEqual(restoreRes.cli.summary, true);
  assert.strictEqual(restoreRes.mcpRestored, true);

  console.log('All storage.js v2 unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
