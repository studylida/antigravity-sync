import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { templatizePaths, expandPaths } from './path_utils.js';
import { patchRawSummaryBlob } from './proto_summaries.js';

export const CONVERSATION_SUMMARIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`conversation_summaries\` (
  \`conversation_id\` text,
  \`title\` text NOT NULL DEFAULT "",
  \`preview\` text NOT NULL DEFAULT "",
  \`step_count\` integer NOT NULL DEFAULT 0,
  ` + '`last_modified_time`' + ` datetime NOT NULL,
  \`workspace_uris\` text NOT NULL,
  \`status\` text NOT NULL DEFAULT "",
  \`source\` text NOT NULL DEFAULT "",
  \`project_id\` text NOT NULL DEFAULT "",
  \`agent_name\` text NOT NULL DEFAULT "",
  \`parent_conversation_id\` text NOT NULL DEFAULT "",
  \`nesting_depth\` integer NOT NULL DEFAULT 0,
  \`battle_id\` text NOT NULL DEFAULT "",
  \`winning_conversation_id\` text NOT NULL DEFAULT "",
  \`not_fully_idle\` numeric NOT NULL DEFAULT false,
  \`killed\` numeric NOT NULL DEFAULT false,
  \`last_user_input_time\` datetime NOT NULL,
  \`last_user_input_step_index\` integer NOT NULL DEFAULT -1,
  \`app_data_dir\` text NOT NULL DEFAULT "",
  \`raw_summary\` blob,
  \`group_id\` text NOT NULL DEFAULT "",
  PRIMARY KEY (\`conversation_id\`)
);
`;

export const CONVERSATION_PARENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_parents (
  conversation_id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL
) WITHOUT ROWID;
`;

function tableExists(db, tableName) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName)
  );
}

/**
 * Flushes SQLite WAL into the main database file so file copies see consistent committed state.
 */
export function checkpointSqliteDb(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath) || !fs.existsSync(`${dbPath}-wal`)) {
    return false;
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return true;
  } catch {
    return false;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

/**
 * Ensures conversation_summaries.db exists with valid schema.
 * Optionally creates conversation_parents table (used by Antigravity CLI).
 */
export function ensureSummariesDb(dbPath, options = {}) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(CONVERSATION_SUMMARIES_SCHEMA);
    if (options.includeParentsTable) {
      db.exec(CONVERSATION_PARENTS_SCHEMA);
    }
  } finally {
    db.close();
  }
}

function parseTimestampMs(value) {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function openSummariesDbReadSafe(dbPath) {
  const hasSidecar = fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`);
  if (!hasSidecar) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return {
      db,
      cleanup() {
        db.close();
      }
    };
  }

  // Copy DB + WAL/SHM to a temporary file so live Desktop/CLI readers are never blocked or dirtied
  const tmpBase = path.join(os.tmpdir(), `agy-sync-ro-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(dbPath, tmpBase);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(`${dbPath}${ext}`)) {
      fs.copyFileSync(`${dbPath}${ext}`, `${tmpBase}${ext}`);
    }
  }
  const db = new DatabaseSync(tmpBase, { readOnly: true });
  return {
    db,
    cleanup() {
      try { db.close(); } catch {}
      for (const f of [tmpBase, `${tmpBase}-wal`, `${tmpBase}-shm`]) {
        try { fs.rmSync(f, { force: true }); } catch {}
      }
    }
  };
}

/**
 * Exports all conversations (and parent links if present) from conversation_summaries.db.
 */
export function exportSummaries(dbPath, currentHome = os.homedir()) {
  if (!fs.existsSync(dbPath)) {
    return {
      version: 2,
      sourceHomeDir: currentHome,
      exportedAt: new Date().toISOString(),
      conversations: [],
      parents: []
    };
  }

  const { db, cleanup } = openSummariesDbReadSafe(dbPath);
  try {
    if (!tableExists(db, 'conversation_summaries')) {
      return {
        version: 2,
        sourceHomeDir: currentHome,
        exportedAt: new Date().toISOString(),
        conversations: [],
        parents: []
      };
    }

    const rows = db.prepare('SELECT * FROM conversation_summaries ORDER BY last_modified_time DESC').all();
    const conversations = rows.map(r => {
      const item = { ...r };
      if (item.workspace_uris) {
        item.workspace_uris = templatizePaths(item.workspace_uris, currentHome);
      }
      if (item.project_id) {
        item.project_id = templatizePaths(item.project_id, currentHome);
      }
      if (item.raw_summary instanceof Uint8Array || Buffer.isBuffer(item.raw_summary)) {
        item.raw_summary = Buffer.from(item.raw_summary).toString('base64');
      }
      return item;
    });

    let parents = [];
    if (tableExists(db, 'conversation_parents')) {
      parents = db
        .prepare('SELECT conversation_id, parent_id FROM conversation_parents ORDER BY conversation_id ASC')
        .all()
        .map(p => ({ conversation_id: p.conversation_id, parent_id: p.parent_id }));
    }

    return {
      version: 2,
      sourceHomeDir: currentHome,
      exportedAt: new Date().toISOString(),
      conversations,
      parents
    };
    } finally {
    cleanup();
  }
}

function parseDefaultValue(colMeta) {
  if (!colMeta) return null;
  const dflt = colMeta.dflt_value;
  if (dflt !== null && dflt !== undefined) {
    if (dflt === '""' || dflt === "''") return '';
    if (dflt === 'false') return 0;
    if (dflt === 'true') return 1;
    const num = Number(dflt);
    if (!Number.isNaN(num) && dflt.trim() !== '') return num;
    return dflt.replace(/^['"]|['"]$/g, '');
  }
  if (colMeta.notnull) {
    const t = (colMeta.type || '').toLowerCase();
    if (t.includes('int') || t.includes('num')) return 0;
    return '';
  }
  return null;
}

function getColumnValues(row, columns, adaptedWorkspaceUris, adaptedProjectId, colMetaMap = null) {
  return columns.map(c => {
    if (c === 'workspace_uris') return adaptedWorkspaceUris;
    if (c === 'project_id') return adaptedProjectId;
    if (c === 'raw_summary' && row[c]) {
      return patchRawSummaryBlob(row[c], { source: row.source, title: row.title });
    }
    if (row[c] !== undefined && row[c] !== null) {
      return row[c];
    }
    return parseDefaultValue(colMetaMap?.get(c));
  });
}

/**
 * Merges conversations (and optional conversation_parents) into local conversation_summaries.db.
 * @param {string} dbPath
 * @param {object} indexData
 * @param {object} options
 * @returns {{ added: number, updated: number, skipped: number, total: number, parentsMerged: number }}
 */
export function importAndMergeSummaries(dbPath, indexData, options = {}) {
  const parents = indexData.parents || [];
  const includeParentsTable = Boolean(options.includeParentsTable || parents.length > 0);
  ensureSummariesDb(dbPath, { includeParentsTable });

  const db = new DatabaseSync(dbPath);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let parentsMerged = 0;

  const targetHome = options.targetHome || os.homedir();
  const sourceHome = indexData.sourceHomeDir || '';
  const customMappings = options.pathMappings || {};
  const transformRow = typeof options.transformRow === 'function' ? options.transformRow : null;

  try {
    const existingRows = db
      .prepare('SELECT conversation_id, title, last_modified_time, step_count, app_data_dir, source, project_id, raw_summary FROM conversation_summaries')
      .all();
    const existingMap = new Map(existingRows.map(r => [r.conversation_id, r]));

    const conversations = indexData.conversations || [];
    const tableInfo = db.prepare('PRAGMA table_info(conversation_summaries)').all();
    const tableColumns = tableInfo.map(col => col.name);
    const colMetaMap = new Map(tableInfo.map(col => [col.name, col]));
    const validColSet = new Set(tableColumns);

    db.exec('BEGIN TRANSACTION');

    if (conversations.length > 0) {
      const colSet = new Set();
      for (const conv of conversations) {
        if (!conv || typeof conv !== 'object') continue;
        for (const k of Object.keys(conv)) {
          if (validColSet.has(k)) colSet.add(k);
        }
      }
      const columns = Array.from(colSet);
      if (!columns.includes('conversation_id')) {
        throw new Error('Invalid conversation index: missing conversation_id column');
      }

      const placeholders = columns.map(() => '?').join(', ');
      const updateCols = columns.filter(c => c !== 'conversation_id');
      const updateClauses = updateCols.map(c => `\`${c}\` = ?`).join(', ');

      const insertStmt = db.prepare(
        `INSERT INTO conversation_summaries (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`
      );
      const updateStmt = updateCols.length > 0
        ? db.prepare(`UPDATE conversation_summaries SET ${updateClauses} WHERE \`conversation_id\` = ?`)
        : null;

      const healTitleStmt = db.prepare(
        'UPDATE conversation_summaries SET `title` = ?, `raw_summary` = ? WHERE `conversation_id` = ?'
      );
      const syncVisibilityStmt = db.prepare(
        'UPDATE conversation_summaries SET `title` = ?, `source` = ?, `project_id` = ?, `raw_summary` = ? WHERE `conversation_id` = ?'
      );

      for (const rawConv of conversations) {
        const existing = existingMap.get(rawConv.conversation_id);
        const conv = transformRow ? transformRow({ ...rawConv }, existing) : { ...rawConv };

        const adaptedWorkspaceUris = expandPaths(conv.workspace_uris || '', targetHome, sourceHome, customMappings);
        const adaptedProjectId = expandPaths(conv.project_id || '', targetHome, sourceHome, customMappings);

        if (!existing) {
          const values = getColumnValues(conv, columns, adaptedWorkspaceUris, adaptedProjectId, colMetaMap);
          insertStmt.run(...values);
          added++;
        } else {
          // Never overwrite an existing non-empty title with an empty string
          if (!conv.title && existing.title) {
            conv.title = existing.title;
          }

          const remoteTime = parseTimestampMs(conv.last_modified_time);
          const localTime = parseTimestampMs(existing.last_modified_time);
          const isNewer =
            (Number.isFinite(remoteTime) && (!Number.isFinite(localTime) || remoteTime > localTime)) ||
            (conv.step_count || 0) > (existing.step_count || 0);
          const needsTitleHeal = !existing.title && Boolean(conv.title);
          const needsVisibilitySync = Boolean(options.syncVisibility) && (
            (existing.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' && conv.source === '') ||
            (adaptedProjectId && adaptedProjectId !== 'default-cli-project' && (
              existing.project_id === 'default-cli-project' ||
              (existing.project_id === 'outside-of-project' && adaptedProjectId !== 'outside-of-project')
            ))
          );

          if (isNewer && updateStmt) {
            const values = getColumnValues(conv, updateCols, adaptedWorkspaceUris, adaptedProjectId, colMetaMap);
            values.push(conv.conversation_id);
            updateStmt.run(...values);
            updated++;
          } else if (needsVisibilitySync) {
            const effectiveTitle = existing.title || conv.title || '';
            const baseRaw = existing.raw_summary || conv.raw_summary || null;
            const patchedRaw = baseRaw ? patchRawSummaryBlob(baseRaw, { source: conv.source, title: effectiveTitle }) : null;
            syncVisibilityStmt.run(effectiveTitle, conv.source, adaptedProjectId, patchedRaw, conv.conversation_id);
            updated++;
          } else if (needsTitleHeal) {
            const baseRaw = existing.raw_summary || conv.raw_summary || null;
            const patchedRaw = baseRaw ? patchRawSummaryBlob(baseRaw, { source: existing.source, title: conv.title }) : null;
            healTitleStmt.run(conv.title, patchedRaw, conv.conversation_id);
            updated++;
          } else {
            skipped++;
          }
        }
      }
    }

    if (parents.length > 0 && tableExists(db, 'conversation_parents')) {
      const parentStmt = db.prepare(
        'INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET parent_id = excluded.parent_id'
      );
      for (const p of parents) {
        if (p?.conversation_id && p?.parent_id) {
          parentStmt.run(p.conversation_id, p.parent_id);
          parentsMerged++;
        }
      }
    }

    db.exec('COMMIT');
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
    return {
      added,
      updated,
      skipped,
      total: conversations.length,
      parentsMerged
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}
