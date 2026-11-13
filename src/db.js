import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { templatizePaths, expandPaths } from './path_utils.js';

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

  const db = new DatabaseSync(dbPath);
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
    db.close();
  }
}

function getColumnValues(row, columns, adaptedWorkspaceUris, adaptedProjectId) {
  return columns.map(c => {
    if (c === 'workspace_uris') return adaptedWorkspaceUris;
    if (c === 'project_id') return adaptedProjectId;
    if (c === 'raw_summary' && typeof row[c] === 'string') {
      return Buffer.from(row[c], 'base64');
    }
    return row[c] ?? null;
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
      .prepare('SELECT conversation_id, last_modified_time, step_count, app_data_dir, source FROM conversation_summaries')
      .all();
    const existingMap = new Map(existingRows.map(r => [r.conversation_id, r]));

    const conversations = indexData.conversations || [];
    const tableColumns = db.prepare('PRAGMA table_info(conversation_summaries)').all().map(col => col.name);
    const validColSet = new Set(tableColumns);

    db.exec('BEGIN TRANSACTION');

    if (conversations.length > 0) {
      const sample = conversations[0];
      const columns = Object.keys(sample).filter(c => validColSet.has(c));
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

      for (const rawConv of conversations) {
        const existing = existingMap.get(rawConv.conversation_id);
        const conv = transformRow ? transformRow({ ...rawConv }, existing) : rawConv;

        const adaptedWorkspaceUris = expandPaths(conv.workspace_uris || '', targetHome, sourceHome, customMappings);
        const adaptedProjectId = expandPaths(conv.project_id || '', targetHome, sourceHome, customMappings);

        if (!existing) {
          const values = getColumnValues(conv, columns, adaptedWorkspaceUris, adaptedProjectId);
          insertStmt.run(...values);
          added++;
        } else {
          const remoteTime = new Date(conv.last_modified_time).getTime();
          const localTime = new Date(existing.last_modified_time).getTime();
          const isNewer =
            (Number.isFinite(remoteTime) && Number.isFinite(localTime) && remoteTime > localTime) ||
            (conv.step_count || 0) > (existing.step_count || 0);

          if (isNewer && updateStmt) {
            const values = getColumnValues(conv, updateCols, adaptedWorkspaceUris, adaptedProjectId);
            values.push(conv.conversation_id);
            updateStmt.run(...values);
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
