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

/**
 * Compares two conversation summary records by timestamp first, then step_count.
 * Returns 1 if `a` is strictly newer, -1 if `b` is strictly newer, or 0 if equal.
 */
export function compareConversationFreshness(a, b) {
  if (!a && !b) return 0;
  if (a && !b) return 1;
  if (!a && b) return -1;

  const aTime = parseTimestampMs(a.last_modified_time);
  const bTime = parseTimestampMs(b.last_modified_time);
  const aHasTime = Number.isFinite(aTime);
  const bHasTime = Number.isFinite(bTime);

  if (aHasTime && bHasTime && aTime !== bTime) {
    return aTime > bTime ? 1 : -1;
  }
  if (aHasTime !== bHasTime) {
    return aHasTime ? 1 : -1;
  }

  const aSteps = Number(a.step_count || 0);
  const bSteps = Number(b.step_count || 0);
  if (aSteps !== bSteps) {
    return aSteps > bSteps ? 1 : -1;
  }
  return 0;
}

function normalizeRemoteTemplatizedRow(row, remoteSourceHome) {
  if (!row || typeof row !== 'object') return row;
  if (!remoteSourceHome) return { ...row };
  const copy = { ...row };
  if (copy.workspace_uris) {
    copy.workspace_uris = templatizePaths(copy.workspace_uris, remoteSourceHome);
  }
  if (copy.project_id) {
    copy.project_id = templatizePaths(copy.project_id, remoteSourceHome);
  }
  return copy;
}

/**
 * Non-destructively merges a newly exported local conversations index with an existing
 * sync repository conversations index so remote-only or remote-newer entries are preserved.
 */
export function mergeConversationIndexes(localIndexData, existingSyncIndexData) {
  const localConvs = Array.isArray(localIndexData?.conversations) ? localIndexData.conversations : [];
  const remoteConvs = Array.isArray(existingSyncIndexData?.conversations) ? existingSyncIndexData.conversations : [];
  const remoteSourceHome = existingSyncIndexData?.sourceHomeDir || '';

  const localMap = new Map(localConvs.filter(c => c?.conversation_id).map(c => [c.conversation_id, { ...c }]));
  const remoteMap = new Map(
    remoteConvs
      .filter(c => c?.conversation_id)
      .map(c => [c.conversation_id, normalizeRemoteTemplatizedRow(c, remoteSourceHome)])
  );

  const mergedConversations = [];
  const localOnlyIds = new Set();
  const localNewerIds = new Set();
  const equalIds = new Set();
  const remoteNewerIds = new Set();
  const remoteOnlyIds = new Set();

  for (const [id, local] of localMap) {
    const remote = remoteMap.get(id);
    if (!remote) {
      localOnlyIds.add(id);
      mergedConversations.push(local);
      continue;
    }

    const cmp = compareConversationFreshness(local, remote);
    if (cmp > 0) {
      localNewerIds.add(id);
      const winner = { ...local };
      if (!winner.title && remote.title) {
        winner.title = remote.title;
        if (winner.raw_summary) {
          const patched = patchRawSummaryBlob(winner.raw_summary, { title: winner.title });
          winner.raw_summary = Buffer.isBuffer(patched) ? patched.toString('base64') : winner.raw_summary;
        }
      }
      mergedConversations.push(winner);
    } else if (cmp < 0) {
      remoteNewerIds.add(id);
      const winner = { ...remote };
      if (!winner.title && local.title) {
        winner.title = local.title;
        if (winner.raw_summary) {
          const patched = patchRawSummaryBlob(winner.raw_summary, { title: winner.title });
          winner.raw_summary = Buffer.isBuffer(patched) ? patched.toString('base64') : winner.raw_summary;
        }
      }
      mergedConversations.push(winner);
    } else {
      equalIds.add(id);
      const winner = { ...local };
      if (!winner.title && remote.title) {
        winner.title = remote.title;
      }
      // Preserve clean Desktop sidebar visibility if existing sync already mapped it cleanly
      if (winner.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' && remote.source === '') {
        winner.source = '';
        if (remote.project_id && remote.project_id !== 'default-cli-project') {
          winner.project_id = remote.project_id;
        }
      }
      if (winner.raw_summary && (winner.title !== local.title || winner.source !== local.source || winner.project_id !== local.project_id)) {
        const patched = patchRawSummaryBlob(winner.raw_summary, {
          source: winner.source,
          title: winner.title,
          projectId: winner.project_id
        });
        winner.raw_summary = Buffer.isBuffer(patched) ? patched.toString('base64') : winner.raw_summary;
      }
      mergedConversations.push(winner);
    }
  }

  for (const [id, remote] of remoteMap) {
    if (!localMap.has(id)) {
      remoteOnlyIds.add(id);
      mergedConversations.push(remote);
    }
  }

  mergedConversations.sort((a, b) => {
    const cmp = compareConversationFreshness(b, a);
    if (cmp !== 0) return cmp;
    return String(a.conversation_id).localeCompare(String(b.conversation_id));
  });

  const parentMap = new Map();
  for (const p of existingSyncIndexData?.parents || []) {
    if (p?.conversation_id && p?.parent_id) parentMap.set(p.conversation_id, p.parent_id);
  }
  for (const p of localIndexData?.parents || []) {
    if (p?.conversation_id && p?.parent_id) parentMap.set(p.conversation_id, p.parent_id);
  }
  const mergedParents = Array.from(parentMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([conversation_id, parent_id]) => ({ conversation_id, parent_id }));

  return {
    indexData: {
      version: localIndexData?.version || existingSyncIndexData?.version || 2,
      sourceHomeDir: localIndexData?.sourceHomeDir || existingSyncIndexData?.sourceHomeDir || os.homedir(),
      exportedAt: localIndexData?.exportedAt || new Date().toISOString(),
      conversations: mergedConversations,
      parents: mergedParents
    },
    localOnlyIds,
    localNewerIds,
    equalIds,
    remoteNewerIds,
    remoteOnlyIds
  };
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
      return patchRawSummaryBlob(row[c], { source: row.source, title: row.title, projectId: adaptedProjectId });
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
  const decisions = options.decisions && typeof options.decisions === 'object' ? options.decisions : null;
  if (decisions) {
    if (!decisions.addedIds) decisions.addedIds = new Set();
    if (!decisions.updatedIds) decisions.updatedIds = new Set();
    if (!decisions.localNewerIds) decisions.localNewerIds = new Set();
    if (!decisions.equalIds) decisions.equalIds = new Set();
  }

  try {
    const existingRows = db
      .prepare('SELECT conversation_id, title, last_modified_time, step_count, workspace_uris, app_data_dir, source, project_id, raw_summary FROM conversation_summaries')
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
          if (decisions) decisions.addedIds.add(conv.conversation_id);
        } else {
          // Never overwrite an existing non-empty title with an empty string
          if (!conv.title && existing.title) {
            conv.title = existing.title;
          }

          const cmp = compareConversationFreshness(conv, existing);
          const isNewer = cmp > 0;
          if (cmp < 0 && decisions) {
            decisions.localNewerIds.add(conv.conversation_id);
          } else if (cmp === 0 && decisions) {
            decisions.equalIds.add(conv.conversation_id);
          }

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
            if (decisions) decisions.updatedIds.add(conv.conversation_id);
          } else if (needsVisibilitySync) {
            const effectiveTitle = existing.title || conv.title || '';
            const baseRaw = existing.raw_summary || conv.raw_summary || null;
            const patchedRaw = baseRaw ? patchRawSummaryBlob(baseRaw, { source: conv.source, title: effectiveTitle, projectId: adaptedProjectId }) : null;
            syncVisibilityStmt.run(effectiveTitle, conv.source, adaptedProjectId, patchedRaw, conv.conversation_id);
            updated++;
          } else if (needsTitleHeal) {
            const baseRaw = existing.raw_summary || conv.raw_summary || null;
            const patchedRaw = baseRaw ? patchRawSummaryBlob(baseRaw, { source: existing.source, title: conv.title, projectId: existing.project_id }) : null;
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
