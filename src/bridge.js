import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportSummaries, importAndMergeSummaries } from './db.js';
import { createSnapshot, copyConversationDbs, copyBrainDirs } from './storage.js';
import { syncClientProtoSummaries } from './proto_summaries.js';

function isRecordNewer(candidate, baseline) {
  const candTime = new Date(candidate.last_modified_time).getTime();
  const baseTime = new Date(baseline.last_modified_time).getTime();
  return (
    (Number.isFinite(candTime) && Number.isFinite(baseTime) && candTime > baseTime) ||
    (candidate.step_count || 0) > (baseline.step_count || 0)
  );
}

/**
 * Computes conversation differences between local Antigravity Desktop and CLI stores.
 */
export function getBridgeDiff(desktopDir, cliDir) {
  const home = os.homedir();
  const desktopDb = path.join(desktopDir, 'conversation_summaries.db');
  const cliDb = path.join(cliDir, 'conversation_summaries.db');

  const desktopIndex = fs.existsSync(desktopDb) ? exportSummaries(desktopDb, home) : { conversations: [] };
  const cliIndex = fs.existsSync(cliDb) ? exportSummaries(cliDb, home) : { conversations: [] };

  const desktopMap = new Map(desktopIndex.conversations.map(c => [c.conversation_id, c]));
  const cliMap = new Map(cliIndex.conversations.map(c => [c.conversation_id, c]));

  const desktopOnly = [];
  const cliOnly = [];
  const newerInDesktop = [];
  const newerInCli = [];

  for (const [id, conv] of desktopMap) {
    const counterpart = cliMap.get(id);
    if (!counterpart) {
      desktopOnly.push(conv);
    } else if (isRecordNewer(conv, counterpart)) {
      newerInDesktop.push(conv);
    }
  }

  for (const [id, conv] of cliMap) {
    const counterpart = desktopMap.get(id);
    if (!counterpart) {
      cliOnly.push(conv);
    } else if (isRecordNewer(conv, counterpart)) {
      newerInCli.push(conv);
    }
  }

  return {
    desktopExists: fs.existsSync(desktopDir),
    cliExists: fs.existsSync(cliDir),
    desktopCount: desktopIndex.conversations.length,
    cliCount: cliIndex.conversations.length,
    desktopOnly,
    cliOnly,
    newerInDesktop,
    newerInCli
  };
}

function transformCliRowForDesktop(conv, existing) {
  const next = { ...conv, app_data_dir: 'antigravity' };
  if (!next.source && conv.app_data_dir === 'antigravity-cli') {
    next.source = 'CORTEX_TRAJECTORY_SOURCE_CLI';
  } else if (!next.source && existing?.source) {
    next.source = existing.source;
  }
  return next;
}

function transformDesktopRowForCli(conv, existing) {
  if (existing) {
    return {
      ...conv,
      app_data_dir: existing.app_data_dir || 'antigravity',
      source: existing.source ?? ''
    };
  }
  if (conv.source === 'CORTEX_TRAJECTORY_SOURCE_CLI') {
    return {
      ...conv,
      app_data_dir: 'antigravity-cli',
      source: ''
    };
  }
  return {
    ...conv,
    app_data_dir: 'antigravity',
    source: ''
  };
}

/**
 * Bridges conversations locally between Antigravity Desktop and Antigravity CLI (`agy`).
 */
export function bridgeLocalClients(cfg, options = {}) {
  const direction = options.direction || 'both';
  const dryRun = Boolean(options.dryRun);
  const desktopDir = cfg.desktopDir || cfg.antigravityDir;
  const cliDir = cfg.cliDir;
  const home = options.homeDir || os.homedir();

  if (!desktopDir || !cliDir) {
    throw new Error('Desktop 경로와 CLI 경로가 모두 설정되어 있어야 합니다.');
  }

  const diff = getBridgeDiff(desktopDir, cliDir);
  if (dryRun) {
    return { dryRun: true, direction, diff, snapshotPath: null, cliToDesktop: null, desktopToCli: null };
  }

  if (!fs.existsSync(desktopDir) && (direction === 'cli-to-desktop' || direction === 'both')) {
    fs.mkdirSync(desktopDir, { recursive: true });
  }
  if (!fs.existsSync(cliDir) && (direction === 'desktop-to-cli' || direction === 'both')) {
    fs.mkdirSync(cliDir, { recursive: true });
  }

  let snapshotPath = null;
  if (cfg.backupDir) {
    snapshotPath = createSnapshot(cfg, cfg.backupDir);
  }

  // Read both initial indices before mutating either side so bidirectional bridge stays deterministic
  const desktopDbPath = path.join(desktopDir, 'conversation_summaries.db');
  const cliDbPath = path.join(cliDir, 'conversation_summaries.db');
  const initialDesktopIndex = fs.existsSync(desktopDbPath)
    ? exportSummaries(desktopDbPath, home)
    : { version: 2, sourceHomeDir: home, exportedAt: new Date().toISOString(), conversations: [], parents: [] };
  const initialCliIndex = fs.existsSync(cliDbPath)
    ? exportSummaries(cliDbPath, home)
    : { version: 2, sourceHomeDir: home, exportedAt: new Date().toISOString(), conversations: [], parents: [] };

  let cliToDesktop = null;
  if (direction === 'both' || direction === 'cli-to-desktop') {
    const mergeStats = importAndMergeSummaries(desktopDbPath, initialCliIndex, {
      targetHome: home,
      transformRow: transformCliRowForDesktop
    });
    if (mergeStats.added > 0 || mergeStats.updated > 0) {
      syncClientProtoSummaries(desktopDir, desktopDbPath);
    }
    const targetIds = new Set([
      ...diff.cliOnly.map(c => c.conversation_id),
      ...diff.newerInCli.map(c => c.conversation_id)
    ]);
    const copiedDbCount = targetIds.size > 0
      ? copyConversationDbs(path.join(cliDir, 'conversations'), path.join(desktopDir, 'conversations'), targetIds)
      : 0;
    const copiedBrainCount = targetIds.size > 0
      ? copyBrainDirs(path.join(cliDir, 'brain'), path.join(desktopDir, 'brain'), null, targetIds)
      : 0;
    cliToDesktop = { mergeStats, copiedDbCount, copiedBrainCount };
  }

  let desktopToCli = null;
  if (direction === 'both' || direction === 'desktop-to-cli') {
    const mergeStats = importAndMergeSummaries(cliDbPath, initialDesktopIndex, {
      targetHome: home,
      includeParentsTable: true,
      transformRow: transformDesktopRowForCli
    });
    if (mergeStats.added > 0 || mergeStats.updated > 0) {
      syncClientProtoSummaries(cliDir, cliDbPath);
    }
    const targetIds = new Set([
      ...diff.desktopOnly.map(c => c.conversation_id),
      ...diff.newerInDesktop.map(c => c.conversation_id)
    ]);
    const copiedDbCount = targetIds.size > 0
      ? copyConversationDbs(path.join(desktopDir, 'conversations'), path.join(cliDir, 'conversations'), targetIds)
      : 0;
    const copiedBrainCount = targetIds.size > 0
      ? copyBrainDirs(path.join(desktopDir, 'brain'), path.join(cliDir, 'brain'), null, targetIds)
      : 0;
    desktopToCli = { mergeStats, copiedDbCount, copiedBrainCount };
  }

  return {
    dryRun: false,
    direction,
    diff,
    snapshotPath,
    cliToDesktop,
    desktopToCli
  };
}
