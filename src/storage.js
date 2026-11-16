import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { exportSummaries, importAndMergeSummaries, checkpointSqliteDb, mergeConversationIndexes } from './db.js';
import { expandPaths, expandPathString, templatizePaths } from './path_utils.js';
import { resolveProjectLocalPath, toFileUri, fromFileUri } from './project_locator.js';
import { PROTO_CACHE_FILENAMES, syncClientProtoSummaries } from './proto_summaries.js';
import { healClientDbsFromGuard, recordMetadataGuard, syncCliMetadataCache, syncMetadataGuardFile } from './metadata_guard.js';
import { TOOL_VERSION, SYNC_SCHEMA_VERSION } from './version.js';

function fileSha256(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function filesHaveSameContent(aPath, bPath) {
  try {
    const statA = fs.statSync(aPath);
    const statB = fs.statSync(bPath);
    if (statA.size !== statB.size) return false;
    return fileSha256(aPath) === fileSha256(bPath);
  } catch {
    return false;
  }
}

function writeTextIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    try {
      if (fs.readFileSync(filePath, 'utf8') === content) return false;
    } catch {
      // Fall through and overwrite
    }
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function copyMatchingFiles(srcDir, destDir, predicate) {
  if (!srcDir || !fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const file of fs.readdirSync(srcDir)) {
    if (predicate(file)) {
      try {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        count++;
      } catch (err) {
        console.warn(`[Storage] Warning copying ${file}: ${err.message}`);
      }
    }
  }
  return count;
}

export function removeSqliteSidecars(dbPath) {
  for (const ext of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${ext}`;
    if (fs.existsSync(sidecar)) {
      fs.rmSync(sidecar, { force: true });
    }
  }
}

function backupClientFiles(clientDir, destDir, includeCliExtras = false) {
  if (!clientDir || !fs.existsSync(clientDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  const summaryDb = path.join(clientDir, 'conversation_summaries.db');
  if (fs.existsSync(summaryDb)) {
    checkpointSqliteDb(summaryDb);
    try {
      fs.copyFileSync(summaryDb, path.join(destDir, 'conversation_summaries.db'));
      if (fs.existsSync(summaryDb + '-wal')) {
        fs.copyFileSync(summaryDb + '-wal', path.join(destDir, 'conversation_summaries.db-wal'));
      }
    } catch (err) {
      console.warn(`[Snapshot] Warning copying summaries db: ${err.message}`);
    }
  }

  for (const protoName of PROTO_CACHE_FILENAMES) {
    const protoSrc = path.join(clientDir, protoName);
    if (fs.existsSync(protoSrc)) {
      fs.copyFileSync(protoSrc, path.join(destDir, protoName));
    }
  }

  const srcConvsDir = path.join(clientDir, 'conversations');
  if (fs.existsSync(srcConvsDir)) {
    for (const file of fs.readdirSync(srcConvsDir)) {
      if (file.endsWith('.db')) {
        checkpointSqliteDb(path.join(srcConvsDir, file));
      }
    }
  }

  copyMatchingFiles(
    srcConvsDir,
    path.join(destDir, 'conversations'),
    f => f.endsWith('.db')
  );

  copyAnnotationsFiles(
    path.join(clientDir, 'annotations'),
    path.join(destDir, 'annotations'),
    false
  );

  if (includeCliExtras) {
    const settingsPath = path.join(clientDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, path.join(destDir, 'settings.json'));
    }
    const lastConvPath = path.join(clientDir, 'cache', 'last_conversations.json');
    if (fs.existsSync(lastConvPath)) {
      fs.copyFileSync(lastConvPath, path.join(destDir, 'last_conversations.json'));
    }
  }
}

/**
 * Creates an emergency rollback snapshot of local Antigravity state.
 * Supports both v2 config object ({ desktopDir, cliDir, geminiConfigDir, projectsDir }, backupBaseDir)
 * and legacy v1 signature (antigravityDir, backupBaseDir, projectsDir).
 */
export function createSnapshot(target, backupBaseDir, legacyProjectsDir = '') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = path.join(backupBaseDir, `snapshot_${timestamp}`);
  fs.mkdirSync(snapshotDir, { recursive: true });

  if (typeof target === 'string') {
    backupClientFiles(target, snapshotDir, false);
    if (legacyProjectsDir) {
      copyMatchingFiles(legacyProjectsDir, path.join(snapshotDir, 'projects'), f => f.endsWith('.json'));
    }
  } else {
    const cfg = target || {};
    fs.writeFileSync(
      path.join(snapshotDir, 'snapshot_manifest.json'),
      JSON.stringify({ version: 2, toolVersion: TOOL_VERSION, createdAt: new Date().toISOString() }, null, 2),
      'utf8'
    );

    if (cfg.desktopDir) {
      backupClientFiles(cfg.desktopDir, path.join(snapshotDir, 'desktop'), false);
    }
    if (cfg.cliDir) {
      backupClientFiles(cfg.cliDir, path.join(snapshotDir, 'cli'), true);
    }
    if (cfg.projectsDir) {
      copyMatchingFiles(cfg.projectsDir, path.join(snapshotDir, 'config', 'projects'), f => f.endsWith('.json'));
    }
    if (cfg.geminiConfigDir) {
      const mcpPath = path.join(cfg.geminiConfigDir, 'mcp_config.json');
      if (fs.existsSync(mcpPath)) {
        fs.mkdirSync(path.join(snapshotDir, 'config'), { recursive: true });
        fs.copyFileSync(mcpPath, path.join(snapshotDir, 'config', 'mcp_config.json'));
      }
    }
  }

  pruneSnapshots(backupBaseDir, 10);
  return snapshotDir;
}

/**
 * Lists all existing rollback snapshots sorted newest first.
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

function restoreClientBackup(snapClientDir, targetClientDir, includeCliExtras = false) {
  const restored = { summary: false, dbs: 0, extras: 0 };
  if (!snapClientDir || !targetClientDir || !fs.existsSync(snapClientDir)) return restored;

  fs.mkdirSync(targetClientDir, { recursive: true });

  const snapSummary = path.join(snapClientDir, 'conversation_summaries.db');
  const targetSummary = path.join(targetClientDir, 'conversation_summaries.db');
  if (fs.existsSync(snapSummary)) {
    removeSqliteSidecars(targetSummary);
    fs.copyFileSync(snapSummary, targetSummary);
    const snapWal = snapSummary + '-wal';
    if (fs.existsSync(snapWal) && fs.statSync(snapWal).size > 0) {
      fs.copyFileSync(snapWal, targetSummary + '-wal');
    }
    checkpointSqliteDb(targetSummary);
    restored.summary = true;
  }

  let restoredProto = false;
  for (const protoName of PROTO_CACHE_FILENAMES) {
    const snapProto = path.join(snapClientDir, protoName);
    if (fs.existsSync(snapProto)) {
      fs.copyFileSync(snapProto, path.join(targetClientDir, protoName));
      restoredProto = true;
    }
  }
  if (!restoredProto && restored.summary) {
    syncClientProtoSummaries(targetClientDir, targetSummary);
  }

  restored.dbs = copyMatchingFiles(
    path.join(snapClientDir, 'conversations'),
    path.join(targetClientDir, 'conversations'),
    f => f.endsWith('.db')
  );
  copyAnnotationsFiles(
    path.join(snapClientDir, 'annotations'),
    path.join(targetClientDir, 'annotations'),
    false
  );
  const targetConvsDir = path.join(targetClientDir, 'conversations');
  if (fs.existsSync(path.join(snapClientDir, 'conversations'))) {
    for (const file of fs.readdirSync(path.join(snapClientDir, 'conversations'))) {
      if (file.endsWith('.db')) {
        removeSqliteSidecars(path.join(targetConvsDir, file));
      }
    }
  }

  if (includeCliExtras) {
    const snapSettings = path.join(snapClientDir, 'settings.json');
    if (fs.existsSync(snapSettings)) {
      fs.copyFileSync(snapSettings, path.join(targetClientDir, 'settings.json'));
      restored.extras++;
    }
    const snapLast = path.join(snapClientDir, 'last_conversations.json');
    if (fs.existsSync(snapLast)) {
      fs.mkdirSync(path.join(targetClientDir, 'cache'), { recursive: true });
      fs.copyFileSync(snapLast, path.join(targetClientDir, 'cache', 'last_conversations.json'));
      restored.extras++;
    }
  }

  return restored;
}

/**
 * Restores either a v2 snapshot (desktop/cli/config) or a legacy v1 snapshot.
 */
export function restoreSnapshot(snapshotPath, cfg) {
  const isV2 = fs.existsSync(path.join(snapshotPath, 'snapshot_manifest.json')) ||
    fs.existsSync(path.join(snapshotPath, 'desktop')) ||
    fs.existsSync(path.join(snapshotPath, 'cli'));

  if (!isV2) {
    const desktop = restoreClientBackup(snapshotPath, cfg.desktopDir || cfg.antigravityDir, false);
    const projects = cfg.projectsDir
      ? copyMatchingFiles(path.join(snapshotPath, 'projects'), cfg.projectsDir, f => f.endsWith('.json'))
      : 0;
    return { version: 1, desktop, cli: { summary: false, dbs: 0, extras: 0 }, projects, mcpRestored: false };
  }

  const desktop = restoreClientBackup(path.join(snapshotPath, 'desktop'), cfg.desktopDir, false);
  const cli = restoreClientBackup(path.join(snapshotPath, 'cli'), cfg.cliDir, true);
  const projects = cfg.projectsDir
    ? copyMatchingFiles(path.join(snapshotPath, 'config', 'projects'), cfg.projectsDir, f => f.endsWith('.json'))
    : 0;

  let mcpRestored = false;
  const snapMcp = path.join(snapshotPath, 'config', 'mcp_config.json');
  if (cfg.geminiConfigDir && fs.existsSync(snapMcp)) {
    fs.mkdirSync(cfg.geminiConfigDir, { recursive: true });
    fs.copyFileSync(snapMcp, path.join(cfg.geminiConfigDir, 'mcp_config.json'));
    mcpRestored = true;
  }

  return { version: 2, desktop, cli, projects, mcpRestored };
}

/**
 * Recursively copies a directory with optional text transformation for JSON/JSONL files.
 */
const isAnnotationFile = (name) => name.endsWith('.pbtxt') || name.endsWith('.pb');

export function copyAnnotationsFiles(srcDir, destDir, onlyIfNewer = false, onlyIds = null, options = {}) {
  if (!fs.existsSync(srcDir)) return 0;
  if (onlyIds && onlyIds.size === 0) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  const forceIds = options.forceIds instanceof Set ? options.forceIds : null;
  const skipIds = options.skipIds instanceof Set ? options.skipIds : null;
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isAnnotationFile(entry.name)) continue;
    const convId = entry.name.replace(/\.(pbtxt|pb)$/, '');
    if (onlyIds && !onlyIds.has(convId)) continue;
    if (skipIds && skipIds.has(convId)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (fs.existsSync(destPath)) {
      if (entry.name.endsWith('.pbtxt')) {
        try {
          const destHasTitle = /title:\s*"[^"]+"/.test(fs.readFileSync(destPath, 'utf8'));
          const srcHasTitle = /title:\s*"[^"]+"/.test(fs.readFileSync(srcPath, 'utf8'));
          if (destHasTitle && !srcHasTitle) continue;
        } catch {
          // Ignore read errors and fall back to stat checks
        }
      }
      if (forceIds && forceIds.has(convId)) {
        if (filesHaveSameContent(srcPath, destPath)) continue;
      } else if (onlyIfNewer) {
        const srcStat = fs.statSync(srcPath);
        const destStat = fs.statSync(destPath);
        if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
          continue;
        }
        if (srcStat.mtimeMs < destStat.mtimeMs) {
          continue;
        }
      }
    }
    fs.copyFileSync(srcPath, destPath);
    count++;
  }
  return count;
}

export function copyDirRecursive(src, dest, transformFn = null, options = {}) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  const forceOverwrite = Boolean(options.forceOverwrite);
  let written = 0;

  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    let lstat;
    try {
      lstat = fs.lstatSync(srcPath);
    } catch {
      continue;
    }

    // Skip symlinks (especially broken ones) so recursive sync never crashes on dangling links
    if (lstat.isSymbolicLink()) {
      continue;
    }

    if (lstat.isDirectory()) {
      written += copyDirRecursive(srcPath, destPath, transformFn, options);
    } else if (lstat.isFile()) {
      const isTextTransformed = Boolean(transformFn && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')));
      if (isTextTransformed) {
        try {
          const raw = fs.readFileSync(srcPath, 'utf8');
          const transformed = transformFn(raw);
          if (fs.existsSync(destPath)) {
            if (!forceOverwrite) {
              const destStat = fs.statSync(destPath);
              if (lstat.size === destStat.size && lstat.mtimeMs <= destStat.mtimeMs) {
                continue;
              }
            }
            if (fs.readFileSync(destPath, 'utf8') === transformed) {
              continue;
            }
          }
          fs.writeFileSync(destPath, transformed, 'utf8');
          written++;
          continue;
        } catch {
          // Fall back to binary copy below
        }
      }

      let shouldCopy = true;
      if (fs.existsSync(destPath)) {
        if (forceOverwrite) {
          shouldCopy = !filesHaveSameContent(srcPath, destPath);
        } else {
          try {
            const destStat = fs.statSync(destPath);
            if (filesHaveSameContent(srcPath, destPath) || (lstat.size === destStat.size && lstat.mtimeMs <= destStat.mtimeMs)) {
              shouldCopy = false;
            }
          } catch {
            shouldCopy = true;
          }
        }
      }
      if (shouldCopy) {
        try {
          fs.copyFileSync(srcPath, destPath);
          written++;
        } catch (err) {
          console.warn(`[Storage] Failed to copy ${srcPath}: ${err.message}`);
        }
      }
    }
  }
  return written;
}

/**
 * Copies conversation .db files from srcConvDir to destConvDir if missing, newer in index, or newer on disk.
 */
export function copyConversationDbs(srcConvDir, destConvDir, onlyIds = null, options = {}) {
  if (!srcConvDir || !fs.existsSync(srcConvDir)) return 0;
  if (onlyIds && onlyIds.size === 0) return 0;
  fs.mkdirSync(destConvDir, { recursive: true });
  const forceIds = options.forceIds instanceof Set ? options.forceIds : null;
  const skipIds = options.skipIds instanceof Set ? options.skipIds : null;
  const compareContentOnEqual = Boolean(options.compareContentOnEqual);
  let copiedCount = 0;
  for (const file of fs.readdirSync(srcConvDir)) {
    if (!file.endsWith('.db')) continue;
    const convId = file.slice(0, -3);
    if (onlyIds && !onlyIds.has(convId)) continue;
    if (skipIds && skipIds.has(convId)) continue;
    const src = path.join(srcConvDir, file);
    const dest = path.join(destConvDir, file);
    checkpointSqliteDb(src);

    let shouldCopy = false;
    if (!fs.existsSync(dest)) {
      shouldCopy = true;
    } else if (forceIds && forceIds.has(convId)) {
      shouldCopy = !filesHaveSameContent(src, dest);
    } else if (compareContentOnEqual) {
      shouldCopy = !filesHaveSameContent(src, dest);
    } else {
      shouldCopy = fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs;
    }

    if (shouldCopy) {
      fs.copyFileSync(src, dest);
      removeSqliteSidecars(dest);
      copiedCount++;
    }
  }
  return copiedCount;
}

/**
 * Copies brain/<id>/ directories incrementally with optional JSON/JSONL transformation.
 */
export function copyBrainDirs(srcBrainDir, destBrainDir, transformFn = null, onlyIds = null, options = {}) {
  if (!fs.existsSync(srcBrainDir)) return 0;
  if (onlyIds && onlyIds.size === 0) return 0;
  fs.mkdirSync(destBrainDir, { recursive: true });
  const forceIds = options.forceIds instanceof Set ? options.forceIds : null;
  const skipIds = options.skipIds instanceof Set ? options.skipIds : null;
  let copiedCount = 0;
  for (const d of fs.readdirSync(srcBrainDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (onlyIds && !onlyIds.has(d.name)) continue;
    if (skipIds && skipIds.has(d.name)) continue;
    copyDirRecursive(
      path.join(srcBrainDir, d.name),
      path.join(destBrainDir, d.name),
      transformFn,
      { forceOverwrite: Boolean(forceIds && forceIds.has(d.name)) }
    );
    copiedCount++;
  }
  return copiedCount;
}

function exportClientStore(clientDir, outDir, homeDir = os.homedir(), options = {}) {
  if (!clientDir || !fs.existsSync(clientDir)) {
    return { present: false, indexCount: 0, convCount: 0, copiedConvCount: 0, brainCount: 0 };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outConversations = path.join(outDir, 'conversations');
  const outBrain = path.join(outDir, 'brain');
  fs.mkdirSync(outConversations, { recursive: true });
  fs.mkdirSync(outBrain, { recursive: true });

  const localSummaryDb = path.join(clientDir, 'conversation_summaries.db');
  checkpointSqliteDb(localSummaryDb);
  const localIndexData = exportSummaries(localSummaryDb, homeDir);

  const indexOutPath = path.join(outDir, 'conversations_index.json');
  const existingSyncIndex = options.mergeWithExisting !== false ? readJsonSafe(indexOutPath) : null;

  let indexData = localIndexData;
  let forceIds = null;
  let skipIds = null;

  if (existingSyncIndex && Array.isArray(existingSyncIndex.conversations)) {
    const merged = mergeConversationIndexes(localIndexData, existingSyncIndex);
    indexData = merged.indexData;
    forceIds = new Set([...merged.localOnlyIds, ...merged.localNewerIds]);
    for (const id of merged.equalIds) {
      if (!fs.existsSync(path.join(outConversations, `${id}.db`))) {
        forceIds.add(id);
      }
    }
    skipIds = new Set([...merged.remoteOnlyIds, ...merged.remoteNewerIds]);

    const prevComparable = JSON.stringify({
      conversations: existingSyncIndex.conversations,
      parents: existingSyncIndex.parents || []
    });
    const nextComparable = JSON.stringify({
      conversations: indexData.conversations,
      parents: indexData.parents || []
    });
    if (prevComparable === nextComparable && existingSyncIndex.exportedAt) {
      indexData.exportedAt = existingSyncIndex.exportedAt;
    }
  }

  writeTextIfChanged(indexOutPath, JSON.stringify(indexData, null, 2));

  const srcConvsDir = path.join(clientDir, 'conversations');
  const copiedConvCount = copyConversationDbs(srcConvsDir, outConversations, null, {
    forceIds,
    skipIds,
    compareContentOnEqual: true
  });
  const convCount = fs.existsSync(outConversations)
    ? fs.readdirSync(outConversations).filter(f => f.endsWith('.db')).length
    : 0;

  const annotationsCount = copyAnnotationsFiles(
    path.join(clientDir, 'annotations'),
    path.join(outDir, 'annotations'),
    true,
    null,
    { forceIds, skipIds }
  );

  const transformExport = (content) => templatizePaths(content, homeDir);
  copyBrainDirs(path.join(clientDir, 'brain'), outBrain, transformExport, null, { forceIds, skipIds });
  const brainCount = fs.existsSync(outBrain)
    ? fs.readdirSync(outBrain, { withFileTypes: true }).filter(d => d.isDirectory()).length
    : 0;

  return {
    present: true,
    indexCount: indexData.conversations.length,
    convCount,
    copiedConvCount,
    annotationsCount,
    brainCount
  };
}

function importClientStore(inDir, clientDir, options = {}) {
  const indexJsonPath = path.join(inDir, 'conversations_index.json');
  if (!fs.existsSync(indexJsonPath)) {
    return {
      present: false,
      mergeStats: { added: 0, updated: 0, skipped: 0, total: 0, parentsMerged: 0 },
      copiedDbCount: 0,
      copiedBrainCount: 0
    };
  }

  const indexData = JSON.parse(fs.readFileSync(indexJsonPath, 'utf8'));
  const localSummaryDb = path.join(clientDir, 'conversation_summaries.db');
  const decisions = {
    addedIds: new Set(),
    updatedIds: new Set(),
    localNewerIds: new Set(),
    equalIds: new Set()
  };

  const isCliTarget = Boolean(options.isCliTarget);
  const effectiveOptions = {
    ...options,
    decisions,
    transformRow: options.transformRow || (isCliTarget
      ? (conv) => {
          const belongsToDesktopProj = conv.project_id && conv.project_id !== 'default-cli-project';
          return belongsToDesktopProj && conv.app_data_dir === 'antigravity-cli'
            ? { ...conv, app_data_dir: 'antigravity' }
            : conv;
        }
      : undefined)
  };

  const mergeStats = importAndMergeSummaries(localSummaryDb, indexData, effectiveOptions);
  if (mergeStats.added > 0 || mergeStats.updated > 0) {
    syncClientProtoSummaries(clientDir, localSummaryDb);
    if (isCliTarget) {
      syncCliMetadataCache(clientDir, localSummaryDb);
    }
  }

  const localConvsDir = path.join(clientDir, 'conversations');
  const forceIds = new Set([...decisions.addedIds, ...decisions.updatedIds]);
  for (const conv of indexData.conversations || []) {
    const id = conv?.conversation_id;
    if (id && !decisions.localNewerIds.has(id) && !fs.existsSync(path.join(localConvsDir, `${id}.db`))) {
      forceIds.add(id);
    }
  }
  const skipDbIds = new Set(decisions.localNewerIds);
  if (isCliTarget) {
    for (const conv of indexData.conversations || []) {
      const id = conv?.conversation_id;
      if (!id) continue;
      const belongsToDesktopProj = conv.project_id && conv.project_id !== 'default-cli-project';
      if (belongsToDesktopProj && !fs.existsSync(path.join(localConvsDir, `${id}.db`))) {
        skipDbIds.add(id);
      }
    }
  }

  const copiedDbCount = copyConversationDbs(
    path.join(inDir, 'conversations'),
    localConvsDir,
    null,
    { forceIds, skipIds: skipDbIds }
  );

  copyAnnotationsFiles(
    path.join(inDir, 'annotations'),
    path.join(clientDir, 'annotations'),
    true,
    null,
    { forceIds, skipIds: decisions.localNewerIds }
  );

  const transformImport = (content) => expandPaths(
    content,
    options.targetHome || os.homedir(),
    indexData.sourceHomeDir || '',
    options.pathMappings || {}
  );

  const copiedBrainCount = copyBrainDirs(
    path.join(inDir, 'brain'),
    path.join(clientDir, 'brain'),
    transformImport,
    null,
    { forceIds, skipIds: decisions.localNewerIds }
  );

  return {
    present: true,
    mergeStats,
    copiedDbCount,
    copiedBrainCount,
    sourceHomeDir: indexData.sourceHomeDir || ''
  };
}

function exportCliExtras(cliDir, outCliDir, homeDir = os.homedir()) {
  let settingsExported = false;
  let lastConversationsExported = false;

  const settingsPath = path.join(cliDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const outSettingsPath = path.join(outCliDir, 'settings.json');
    const templatizedRaw = templatizePaths(fs.readFileSync(settingsPath, 'utf8'), homeDir);
    try {
      const localSettings = JSON.parse(templatizedRaw);
      const existingRemote = readJsonSafe(outSettingsPath, {});
      const remoteTrusted = Array.isArray(existingRemote?.trustedWorkspaces) ? existingRemote.trustedWorkspaces : [];
      const localTrusted = Array.isArray(localSettings?.trustedWorkspaces) ? localSettings.trustedWorkspaces : [];
      const mergedTrusted = Array.from(new Set([...remoteTrusted, ...localTrusted]));
      const merged = { ...existingRemote, ...localSettings };
      if (mergedTrusted.length > 0) {
        merged.trustedWorkspaces = mergedTrusted;
      }
      writeTextIfChanged(outSettingsPath, JSON.stringify(merged, null, 2));
    } catch {
      writeTextIfChanged(outSettingsPath, templatizedRaw);
    }
    settingsExported = true;
  }

  const lastConvPath = path.join(cliDir, 'cache', 'last_conversations.json');
  if (fs.existsSync(lastConvPath)) {
    const outLastPath = path.join(outCliDir, 'last_conversations.json');
    const templatizedRaw = templatizePaths(fs.readFileSync(lastConvPath, 'utf8'), homeDir);
    try {
      const localLast = JSON.parse(templatizedRaw);
      const existingRemote = readJsonSafe(outLastPath, {});
      const merged = { ...existingRemote, ...localLast };
      writeTextIfChanged(outLastPath, JSON.stringify(merged, null, 2));
    } catch {
      writeTextIfChanged(outLastPath, templatizedRaw);
    }
    lastConversationsExported = true;
  }

  return { settingsExported, lastConversationsExported };
}

function readJsonSafe(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function importCliExtras(inCliDir, cliDir, options = {}) {
  const targetHome = options.targetHome || os.homedir();
  const sourceHome = options.sourceHomeDir || '';
  const pathMappings = options.pathMappings || {};

  let settingsMerged = false;
  let lastConversationsMerged = false;

  const remoteSettings = readJsonSafe(path.join(inCliDir, 'settings.json'));
  if (remoteSettings && typeof remoteSettings === 'object') {
    const localSettingsPath = path.join(cliDir, 'settings.json');
    const localSettings = readJsonSafe(localSettingsPath, {});

    const expandedTrusted = Array.isArray(remoteSettings.trustedWorkspaces)
      ? remoteSettings.trustedWorkspaces.map(p => expandPathString(p, targetHome, sourceHome, pathMappings))
      : [];
    const localTrusted = Array.isArray(localSettings.trustedWorkspaces) ? localSettings.trustedWorkspaces : [];
    const mergedTrusted = Array.from(new Set([...localTrusted, ...expandedTrusted]));

    const merged = {
      ...localSettings,
      ...remoteSettings
    };
    if (mergedTrusted.length > 0) {
      merged.trustedWorkspaces = mergedTrusted;
    }

    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(localSettingsPath, JSON.stringify(merged, null, 2), 'utf8');
    settingsMerged = true;
  }

  const remoteLast = readJsonSafe(path.join(inCliDir, 'last_conversations.json'));
  if (remoteLast && typeof remoteLast === 'object') {
    const cacheDir = path.join(cliDir, 'cache');
    const localLastPath = path.join(cacheDir, 'last_conversations.json');
    const localLast = readJsonSafe(localLastPath, {});

    const expandedRemote = {};
    for (const [workspacePath, convId] of Object.entries(remoteLast)) {
      const expandedPath = expandPathString(workspacePath, targetHome, sourceHome, pathMappings);
      expandedRemote[expandedPath] = convId;
    }

    const mergedLast = {
      ...localLast,
      ...expandedRemote
    };

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(localLastPath, JSON.stringify(mergedLast, null, 2), 'utf8');
    lastConversationsMerged = true;
  }

  return { settingsMerged, lastConversationsMerged };
}

function exportConfigStore(geminiConfigDir, projectsDir, outConfigDir, homeDir = os.homedir()) {
  fs.mkdirSync(outConfigDir, { recursive: true });
  const outProjects = path.join(outConfigDir, 'projects');
  fs.mkdirSync(outProjects, { recursive: true });

  let projectCount = 0;
  if (projectsDir && fs.existsSync(projectsDir)) {
    for (const f of fs.readdirSync(projectsDir)) {
      if (f.endsWith('.json')) {
        const raw = fs.readFileSync(path.join(projectsDir, f), 'utf8');
        writeTextIfChanged(path.join(outProjects, f), templatizePaths(raw, homeDir));
        projectCount++;
      }
    }
  }
  if (fs.existsSync(outProjects)) {
    const syncProjectTotal = fs.readdirSync(outProjects).filter(f => f.endsWith('.json')).length;
    if (syncProjectTotal > projectCount) projectCount = syncProjectTotal;
  }

  let mcpExported = false;
  const outMcpPath = path.join(outConfigDir, 'mcp_config.json');
  if (geminiConfigDir) {
    const mcpPath = path.join(geminiConfigDir, 'mcp_config.json');
    if (fs.existsSync(mcpPath)) {
      const raw = fs.readFileSync(mcpPath, 'utf8').trim();
      if (raw.length > 0) {
        const templatizedRaw = templatizePaths(raw, homeDir);
        try {
          const localMcp = JSON.parse(templatizedRaw);
          const existingRemote = readJsonSafe(outMcpPath, {});
          const merged = { ...existingRemote, ...localMcp };
          if (localMcp.mcpServers || existingRemote?.mcpServers) {
            merged.mcpServers = {
              ...(existingRemote?.mcpServers || {}),
              ...(localMcp.mcpServers || {})
            };
          }
          writeTextIfChanged(outMcpPath, JSON.stringify(merged, null, 2));
        } catch {
          writeTextIfChanged(outMcpPath, templatizedRaw);
        }
        mcpExported = true;
      }
    }
  }
  if (!mcpExported && fs.existsSync(outMcpPath)) {
    mcpExported = true;
  }

  return { projectCount, mcpExported };
}

function normalizeComparableFsPath(p) {
  return p ? path.resolve(p).replace(/\\/g, '/').toLowerCase() : '';
}

async function importConfigStore(inConfigDir, geminiConfigDir, projectsDir, options = {}) {
  const targetHome = options.targetHome || os.homedir();
  const sourceHome = options.sourceHomeDir || '';
  const pathMappings = options.pathMappings || {};
  const discoveredMappings = {};

  let copiedProjectCount = 0;
  const syncProjects = path.join(inConfigDir, 'projects');
  if (projectsDir && fs.existsSync(syncProjects)) {
    fs.mkdirSync(projectsDir, { recursive: true });
    for (const f of fs.readdirSync(syncProjects)) {
      if (!f.endsWith('.json')) continue;
      const raw = fs.readFileSync(path.join(syncProjects, f), 'utf8');
      const expandedRaw = expandPaths(raw, targetHome, sourceHome, pathMappings);
      try {
        const projectObj = JSON.parse(expandedRaw);
        const rawCandidatePaths = new Set();
        try {
          const rawObj = JSON.parse(raw);
          for (const res of rawObj?.projectResources?.resources || []) {
            const rawUri = res?.gitFolder?.folderUri || res?.workspaceUri || '';
            if (rawUri && !rawUri.includes('{{USER_HOME}}')) {
              const p = fromFileUri(rawUri);
              if (p) rawCandidatePaths.add(p);
            }
          }
        } catch {
          // ignore
        }
        for (const res of projectObj?.projectResources?.resources || []) {
          const uri = res?.gitFolder?.folderUri || res?.workspaceUri || '';
          const p = fromFileUri(uri);
          if (p) rawCandidatePaths.add(p);
        }

        const resolvedPath = await resolveProjectLocalPath(projectObj, projectsDir, options);
        if (resolvedPath) {
          const resolvedNorm = normalizeComparableFsPath(resolvedPath);
          for (const oldPath of rawCandidatePaths) {
            if (oldPath && normalizeComparableFsPath(oldPath) !== resolvedNorm) {
              discoveredMappings[oldPath] = resolvedPath;
            }
          }
          const newUri = toFileUri(resolvedPath);
          if (projectObj.projectResources?.resources) {
            for (const res of projectObj.projectResources.resources) {
              if (res.gitFolder) res.gitFolder.folderUri = newUri;
              if (res.workspaceUri) res.workspaceUri = newUri;
            }
          }
          writeTextIfChanged(path.join(projectsDir, f), JSON.stringify(projectObj, null, 2));
        } else {
          writeTextIfChanged(path.join(projectsDir, f), expandedRaw);
        }
      } catch {
        writeTextIfChanged(path.join(projectsDir, f), expandedRaw);
      }
      copiedProjectCount++;
    }
  }

  const effectiveMappings = { ...discoveredMappings, ...pathMappings };
  let mcpMerged = false;
  const syncMcpPath = path.join(inConfigDir, 'mcp_config.json');
  if (geminiConfigDir && fs.existsSync(syncMcpPath)) {
    const rawMcp = fs.readFileSync(syncMcpPath, 'utf8').trim();
    if (rawMcp) {
      const expandedRaw = expandPaths(rawMcp, targetHome, sourceHome, effectiveMappings);
      try {
        const remoteMcp = JSON.parse(expandedRaw);
        const localMcpPath = path.join(geminiConfigDir, 'mcp_config.json');
        const localMcp = readJsonSafe(localMcpPath, {});
        const merged = {
          ...localMcp,
          ...remoteMcp
        };
        if (remoteMcp.mcpServers || localMcp.mcpServers) {
          merged.mcpServers = {
            ...(localMcp.mcpServers || {}),
            ...(remoteMcp.mcpServers || {})
          };
        }
        fs.mkdirSync(geminiConfigDir, { recursive: true });
        writeTextIfChanged(localMcpPath, JSON.stringify(merged, null, 2));
        mcpMerged = true;
      } catch {
        // Fallback: copy raw expanded text if non-standard JSON
        fs.mkdirSync(geminiConfigDir, { recursive: true });
        writeTextIfChanged(path.join(geminiConfigDir, 'mcp_config.json'), expandedRaw);
        mcpMerged = true;
      }
    }
  }

  return { copiedProjectCount, mcpMerged, discoveredMappings };
}

function cleanupLegacyV1RootEntries(syncDir) {
  const legacyItems = ['conversations_index.json', 'conversations', 'brain', 'projects'];
  for (const item of legacyItems) {
    const target = path.join(syncDir, item);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

function resolveTargetMask(cfg, targetFilter = 'all') {
  const cfgTargets = cfg.targets || { desktop: true, cli: true, config: true };
  if (targetFilter === 'desktop') return { desktop: true, cli: false, config: false };
  if (targetFilter === 'cli') return { desktop: false, cli: true, config: false };
  if (targetFilter === 'config') return { desktop: false, cli: false, config: true };
  return {
    desktop: cfgTargets.desktop !== false,
    cli: cfgTargets.cli !== false,
    config: cfgTargets.config !== false
  };
}

/**
 * Exports local Antigravity state (Desktop, CLI, Config) into v2 sync repository.
 * Supports both v2 config object (cfg, options) and legacy v1 (antigravityDir, syncDir, projectsDir).
 */
export function exportToSyncDir(cfgOrAntigravityDir, syncDirOrOptions = {}, legacyProjectsDir = '') {
  const isLegacyCall = typeof cfgOrAntigravityDir === 'string';
  const cfg = isLegacyCall
    ? {
        desktopDir: cfgOrAntigravityDir,
        cliDir: '',
        geminiConfigDir: legacyProjectsDir ? path.dirname(legacyProjectsDir) : '',
        projectsDir: legacyProjectsDir,
        syncDir: syncDirOrOptions,
        targets: { desktop: true, cli: false, config: Boolean(legacyProjectsDir) }
      }
    : cfgOrAntigravityDir;

  const options = isLegacyCall ? {} : syncDirOrOptions;
  const homeDir = options.homeDir || os.homedir();
  const syncDir = cfg.syncDir;
  const mask = resolveTargetMask(cfg, options.target || 'all');
  const guardPath = options.guardPath || cfg.guardPath || '';
  const desktopDir = cfg.desktopDir || cfg.antigravityDir || '';
  const desktopDbPath = desktopDir ? path.join(desktopDir, 'conversation_summaries.db') : '';
  const cliDbPath = cfg.cliDir ? path.join(cfg.cliDir, 'conversation_summaries.db') : '';

  fs.mkdirSync(syncDir, { recursive: true });

  if (guardPath) {
    const syncGuardPath = path.join(syncDir, 'metadata_guard.json');
    if (fs.existsSync(syncGuardPath)) {
      syncMetadataGuardFile(guardPath, syncGuardPath, 'import');
    }
    const healRes = healClientDbsFromGuard({
      desktopDir: mask.desktop ? desktopDir : '',
      cliDir: mask.cli ? cfg.cliDir : '',
      desktopDbPath: mask.desktop ? desktopDbPath : '',
      cliDbPath: mask.cli ? cliDbPath : '',
      guardPath
    });
    if (healRes.cliHealed > 0 && cfg.cliDir && cliDbPath) {
      syncCliMetadataCache(cfg.cliDir, cliDbPath);
    }
    recordMetadataGuard({
      desktopDbPath: mask.desktop ? desktopDbPath : '',
      cliDbPath: mask.cli ? cliDbPath : '',
      guardPath
    });
  }

  const desktop = mask.desktop
    ? exportClientStore(desktopDir, path.join(syncDir, 'desktop'), homeDir, options)
    : { present: false, indexCount: 0, convCount: 0, copiedConvCount: 0, brainCount: 0 };

  let cli = { present: false, indexCount: 0, convCount: 0, copiedConvCount: 0, brainCount: 0, settingsExported: false, lastConversationsExported: false };
  if (mask.cli && cfg.cliDir && fs.existsSync(cfg.cliDir)) {
    const cliBase = exportClientStore(cfg.cliDir, path.join(syncDir, 'cli'), homeDir, options);
    const extras = exportCliExtras(cfg.cliDir, path.join(syncDir, 'cli'), homeDir);
    cli = { ...cliBase, ...extras };
  }

  const config = mask.config
    ? exportConfigStore(cfg.geminiConfigDir, cfg.projectsDir, path.join(syncDir, 'config'), homeDir)
    : { projectCount: 0, mcpExported: false };

  if (guardPath) {
    syncMetadataGuardFile(guardPath, path.join(syncDir, 'metadata_guard.json'), 'export');
  }

  const manifestPath = path.join(syncDir, 'manifest.json');
  const existingManifest = readJsonSafe(manifestPath, null);
  const nextTargets = {
    desktop: desktop.present || Boolean(existingManifest?.targets?.desktop),
    cli: cli.present || Boolean(existingManifest?.targets?.cli),
    config: Boolean(config.projectCount > 0 || config.mcpExported || existingManifest?.targets?.config)
  };
  const manifestUnchanged = existingManifest &&
    existingManifest.schemaVersion === SYNC_SCHEMA_VERSION &&
    existingManifest.toolVersion === TOOL_VERSION &&
    existingManifest.sourceHomeDir === homeDir &&
    JSON.stringify(existingManifest.targets || {}) === JSON.stringify(nextTargets);

  if (!manifestUnchanged) {
    const manifest = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      toolVersion: TOOL_VERSION,
      sourceHomeDir: homeDir,
      updatedAt: new Date().toISOString(),
      targets: nextTargets
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  cleanupLegacyV1RootEntries(syncDir);

  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    desktop,
    cli,
    config,
    // Legacy summary fields for convenience
    indexCount: desktop.indexCount,
    convCount: desktop.convCount,
    brainCount: desktop.brainCount,
    projectCount: config.projectCount
  };
}

/**
 * Imports and merges state from sync repository into local Antigravity (v2 + legacy v1 fallback).
 * Supports both v2 (cfg, options) and legacy v1 (syncDir, antigravityDir, projectsDir, options).
 */
export async function importFromSyncDir(cfgOrSyncDir, maybeAntigravityDir = {}, maybeProjectsDir = '', maybeOptions = {}) {
  const isLegacyCall = typeof cfgOrSyncDir === 'string';
  const cfg = isLegacyCall
    ? {
        syncDir: cfgOrSyncDir,
        desktopDir: maybeAntigravityDir,
        cliDir: '',
        geminiConfigDir: maybeProjectsDir ? path.dirname(maybeProjectsDir) : '',
        projectsDir: maybeProjectsDir,
        targets: { desktop: true, cli: false, config: Boolean(maybeProjectsDir) }
      }
    : cfgOrSyncDir;

  const options = isLegacyCall ? maybeOptions : (typeof maybeAntigravityDir === 'object' ? maybeAntigravityDir : {});
  const syncDir = cfg.syncDir;
  const manifestPath = path.join(syncDir, 'manifest.json');
  const legacyIndexPath = path.join(syncDir, 'conversations_index.json');
  const guardPath = options.guardPath || cfg.guardPath || '';

  // Legacy v1 sync repository fallback
  if (!fs.existsSync(manifestPath) && fs.existsSync(legacyIndexPath)) {
    const legacyIndexPreview = readJsonSafe(legacyIndexPath);
    const config = await importConfigStore(
      syncDir,
      '',
      cfg.projectsDir,
      { ...options, sourceHomeDir: legacyIndexPreview?.sourceHomeDir || '' }
    );
    const desktop = importClientStore(syncDir, cfg.desktopDir || cfg.antigravityDir, {
      ...options,
      pathMappings: { ...(config.discoveredMappings || {}), ...(options.pathMappings || {}) }
    });
    return {
      schemaVersion: 1,
      desktop,
      cli: { present: false, mergeStats: { added: 0, updated: 0, skipped: 0, total: 0, parentsMerged: 0 }, copiedDbCount: 0, copiedBrainCount: 0, settingsMerged: false, lastConversationsMerged: false },
      config,
      mergeStats: desktop.mergeStats,
      copiedDbCount: desktop.copiedDbCount,
      copiedBrainCount: desktop.copiedBrainCount,
      copiedProjectCount: config.copiedProjectCount
    };
  }

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Sync manifest not found at ${manifestPath}. Has a push been executed?`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mask = resolveTargetMask(cfg, options.target || 'all');

  if (guardPath) {
    const syncGuardPath = path.join(syncDir, 'metadata_guard.json');
    if (fs.existsSync(syncGuardPath)) {
      syncMetadataGuardFile(guardPath, syncGuardPath, 'import');
    }
  }

  const desktopIndexPreview = readJsonSafe(path.join(syncDir, 'desktop', 'conversations_index.json'));
  const cliIndexPreview = readJsonSafe(path.join(syncDir, 'cli', 'conversations_index.json'));
  const fallbackSourceHome = desktopIndexPreview?.sourceHomeDir || cliIndexPreview?.sourceHomeDir || manifest.sourceHomeDir || '';

  // Resolve shared config & Smart Project Locator path mappings FIRST so conversations get remapped paths too
  let config = { copiedProjectCount: 0, mcpMerged: false, discoveredMappings: {} };
  if (mask.config && fs.existsSync(path.join(syncDir, 'config'))) {
    config = await importConfigStore(
      path.join(syncDir, 'config'),
      cfg.geminiConfigDir,
      cfg.projectsDir,
      {
        ...options,
        sourceHomeDir: fallbackSourceHome
      }
    );
  }

  const mergedPathMappings = {
    ...(config.discoveredMappings || {}),
    ...(options.pathMappings || {})
  };
  const clientImportOptions = {
    ...options,
    pathMappings: mergedPathMappings
  };

  let desktop = { present: false, mergeStats: { added: 0, updated: 0, skipped: 0, total: 0, parentsMerged: 0 }, copiedDbCount: 0, copiedBrainCount: 0, sourceHomeDir: '' };
  const desktopDir = cfg.desktopDir || cfg.antigravityDir || '';
  if (mask.desktop && fs.existsSync(path.join(syncDir, 'desktop', 'conversations_index.json'))) {
    desktop = importClientStore(path.join(syncDir, 'desktop'), desktopDir, {
      ...clientImportOptions,
      isDesktopTarget: true
    });
  }

  let cli = { present: false, mergeStats: { added: 0, updated: 0, skipped: 0, total: 0, parentsMerged: 0 }, copiedDbCount: 0, copiedBrainCount: 0, settingsMerged: false, lastConversationsMerged: false };
  if (mask.cli && cfg.cliDir && fs.existsSync(path.join(syncDir, 'cli'))) {
    const cliStoreRes = importClientStore(path.join(syncDir, 'cli'), cfg.cliDir, {
      ...clientImportOptions,
      includeParentsTable: true,
      isCliTarget: true
    });
    const cliExtrasRes = importCliExtras(path.join(syncDir, 'cli'), cfg.cliDir, {
      ...clientImportOptions,
      sourceHomeDir: cliStoreRes.sourceHomeDir || manifest.sourceHomeDir || ''
    });
    cli = { ...cliStoreRes, ...cliExtrasRes };
  }

  if (guardPath) {
    const desktopDbPath = desktopDir ? path.join(desktopDir, 'conversation_summaries.db') : '';
    const cliDbPath = cfg.cliDir ? path.join(cfg.cliDir, 'conversation_summaries.db') : '';
    const healRes = healClientDbsFromGuard({
      desktopDir: mask.desktop ? desktopDir : '',
      cliDir: mask.cli ? cfg.cliDir : '',
      desktopDbPath: mask.desktop ? desktopDbPath : '',
      cliDbPath: mask.cli ? cliDbPath : '',
      guardPath
    });
    if (healRes.cliHealed > 0 && cfg.cliDir && cliDbPath) {
      syncCliMetadataCache(cfg.cliDir, cliDbPath);
    }
    recordMetadataGuard({
      desktopDbPath: mask.desktop ? desktopDbPath : '',
      cliDbPath: mask.cli ? cliDbPath : '',
      guardPath
    });
  }

  return {
    schemaVersion: manifest.schemaVersion || 2,
    desktop,
    cli,
    config,
    mergeStats: desktop.mergeStats,
    copiedDbCount: desktop.copiedDbCount,
    copiedBrainCount: desktop.copiedBrainCount,
    copiedProjectCount: config.copiedProjectCount
  };
}
