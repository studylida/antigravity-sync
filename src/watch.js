import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfigDir } from './config.js';
import { getRunningProcesses } from './process.js';
import { bridgeLocalClients } from './bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_ENTRY_PATH = path.resolve(__dirname, '..', 'bin', 'agy-sync.js');

export function getWatchPaths() {
  const configDir = getConfigDir();
  const startupDir = os.platform() === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    : null;
  return {
    configDir,
    pidPath: path.join(configDir, 'watch.pid'),
    logPath: path.join(configDir, 'watch.log'),
    lockPath: path.join(configDir, 'watch.lock'),
    startupScriptPath: startupDir ? path.join(startupDir, 'antigravity-sync-watch.vbs') : null
  };
}

function statSignature(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return '0';
  }
}

function dirDbSignature(convsDir) {
  if (!convsDir || !fs.existsSync(convsDir)) return '0:0';
  let count = 0;
  let maxMtime = 0;
  try {
    for (const entry of fs.readdirSync(convsDir)) {
      if (!entry.endsWith('.db')) continue;
      count++;
      try {
        const m = fs.statSync(path.join(convsDir, entry)).mtimeMs;
        if (m > maxMtime) maxMtime = m;
      } catch {}
    }
  } catch {
    return '0:0';
  }
  return `${count}:${Math.trunc(maxMtime)}`;
}

/**
 * Lightweight filesystem mtime/size fingerprint of Desktop & CLI DB files.
 * Never opens SQLite connections while Antigravity processes are active.
 */
export function computeClientFingerprint(desktopDir, cliDir) {
  const parts = [
    statSignature(path.join(desktopDir, 'conversation_summaries.db')),
    statSignature(path.join(desktopDir, 'conversation_summaries.db-wal')),
    dirDbSignature(path.join(desktopDir, 'conversations')),
    statSignature(path.join(cliDir, 'conversation_summaries.db')),
    statSignature(path.join(cliDir, 'conversation_summaries.db-wal')),
    dirDbSignature(path.join(cliDir, 'conversations'))
  ];
  return parts.join('|');
}

/**
 * Pure state-machine controller for safely bridging Desktop <-> CLI when neither process is running.
 */
export function createWatchController({
  cfg,
  settleMs = 2000,
  deps = {},
  onLog = () => {}
} = {}) {
  const getRunningFn = deps.getRunningProcesses || getRunningProcesses;
  const fingerprintFn = deps.computeClientFingerprint || (() => computeClientFingerprint(cfg.desktopDir, cfg.cliDir));
  const bridgeFn = deps.bridgeLocalClients || ((c) => bridgeLocalClients(c, { direction: 'both' }));
  const nowFn = deps.now || (() => Date.now());

  let lastSyncedFingerprint = null;
  let sawActiveProcess = false;
  let idleSinceMs = null;
  let initialized = false;
  let bridging = false;

  function step() {
    if (bridging) {
      return { action: 'busy_lock' };
    }

    const running = getRunningFn();
    const fp = fingerprintFn();

    if (running.desktop || running.cli) {
      sawActiveProcess = true;
      idleSinceMs = null;
      initialized = true;
      return { action: 'active', running };
    }

    if (!initialized) {
      // On cold start while both apps are closed, run one guarded bridge if files exist
      initialized = true;
      idleSinceMs = nowFn();
      if (!lastSyncedFingerprint) {
        bridging = true;
        try {
          const res = bridgeFn(cfg);
          lastSyncedFingerprint = fingerprintFn();
          sawActiveProcess = false;
          idleSinceMs = null;
          onLog(`[Watch] Initial sync check complete (CLI->Desk: +${res.cliToDesktop?.mergeStats?.added || 0}/~${res.cliToDesktop?.mergeStats?.updated || 0}, Desk->CLI: +${res.desktopToCli?.mergeStats?.added || 0}/~${res.desktopToCli?.mergeStats?.updated || 0}, cleaned=${res.cleanedCliDbCount || 0})`);
          return { action: 'bridged', result: res };
        } finally {
          bridging = false;
        }
      }
    }

    if (!sawActiveProcess && fp === lastSyncedFingerprint) {
      return { action: 'idle' };
    }

    const now = nowFn();
    if (idleSinceMs === null) {
      idleSinceMs = now;
      return { action: 'settling' };
    }
    if (now - idleSinceMs < settleMs) {
      return { action: 'settling' };
    }

    // Re-check process table right before touching any DB
    const confirmRunning = getRunningFn();
    if (confirmRunning.desktop || confirmRunning.cli) {
      sawActiveProcess = true;
      idleSinceMs = null;
      return { action: 'active', running: confirmRunning };
    }

    if (fp === lastSyncedFingerprint) {
      sawActiveProcess = false;
      idleSinceMs = null;
      return { action: 'unchanged' };
    }

    bridging = true;
    try {
      const res = bridgeFn(cfg);
      lastSyncedFingerprint = fingerprintFn();
      sawActiveProcess = false;
      idleSinceMs = null;
      onLog(`[Watch] Auto-bridged after process exit (CLI->Desk: +${res.cliToDesktop?.mergeStats?.added || 0}/~${res.cliToDesktop?.mergeStats?.updated || 0}, Desk->CLI: +${res.desktopToCli?.mergeStats?.added || 0}/~${res.desktopToCli?.mergeStats?.updated || 0}, cleaned=${res.cleanedCliDbCount || 0})`);
      return { action: 'bridged', result: res };
    } finally {
      bridging = false;
    }
  }

  return {
    step,
    getState: () => ({ lastSyncedFingerprint, sawActiveProcess, idleSinceMs, initialized })
  };
}

export function isPidRunning(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readWatchPid(pidPath = getWatchPaths().pidPath) {
  if (!fs.existsSync(pidPath)) return null;
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function getWatchStatus() {
  const paths = getWatchPaths();
  const pid = readWatchPid(paths.pidPath);
  const running = Boolean(pid && isPidRunning(pid));
  if (pid && !running) {
    try { fs.rmSync(paths.pidPath, { force: true }); } catch {}
  }
  const autoStartInstalled = Boolean(paths.startupScriptPath && fs.existsSync(paths.startupScriptPath));
  let recentLogs = [];
  if (fs.existsSync(paths.logPath)) {
    try {
      recentLogs = fs.readFileSync(paths.logPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-10);
    } catch {}
  }
  return {
    running,
    pid: running ? pid : null,
    autoStartInstalled,
    startupScriptPath: paths.startupScriptPath,
    logPath: paths.logPath,
    recentLogs
  };
}

export function startWatchDaemon(intervalMs = 3000) {
  const status = getWatchStatus();
  if (status.running) {
    return { started: false, alreadyRunning: true, pid: status.pid, logPath: status.logPath };
  }
  const paths = getWatchPaths();
  fs.mkdirSync(paths.configDir, { recursive: true });
  const logFd = fs.openSync(paths.logPath, 'a');
  const child = spawn(
    process.execPath,
    [BIN_ENTRY_PATH, 'watch', '--interval', String(intervalMs)],
    {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd]
    }
  );
  child.unref();
  try { fs.closeSync(logFd); } catch {}
  if (child.pid) {
    fs.writeFileSync(paths.pidPath, String(child.pid), 'utf8');
  }
  return { started: true, alreadyRunning: false, pid: child.pid, logPath: paths.logPath };
}

export function stopWatchDaemon() {
  const paths = getWatchPaths();
  const pid = readWatchPid(paths.pidPath);
  if (!pid || !isPidRunning(pid)) {
    try { fs.rmSync(paths.pidPath, { force: true }); } catch {}
    return { stopped: false, reason: 'not_running' };
  }
  try {
    if (os.platform() === 'win32') {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    try { process.kill(pid); } catch {}
  }
  try { fs.rmSync(paths.pidPath, { force: true }); } catch {}
  return { stopped: true, pid };
}

export function installWatchAutoStart() {
  if (os.platform() !== 'win32') {
    throw new Error('현재 로그인 시 자동 등록(--install)은 Windows Startup 폴더만 지원합니다. macOS/Linux에서는 "agy-sync watch --daemon"을 사용하세요.');
  }
  const paths = getWatchPaths();
  fs.mkdirSync(path.dirname(paths.startupScriptPath), { recursive: true });
  const cmd = `"${process.execPath}" "${BIN_ENTRY_PATH}" watch --daemon`;
  const vbs = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${cmd.replace(/"/g, '""')}", 0, False`,
    ''
  ].join('\r\n');
  fs.writeFileSync(paths.startupScriptPath, vbs, 'utf8');
  const daemonRes = startWatchDaemon();
  return { startupScriptPath: paths.startupScriptPath, daemon: daemonRes };
}

export function uninstallWatchAutoStart() {
  const paths = getWatchPaths();
  let removedStartup = false;
  if (paths.startupScriptPath && fs.existsSync(paths.startupScriptPath)) {
    fs.rmSync(paths.startupScriptPath, { force: true });
    removedStartup = true;
  }
  const stopRes = stopWatchDaemon();
  return { removedStartup, stoppedDaemon: stopRes.stopped, pid: stopRes.pid || null };
}
