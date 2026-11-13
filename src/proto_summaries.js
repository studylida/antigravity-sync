import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROTO_CACHE_FILENAMES = ['agyhub_summaries_proto.pb', 'jetbox_summaries_proto.pb'];

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [val, i];
}

function parseProtoFields(buf) {
  const b = Buffer.from(buf);
  const fields = [];
  let i = 0;
  while (i < b.length) {
    const [tag, ni] = readVarint(b, i);
    i = ni;
    const fn = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 0) {
      const [val, vi] = readVarint(b, i);
      i = vi;
      fields.push({ fn, wt, val });
    } else if (wt === 2) {
      const [len, li] = readVarint(b, i);
      i = li;
      const n = Number(len);
      const slice = b.subarray(i, i + n);
      i += n;
      fields.push({ fn, wt, val: slice });
    } else if (wt === 1) {
      i += 8;
      fields.push({ fn, wt });
    } else if (wt === 5) {
      i += 4;
      fields.push({ fn, wt });
    } else {
      break;
    }
  }
  return fields;
}

function encodeVarint(num) {
  let n = typeof num === 'bigint' ? num : BigInt(num);
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeTag(fn, wt) {
  return encodeVarint((BigInt(fn) << 3n) | BigInt(wt));
}

function encodeVarintField(fn, num) {
  return Buffer.concat([encodeTag(fn, 0), encodeVarint(num)]);
}

function encodeBytesField(fn, buf) {
  const b = Buffer.from(buf);
  return Buffer.concat([encodeTag(fn, 2), encodeVarint(b.length), b]);
}

/**
 * Decodes existing agyhub_summaries_proto.pb / jetbox_summaries_proto.pb into maps.
 */
export function readProtoSummaryCache(protoPath) {
  const summaries = new Map();
  const timestamps = new Map();
  if (!fs.existsSync(protoPath)) {
    return { summaries, timestamps };
  }
  const buf = fs.readFileSync(protoPath);
  for (const field of parseProtoFields(buf)) {
    if (field.wt !== 2) continue;
    const sub = parseProtoFields(field.val);
    const idField = sub.find(f => f.fn === 1 && f.wt === 2);
    if (!idField) continue;
    const id = Buffer.from(idField.val).toString('utf8');
    if (field.fn === 1) {
      const summaryField = sub.find(f => f.fn === 2 && f.wt === 2);
      if (summaryField) {
        summaries.set(id, Buffer.from(summaryField.val));
      }
    } else if (field.fn === 2) {
      const tsField = sub.find(f => f.fn === 2 && f.wt === 0);
      if (tsField) {
        timestamps.set(id, Number(tsField.val));
      }
    }
  }
  return { summaries, timestamps };
}

/**
 * Encodes summary blobs and timestamps into the agyhub/jetbox protobuf cache format.
 */
export function writeProtoSummaryCache(protoPath, summariesMap, timestampsMap) {
  const chunks = [];
  for (const [id, rawSummary] of summariesMap.entries()) {
    if (!rawSummary || rawSummary.length === 0) continue;
    const entry = Buffer.concat([
      encodeBytesField(1, Buffer.from(id, 'utf8')),
      encodeBytesField(2, rawSummary)
    ]);
    chunks.push(encodeBytesField(1, entry));
  }
  for (const [id, tsSec] of timestampsMap.entries()) {
    if (!Number.isFinite(tsSec)) continue;
    const entry = Buffer.concat([
      encodeBytesField(1, Buffer.from(id, 'utf8')),
      encodeVarintField(2, Math.trunc(tsSec))
    ]);
    chunks.push(encodeBytesField(2, entry));
  }
  const tmpPath = `${protoPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, Buffer.concat(chunks));
  fs.renameSync(tmpPath, protoPath);
}

/**
 * Synchronizes existing proto summary cache files in clientDir from conversation_summaries.db
 * so Antigravity Desktop/CLI startup reconciliation does not overwrite SQLite summaries with stale proto cache entries.
 */
export function syncClientProtoSummaries(clientDir, summaryDbPath) {
  if (!clientDir || !fs.existsSync(clientDir) || !summaryDbPath || !fs.existsSync(summaryDbPath)) {
    return 0;
  }

  const targetProtoFiles = PROTO_CACHE_FILENAMES
    .map(name => path.join(clientDir, name))
    .filter(p => fs.existsSync(p));

  if (targetProtoFiles.length === 0) {
    return 0;
  }

  const db = new DatabaseSync(summaryDbPath, { readOnly: true });
  let rows = [];
  try {
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'conversation_summaries'").get();
    if (!hasTable) return 0;
    rows = db.prepare('SELECT conversation_id, raw_summary, last_modified_time FROM conversation_summaries').all();
  } finally {
    db.close();
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let syncedFiles = 0;

  for (const protoPath of targetProtoFiles) {
    const { summaries, timestamps } = readProtoSummaryCache(protoPath);
    for (const row of rows) {
      const id = row.conversation_id;
      if (!id) continue;
      if (row.raw_summary instanceof Uint8Array || Buffer.isBuffer(row.raw_summary)) {
        const buf = Buffer.from(row.raw_summary);
        if (buf.length > 0) {
          summaries.set(id, buf);
          timestamps.set(id, nowSec);
        }
      }
    }
    writeProtoSummaryCache(protoPath, summaries, timestamps);
    syncedFiles++;
  }

  return syncedFiles;
}

export { PROTO_CACHE_FILENAMES };
