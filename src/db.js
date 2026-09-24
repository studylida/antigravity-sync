import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const CONVERSATION_SUMMARIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`conversation_summaries\` (
  \`conversation_id\` text,
  \`title\` text NOT NULL DEFAULT "",
  \`preview\` text NOT NULL DEFAULT "",
  \`step_count\` integer NOT NULL DEFAULT 0,
  \`last_modified_time\` datetime NOT NULL,
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

/**
 * Ensures the conversation_summaries.db file exists with valid schema.
 */
export function ensureSummariesDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(CONVERSATION_SUMMARIES_SCHEMA);
  db.close();
}

/**
 * Exports all conversations from conversation_summaries.db to a serializable JS object.
 */
export function exportSummaries(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations: []
    };
  }

  const db = new DatabaseSync(dbPath);
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").get();
    if (!tableExists) {
      return { version: 1, exportedAt: new Date().toISOString(), conversations: [] };
    }

    const rows = db.prepare("SELECT * FROM conversation_summaries ORDER BY last_modified_time DESC").all();
    const conversations = rows.map(r => {
      const item = { ...r };
      if (item.raw_summary instanceof Uint8Array || Buffer.isBuffer(item.raw_summary)) {
        item.raw_summary = Buffer.from(item.raw_summary).toString('base64');
      }
      return item;
    });

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations
    };
  } finally {
    db.close();
  }
}

/**
 * Merges conversations from an exported index into local conversation_summaries.db.
 * @param {string} dbPath - Path to local conversation_summaries.db
 * @param {object} indexData - Exported index object containing `conversations` array
 * @param {object} options - Options: { pathMapping: { from: string, to: string } }
 * @returns {{ added: number, updated: number, skipped: number, total: number }}
 */
export function importAndMergeSummaries(dbPath, indexData, options = {}) {
  ensureSummariesDb(dbPath);

  const db = new DatabaseSync(dbPath);
  let added = 0;
  let updated = 0;
  let skipped = 0;

  try {
    const existingRows = db.prepare("SELECT conversation_id, last_modified_time, step_count FROM conversation_summaries").all();
    const existingMap = new Map();
    for (const r of existingRows) {
      existingMap.set(r.conversation_id, r);
    }

    const conversations = indexData.conversations || [];
    if (conversations.length === 0) {
      return { added: 0, updated: 0, skipped: 0, total: 0 };
    }

    const sample = conversations[0];
    const columns = Object.keys(sample);
    const placeholders = columns.map(() => '?').join(', ');
    const updateClauses = columns.filter(c => c !== 'conversation_id').map(c => `\`${c}\` = ?`).join(', ');

    const insertStmt = db.prepare(`INSERT INTO conversation_summaries (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`);
    const updateStmt = db.prepare(`UPDATE conversation_summaries SET ${updateClauses} WHERE \`conversation_id\` = ?`);

    db.exec('BEGIN TRANSACTION');

    for (const conv of conversations) {
      let workspaceUris = conv.workspace_uris || '';
      if (options.pathMapping && options.pathMapping.from && options.pathMapping.to) {
        workspaceUris = workspaceUris.replaceAll(options.pathMapping.from, options.pathMapping.to);
      }

      const existing = existingMap.get(conv.conversation_id);

      if (!existing) {
        // Insert new conversation
        const values = columns.map(c => {
          if (c === 'workspace_uris') return workspaceUris;
          if (c === 'raw_summary' && typeof conv[c] === 'string') {
            return Buffer.from(conv[c], 'base64');
          }
          return conv[c] ?? null;
        });
        insertStmt.run(...values);
        added++;
      } else {
        // Compare modification time or step_count
        const remoteTime = new Date(conv.last_modified_time).getTime();
        const localTime = new Date(existing.last_modified_time).getTime();

        if (remoteTime > localTime || (conv.step_count || 0) > (existing.step_count || 0)) {
          const updateCols = columns.filter(c => c !== 'conversation_id');
          const values = updateCols.map(c => {
            if (c === 'workspace_uris') return workspaceUris;
            if (c === 'raw_summary' && typeof conv[c] === 'string') {
              return Buffer.from(conv[c], 'base64');
            }
            return conv[c] ?? null;
          });
          values.push(conv.conversation_id);
          updateStmt.run(...values);
          updated++;
        } else {
          skipped++;
        }
      }
    }

    db.exec('COMMIT');
    return { added, updated, skipped, total: conversations.length };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}
