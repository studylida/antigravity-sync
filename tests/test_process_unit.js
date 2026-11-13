import { parseWindowsTasklistCsv, parsePosixProcessList } from '../src/process.js';
import { TOOL_VERSION, SYNC_SCHEMA_VERSION } from '../src/version.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

// 1. Windows tasklist CSV parsing
const winSample = [
  '"System Idle Process","0","Services","0","8 K"',
  '"Antigravity.exe","12345","Console","1","250,000 K"',
  '"agy.exe","23456","Console","1","48,000 K"',
  '"agy-sync.exe","34567","Console","1","12,000 K"'
].join('\r\n');

const winNames = new Set(parseWindowsTasklistCsv(winSample));
assert.strictEqual(winNames.has('antigravity.exe'), true);
assert.strictEqual(winNames.has('agy.exe'), true);
assert.strictEqual(winNames.has('agy-sync.exe'), true);

// Ensure non-matching output does not false-positive
const winClean = new Set(parseWindowsTasklistCsv('"node.exe","999","Console","1","10,000 K"'));
assert.strictEqual(winClean.has('antigravity.exe'), false);
assert.strictEqual(winClean.has('agy.exe'), false);

// 2. POSIX ps parsing
const posixSample = [
  '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
  '/usr/local/bin/agy',
  'agy-sync'
].join('\n');
const posixNames = parsePosixProcessList(posixSample);
assert.strictEqual(posixNames.includes('antigravity'), true);
assert.strictEqual(posixNames.includes('agy'), true);
assert.strictEqual(posixNames.filter(n => n === 'agy').length, 1);

// 3. Version consistency with package.json
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
assert.strictEqual(TOOL_VERSION, pkg.version);
assert.strictEqual(SYNC_SCHEMA_VERSION, 2);
assert(/^\d+\.\d+\.\d+$/.test(TOOL_VERSION), 'TOOL_VERSION must follow SemVer MAJOR.MINOR.PATCH');

console.log('All process.js and version.js unit tests passed successfully! 🎉');
