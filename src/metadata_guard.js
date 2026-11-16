import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getConfigDir } from './config.js';
import { patchRawSummaryBlob, syncClientProtoSummaries } from './proto_summaries.js';

export function getDefaultGuardPath() {
  return path.join(getConfigDir(), 'metadata_guard.json');
}

export function loadMetadataGuard(guardPath = getDefaultGuardPath()) {
  if (!guardPath || !fs.existsSync(guardPath)) {
    return { version: 1, updatedAt: '', conversations: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.conversations && typeof parsed.conversations === 'object') {
      return {
        version: 1,
        updatedAt: parsed.updatedAt || '',
        conversations: parsed.conversations
      };
    }
  } catch {
    // Fall back to empty ledger if corrupted
  }
  return { version: 1, updatedAt: '', conversations: {} };
}

export function saveMetadataGuard(guardData, guardPath = getDefaultGuardPath()) {
  if (!guardPath) return;
  const dir = path.dirname(guardPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    conversations: guardData.conversations || {}
  };
  const tmpPath = `${guardPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, guardPath);
}

function ensureAnnotationTitleFile(clientDir, convId, title) {
  if (!clientDir || !convId || !title) return;
  const annDir = path.join(clientDir, 'annotations');
  const pbtxtPath = path.join(annDir, `${convId}.pbtxt`);
  try {
    if (fs.existsSync(pbtxtPath)) {
      const curr = fs.readFileSync(pbtxtPath, 'utf8');
      if (/title:\s*"[^"]+"/.test(curr)) return;
    }
    fs.mkdirSync(annDir, { recursive: true });
    const escaped = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fs.writeFileSync(pbtxtPath, `title:"${escaped}"\n`, 'utf8');
  } catch {
    // Best-effort annotation repair
  }
}

/**
 * Auto-heals Desktop and CLI conversation_summaries.db rows whose title, source, or project_id
 * were overwritten (e.g. by Desktop's additionalDirs scanner) using the persistent metadata guard ledger.
 */
export function healClientDbsFromGuard({
  desktopDir,
  cliDir,
  desktopDbPath,
  cliDbPath,
  guardPath = getDefaultGuardPath()
} = {}) {
  const guard = loadMetadataGuard(guardPath);
  const entries = guard.conversations || {};
  if (Object.keys(entries).length === 0) {
    return { desktopHealed: 0, cliHealed: 0 };
  }

  let desktopHealed = 0;
  let cliHealed = 0;

  if (desktopDbPath && fs.existsSync(desktopDbPath)) {
    const db = new DatabaseSync(desktopDbPath);
    const healedItems = [];
    try {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").get();
      if (hasTable) {
        const rows = db.prepare('SELECT conversation_id, title, source, project_id, raw_summary FROM conversation_summaries').all();
        const updStmt = db.prepare(
          'UPDATE conversation_summaries SET `title` = ?, `source` = ?, `project_id` = ?, `raw_summary` = ? WHERE `conversation_id` = ?'
        );
        db.exec('BEGIN TRANSACTION');
        for (const r of rows) {
          const g = entries[r.conversation_id];
          if (!g) continue;

          const desiredTitle = r.title || g.title || '';
          const shouldRestoreSource = g.desktopSource === '' && r.source === 'CORTEX_TRAJECTORY_SOURCE_CLI';
          const desiredSource = shouldRestoreSource ? '' : r.source;

          let desiredProjectId = r.project_id;
          if (g.desktopProjectId && g.desktopProjectId !== 'default-cli-project') {
            if (!r.project_id || r.project_id === 'default-cli-project' || (g.isDesktopNative && r.project_id !== g.desktopProjectId)) {
              desiredProjectId = g.desktopProjectId;
            }
          }

          if (desiredTitle !== r.title || desiredSource !== r.source || desiredProjectId !== r.project_id) {
            const patchedRaw = patchRawSummaryBlob(r.raw_summary, {
              source: desiredSource,
              title: desiredTitle,
              projectId: desiredProjectId
            });
            updStmt.run(desiredTitle, desiredSource, desiredProjectId, patchedRaw, r.conversation_id);
            healedItems.push({ id: r.conversation_id, title: desiredTitle });
            desktopHealed++;
          }
        }
        db.exec('COMMIT');
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
      }
    } catch {
      try { db.exec('ROLLBACK'); } catch {}
    } finally {
      db.close();
    }

    if (desktopHealed > 0) {
      for (const item of healedItems) {
        if (item.title) ensureAnnotationTitleFile(desktopDir, item.id, item.title);
      }
      syncClientProtoSummaries(desktopDir, desktopDbPath);
    }
  }

  if (cliDbPath && fs.existsSync(cliDbPath)) {
    const db = new DatabaseSync(cliDbPath);
    const healedItems = [];
    try {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").get();
      if (hasTable) {
        const rows = db.prepare('SELECT conversation_id, title, source, project_id, raw_summary FROM conversation_summaries').all();
        const updStmt = db.prepare(
          'UPDATE conversation_summaries SET `title` = ?, `raw_summary` = ? WHERE `conversation_id` = ?'
        );
        db.exec('BEGIN TRANSACTION');
        for (const r of rows) {
          const g = entries[r.conversation_id];
          if (!g || !g.title || r.title) continue;
          const patchedRaw = patchRawSummaryBlob(r.raw_summary, {
            source: r.source,
            title: g.title,
            projectId: r.project_id
          });
          updStmt.run(g.title, patchedRaw, r.conversation_id);
          healedItems.push({ id: r.conversation_id, title: g.title });
          cliHealed++;
        }
        db.exec('COMMIT');
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
      }
    } catch {
      try { db.exec('ROLLBACK'); } catch {}
    } finally {
      db.close();
    }

    if (cliHealed > 0) {
      for (const item of healedItems) {
        ensureAnnotationTitleFile(cliDir, item.id, item.title);
      }
      syncClientProtoSummaries(cliDir, cliDbPath);
    }
  }

  return { desktopHealed, cliHealed };
}

function parseTimeMs(val) {
  if (!val) return NaN;
  return new Date(val).getTime();
}

/**
 * Updates the persistent metadata guard ledger from current Desktop and CLI DBs.
 * Never overwrites a known non-empty title with an empty string.
 */
export function recordMetadataGuard({
  desktopDbPath,
  cliDbPath,
  guardPath = getDefaultGuardPath()
} = {}) {
  const guard = loadMetadataGuard(guardPath);
  const convs = guard.conversations || {};

  const readRows = (dbPath) => {
    if (!dbPath || !fs.existsSync(dbPath)) return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").get();
      if (!hasTable) return [];
      return db.prepare('SELECT conversation_id, title, source, project_id, last_modified_time FROM conversation_summaries').all();
    } finally {
      db.close();
    }
  };

  const deskRows = readRows(desktopDbPath);
  const cliRows = readRows(cliDbPath);
  const cliMap = new Map(cliRows.map(r => [r.conversation_id, r]));

  for (const r of deskRows) {
    const prev = convs[r.conversation_id] || {};
    const cliRow = cliMap.get(r.conversation_id);
    const next = { ...prev };

    if (r.title) {
      const prevTime = parseTimeMs(prev.titleUpdatedAt);
      const currTime = parseTimeMs(r.last_modified_time);
      if (!prev.title || !Number.isFinite(prevTime) || (Number.isFinite(currTime) && currTime >= prevTime)) {
        next.title = r.title;
        if (r.last_modified_time) next.titleUpdatedAt = r.last_modified_time;
      }
    }

    if (r.source === '') {
      next.desktopSource = '';
    }
    if (r.project_id && r.project_id !== 'default-cli-project') {
      next.desktopProjectId = r.project_id;
    }
    if (cliRow) {
      next.isDesktopNative = cliRow.project_id !== 'default-cli-project';
    } else if (r.project_id && r.project_id !== 'default-cli-project' && r.source === '') {
      next.isDesktopNative = true;
    }

    next.updatedAt = new Date().toISOString();
    convs[r.conversation_id] = next;
  }

  for (const r of cliRows) {
    const prev = convs[r.conversation_id] || {};
    const next = { ...prev };
    if (r.title) {
      const prevTime = parseTimeMs(prev.titleUpdatedAt);
      const currTime = parseTimeMs(r.last_modified_time);
      if (!prev.title || !Number.isFinite(prevTime) || (Number.isFinite(currTime) && currTime > prevTime)) {
        next.title = r.title;
        if (r.last_modified_time) next.titleUpdatedAt = r.last_modified_time;
      }
    }
    if (r.project_id === 'default-cli-project') {
      next.isDesktopNative = false;
    }
    next.updatedAt = new Date().toISOString();
    convs[r.conversation_id] = next;
  }

  guard.conversations = convs;
  saveMetadataGuard(guard, guardPath);
  return Object.keys(convs).length;
}
