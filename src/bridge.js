import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportSummaries, importAndMergeSummaries } from './db.js';
import { createSnapshot, copyConversationDbs, copyBrainDirs, copyAnnotationsFiles, removeSqliteSidecars } from './storage.js';
import { syncClientProtoSummaries } from './proto_summaries.js';

function parseTimestampMs(value) {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function isRecordNewer(candidate, baseline) {
  const candTime = parseTimestampMs(candidate.last_modified_time);
  const baseTime = parseTimestampMs(baseline.last_modified_time);
  return (
    (Number.isFinite(candTime) && Number.isFinite(baseTime) && candTime > baseTime) ||
    (candidate.step_count || 0) > (baseline.step_count || 0) ||
    (!baseline.title && Boolean(candidate.title))
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
  const isWorkspaceDesktopConv = Boolean(conv.project_id && conv.project_id !== 'default-cli-project');
  if (!next.source && conv.app_data_dir === 'antigravity-cli' && !isWorkspaceDesktopConv) {
    next.source = 'CORTEX_TRAJECTORY_SOURCE_CLI';
  } else if (!next.source && existing?.source && !isWorkspaceDesktopConv) {
    next.source = existing.source;
  }
  return next;
}

/**
 * Removes Desktop-native .db copies that older bridge versions placed in cliDir/conversations/.
 * Only deletes files that already exist in desktopDir/conversations/ and clearly belong to Desktop projects.
 */
function cleanupPoisonedCliConversationDbs(desktopDir, cliDir, desktopIndex, cliIndex) {
  const deskConvsDir = path.join(desktopDir, 'conversations');
  const cliConvsDir = path.join(cliDir, 'conversations');
  if (!fs.existsSync(deskConvsDir) || !fs.existsSync(cliConvsDir)) return 0;

  const deskMap = new Map((desktopIndex.conversations || []).map(c => [c.conversation_id, c]));
  const cliMap = new Map((cliIndex.conversations || []).map(c => [c.conversation_id, c]));
  let cleaned = 0;

  for (const file of fs.readdirSync(cliConvsDir)) {
    if (!file.endsWith('.db')) continue;
    const convId = file.slice(0, -3);
    if (!fs.existsSync(path.join(deskConvsDir, file))) continue;

    const dRow = deskMap.get(convId);
    const cRow = cliMap.get(convId);
    const projectId = dRow?.project_id || cRow?.project_id || '';
    const belongsToCli = dRow?.project_id === 'default-cli-project' || cRow?.project_id === 'default-cli-project';
    if (projectId && !belongsToCli) {
      const targetDb = path.join(cliConvsDir, file);
      removeSqliteSidecars(targetDb);
      fs.rmSync(targetDb, { force: true });
      cleaned++;
    }
  }
  return cleaned;
}

function transformDesktopRowForCli(conv, existing) {
  const isCliProject = (existing?.project_id || conv.project_id) === 'default-cli-project';
  if (existing) {
    return {
      ...conv,
      app_data_dir: isCliProject ? (existing.app_data_dir || 'antigravity-cli') : 'antigravity',
      source: existing.source ?? ''
    };
  }
  if (conv.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' && isCliProject) {
    return {
      ...conv,
      app_data_dir: 'antigravity-cli',
      source: ''
    };
  }
  return {
    ...conv,
    app_data_dir: isCliProject ? 'antigravity-cli' : 'antigravity',
    source: ''
  };
}

function collectCliArtifactIdsForDesktop(cliDir, desktopDir, cliIndex, diffTargetIds) {
  const result = new Set(diffTargetIds);
  const cliConvDir = path.join(cliDir, 'conversations');
  const deskConvDir = path.join(desktopDir, 'conversations');
  const cliBrainDir = path.join(cliDir, 'brain');
  const deskBrainDir = path.join(desktopDir, 'brain');

  for (const conv of cliIndex.conversations || []) {
    const id = conv?.conversation_id;
    if (!id) continue;
    const hasCliDb = fs.existsSync(path.join(cliConvDir, `${id}.db`));
    const missingDeskDb = hasCliDb && !fs.existsSync(path.join(deskConvDir, `${id}.db`));
    const hasCliBrain = fs.existsSync(path.join(cliBrainDir, id));
    const missingDeskBrain = hasCliBrain && !fs.existsSync(path.join(deskBrainDir, id));
    if (missingDeskDb || missingDeskBrain) {
      result.add(id);
    }
  }
  return result;
}

function syncCliMetadataCache(cliDir, cliDbPath) {
  const cachePath = path.join(cliDir, 'cache', 'conversation_metadata.json');
  if (!fs.existsSync(cachePath) || !fs.existsSync(cliDbPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.conversations) return;
    const cliIndex = exportSummaries(cliDbPath);
    let dirty = false;
    for (const c of cliIndex.conversations || []) {
      const id = c.conversation_id;
      const entry = raw.conversations[id];
      if (!entry?.summary) continue;
      if (c.title && entry.summary.Title !== c.title) {
        entry.summary.Title = c.title;
        dirty = true;
      }
      if (c.app_data_dir && entry.summary.AppDataDir !== c.app_data_dir) {
        entry.summary.AppDataDir = c.app_data_dir;
        dirty = true;
      }
      if (c.project_id && entry.summary.ProjectID !== c.project_id) {
        entry.summary.ProjectID = c.project_id;
        dirty = true;
      }
      if (Number.isFinite(c.step_count) && entry.summary.NumSteps !== c.step_count) {
        entry.summary.NumSteps = c.step_count;
        dirty = true;
      }
    }
    if (dirty) {
      fs.writeFileSync(cachePath, JSON.stringify(raw, null, 2), 'utf8');
    }
  } catch {
    // Non-fatal cache sync
  }
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
  if (path.resolve(desktopDir) === path.resolve(cliDir)) {
    throw new Error('Desktop 경로와 CLI 경로가 동일하여 브리지를 실행할 수 없습니다.');
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

  const cleanedCliDbCount = cleanupPoisonedCliConversationDbs(desktopDir, cliDir, initialDesktopIndex, initialCliIndex);

  let cliToDesktop = null;
  if (direction === 'both' || direction === 'cli-to-desktop') {
    const mergeStats = importAndMergeSummaries(desktopDbPath, initialCliIndex, {
      targetHome: home,
      transformRow: transformCliRowForDesktop
    });
    if (mergeStats.added > 0 || mergeStats.updated > 0) {
      syncClientProtoSummaries(desktopDir, desktopDbPath);
    }
    const diffTargetIds = new Set([
      ...diff.cliOnly.map(c => c.conversation_id),
      ...diff.newerInCli.map(c => c.conversation_id)
    ]);
    const targetIds = collectCliArtifactIdsForDesktop(cliDir, desktopDir, initialCliIndex, diffTargetIds);
    const copiedDbCount = targetIds.size > 0
      ? copyConversationDbs(path.join(cliDir, 'conversations'), path.join(desktopDir, 'conversations'), targetIds)
      : 0;
    const copiedBrainCount = targetIds.size > 0
      ? copyBrainDirs(path.join(cliDir, 'brain'), path.join(desktopDir, 'brain'), null, targetIds)
      : 0;
    if (targetIds.size > 0) {
      copyAnnotationsFiles(path.join(cliDir, 'annotations'), path.join(desktopDir, 'annotations'), true, targetIds);
    }
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
      syncCliMetadataCache(cliDir, cliDbPath);
    }
    const targetIds = new Set([
      ...diff.desktopOnly.map(c => c.conversation_id),
      ...diff.newerInDesktop.map(c => c.conversation_id)
    ]);
    // Do NOT place Desktop-native .db files into cliDir/conversations/:
    // Antigravity Desktop (agyhub) watches antigravity-cli/conversations/ as an additionalDir
    // and re-tags any .db found there as CORTEX_TRAJECTORY_SOURCE_CLI, wiping Desktop titles/pins.
    const existingCliConvDir = path.join(cliDir, 'conversations');
    const safeCliDbTargetIds = new Set(
      Array.from(targetIds).filter(id => fs.existsSync(path.join(existingCliConvDir, `${id}.db`)))
    );
    const copiedDbCount = safeCliDbTargetIds.size > 0
      ? copyConversationDbs(path.join(desktopDir, 'conversations'), existingCliConvDir, safeCliDbTargetIds)
      : 0;
    const copiedBrainCount = targetIds.size > 0
      ? copyBrainDirs(path.join(desktopDir, 'brain'), path.join(cliDir, 'brain'), null, targetIds)
      : 0;
    if (targetIds.size > 0) {
      copyAnnotationsFiles(path.join(desktopDir, 'annotations'), path.join(cliDir, 'annotations'), true, targetIds);
    }
    desktopToCli = { mergeStats, copiedDbCount, copiedBrainCount };
  }

  return {
    dryRun: false,
    direction,
    diff,
    snapshotPath,
    cleanedCliDbCount,
    cliToDesktop,
    desktopToCli
  };
}
