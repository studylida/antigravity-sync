import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportSummaries, importAndMergeSummaries } from './db.js';
import { expandPaths } from './path_utils.js';

/**
 * Creates an emergency rollback snapshot of local Antigravity state.
 */
export function createSnapshot(antigravityDir, backupBaseDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = path.join(backupBaseDir, `snapshot_${timestamp}`);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const summaryDb = path.join(antigravityDir, 'conversation_summaries.db');
  if (fs.existsSync(summaryDb)) {
    try {
      fs.copyFileSync(summaryDb, path.join(snapshotDir, 'conversation_summaries.db'));
      if (fs.existsSync(summaryDb + '-wal')) fs.copyFileSync(summaryDb + '-wal', path.join(snapshotDir, 'conversation_summaries.db-wal'));
    } catch (err) {
      console.warn(`[Snapshot] Warning copying summaries db: ${err.message}`);
    }
  }

  // Backup conversations dir (.db files only, .db-shm is transient shared memory)
  const convDir = path.join(antigravityDir, 'conversations');
  if (fs.existsSync(convDir)) {
    const destConv = path.join(snapshotDir, 'conversations');
    fs.mkdirSync(destConv, { recursive: true });
    for (const file of fs.readdirSync(convDir)) {
      if (file.endsWith('.db')) {
        try {
          fs.copyFileSync(path.join(convDir, file), path.join(destConv, file));
        } catch (err) {
          console.warn(`[Snapshot] Warning copying ${file}: ${err.message}`);
        }
      }
    }
  }

  // Prune old snapshots (keep latest 10)
  pruneSnapshots(backupBaseDir, 10);

  return snapshotDir;
}

/**
 * Lists all existing rollback snapshots.
 */
export function listSnapshots(backupBaseDir) {
  if (!fs.existsSync(backupBaseDir)) return [];
  const entries = fs.readdirSync(backupBaseDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && e.name.startsWith('snapshot_'))
    .map(e => ({
      name: e.name,
      path: path.join(backupBaseDir, e.name),
      createdAt: e.name.replace('snapshot_', '').replace(/-/g, ':')
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Prunes old snapshots to keep disk usage under control.
 */
export function pruneSnapshots(backupBaseDir, maxKeep = 10) {
  const list = listSnapshots(backupBaseDir);
  if (list.length > maxKeep) {
    for (let i = maxKeep; i < list.length; i++) {
      try {
        fs.rmSync(list[i].path, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[Snapshot] Failed to prune ${list[i].name}:`, err.message);
      }
    }
  }
}

/**
 * Recursively copies a directory with optional text transformation for transcripts.
 */
export function copyDirRecursive(src, dest, transformFn = null) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, transformFn);
    } else {
      let shouldCopy = true;
      if (fs.existsSync(destPath)) {
        const srcStat = fs.statSync(srcPath);
        const destStat = fs.statSync(destPath);
        if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
          shouldCopy = false;
        }
      }
      if (shouldCopy) {
        if (transformFn && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
          try {
            const raw = fs.readFileSync(srcPath, 'utf8');
            const transformed = transformFn(raw);
            fs.writeFileSync(destPath, transformed, 'utf8');
          } catch {
            fs.copyFileSync(srcPath, destPath);
          }
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  }
}

/**
 * Exports Antigravity state into the sync target folder.
 */
export function exportToSyncDir(antigravityDir, syncDir) {
  fs.mkdirSync(syncDir, { recursive: true });
  const syncConversations = path.join(syncDir, 'conversations');
  const syncBrain = path.join(syncDir, 'brain');
  fs.mkdirSync(syncConversations, { recursive: true });
  fs.mkdirSync(syncBrain, { recursive: true });

  // 1. Export conversation_summaries.db to conversations_index.json
  const localSummaryDb = path.join(antigravityDir, 'conversation_summaries.db');
  const indexData = exportSummaries(localSummaryDb);
  const indexJsonPath = path.join(syncDir, 'conversations_index.json');
  fs.writeFileSync(indexJsonPath, JSON.stringify(indexData, null, 2), 'utf8');

  // 2. Copy conversation DB files (.db)
  const localConversations = path.join(antigravityDir, 'conversations');
  let convCount = 0;
  if (fs.existsSync(localConversations)) {
    const files = fs.readdirSync(localConversations);
    for (const f of files) {
      if (f.endsWith('.db')) {
        const src = path.join(localConversations, f);
        const dest = path.join(syncConversations, f);
        fs.copyFileSync(src, dest);
        convCount++;
      }
    }
  }

  // 3. Copy brain artifacts and logs
  const localBrain = path.join(antigravityDir, 'brain');
  let brainCount = 0;
  if (fs.existsSync(localBrain)) {
    const dirs = fs.readdirSync(localBrain, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory()) {
        copyDirRecursive(path.join(localBrain, d.name), path.join(syncBrain, d.name));
        brainCount++;
      }
    }
  }

  return {
    indexCount: indexData.conversations.length,
    convCount,
    brainCount
  };
}

/**
 * Imports and merges conversations from sync directory into local Antigravity.
 */
export function importFromSyncDir(syncDir, antigravityDir, options = {}) {
  const indexJsonPath = path.join(syncDir, 'conversations_index.json');
  if (!fs.existsSync(indexJsonPath)) {
    throw new Error(`Sync index not found at ${indexJsonPath}. Has a push been executed?`);
  }

  const raw = fs.readFileSync(indexJsonPath, 'utf8');
  const indexData = JSON.parse(raw);

  // 1. Merge summaries DB
  const localSummaryDb = path.join(antigravityDir, 'conversation_summaries.db');
  const mergeStats = importAndMergeSummaries(localSummaryDb, indexData, options);

  // 2. Copy conversation DB files
  const syncConversations = path.join(syncDir, 'conversations');
  const localConversations = path.join(antigravityDir, 'conversations');
  fs.mkdirSync(localConversations, { recursive: true });

  let copiedDbCount = 0;
  if (fs.existsSync(syncConversations)) {
    const files = fs.readdirSync(syncConversations);
    for (const f of files) {
      if (f.endsWith('.db')) {
        const src = path.join(syncConversations, f);
        const dest = path.join(localConversations, f);
        if (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
          fs.copyFileSync(src, dest);
          copiedDbCount++;
        }
      }
    }
  }

  // 3. Copy brain directories with dynamic path adaptation
  const syncBrain = path.join(syncDir, 'brain');
  const localBrain = path.join(antigravityDir, 'brain');
  fs.mkdirSync(localBrain, { recursive: true });

  const transformFn = (content) => expandPaths(
    content,
    options.targetHome || os.homedir(),
    indexData.sourceHomeDir || '',
    options.pathMappings || {}
  );

  let copiedBrainCount = 0;
  if (fs.existsSync(syncBrain)) {
    const dirs = fs.readdirSync(syncBrain, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory()) {
        copyDirRecursive(path.join(syncBrain, d.name), path.join(localBrain, d.name), transformFn);
        copiedBrainCount++;
      }
    }
  }

  return {
    mergeStats,
    copiedDbCount,
    copiedBrainCount
  };
}
