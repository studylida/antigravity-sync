import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getDefaultAntigravityDir() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity');
}

export function getConfigDir() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.antigravity-sync');
}

export function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

export function getDefaultSyncDir() {
  return path.join(getConfigDir(), 'sync-data');
}

export function getDefaultBackupDir() {
  return path.join(getConfigDir(), 'backups');
}

export function getDefaultProjectsDir() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'config', 'projects');
}

export function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return {
      antigravityDir: getDefaultAntigravityDir(),
      projectsDir: getDefaultProjectsDir(),
      syncDir: getDefaultSyncDir(),
      backupDir: getDefaultBackupDir(),
      gitRemote: '',
      autoPush: true,
      configured: false
    };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const data = JSON.parse(raw);
    return {
      antigravityDir: data.antigravityDir || getDefaultAntigravityDir(),
      projectsDir: data.projectsDir || getDefaultProjectsDir(),
      syncDir: data.syncDir || getDefaultSyncDir(),
      backupDir: data.backupDir || getDefaultBackupDir(),
      gitRemote: data.gitRemote || '',
      autoPush: data.autoPush !== false,
      configured: true
    };
  } catch (err) {
    console.error('[Config] Failed to read config file:', err.message);
    return {
      antigravityDir: getDefaultAntigravityDir(),
      projectsDir: getDefaultProjectsDir(),
      syncDir: getDefaultSyncDir(),
      backupDir: getDefaultBackupDir(),
      gitRemote: '',
      autoPush: true,
      configured: false
    };
  }
}

export function saveConfig(cfg) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}
