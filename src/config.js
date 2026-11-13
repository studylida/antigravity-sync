import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function getHomeDir() {
  return process.env.USERPROFILE || os.homedir();
}

export function getDefaultDesktopDir() {
  return path.join(getHomeDir(), '.gemini', 'antigravity');
}

export function getDefaultAntigravityDir() {
  return getDefaultDesktopDir();
}

export function getDefaultCliDir() {
  return path.join(getHomeDir(), '.gemini', 'antigravity-cli');
}

export function getDefaultGeminiConfigDir() {
  return path.join(getHomeDir(), '.gemini', 'config');
}

export function getDefaultProjectsDir() {
  return path.join(getDefaultGeminiConfigDir(), 'projects');
}

export function getConfigDir() {
  return path.join(getHomeDir(), '.antigravity-sync');
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

function buildDefaultConfig(overrides = {}, configured = false) {
  const desktopDir = overrides.desktopDir || overrides.antigravityDir || getDefaultDesktopDir();
  const geminiConfigDir = overrides.geminiConfigDir || getDefaultGeminiConfigDir();
  const projectsDir = overrides.projectsDir || path.join(geminiConfigDir, 'projects');
  const rawTargets = overrides.targets || {};

  return {
    configVersion: 2,
    desktopDir,
    antigravityDir: desktopDir,
    cliDir: overrides.cliDir || getDefaultCliDir(),
    geminiConfigDir,
    projectsDir,
    syncDir: overrides.syncDir || getDefaultSyncDir(),
    backupDir: overrides.backupDir || getDefaultBackupDir(),
    gitRemote: overrides.gitRemote || '',
    autoPush: overrides.autoPush !== false,
    targets: {
      desktop: rawTargets.desktop !== false,
      cli: rawTargets.cli !== false,
      config: rawTargets.config !== false
    },
    configured
  };
}

export function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return buildDefaultConfig({}, false);
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const data = JSON.parse(raw);
    return buildDefaultConfig(data, data.configured !== false);
  } catch (err) {
    console.error('[Config] Failed to read config file:', err.message);
    return buildDefaultConfig({}, false);
  }
}

export function saveConfig(cfg) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const normalized = buildDefaultConfig(cfg, cfg.configured !== false);
  fs.writeFileSync(getConfigPath(), JSON.stringify(normalized, null, 2), 'utf8');
}
