import fs from 'node:fs';

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));

export const TOOL_VERSION = pkg.version || '2.0.0';
export const SYNC_SCHEMA_VERSION = 2;
