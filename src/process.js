import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Parses `tasklist /FO CSV /NH` output into lowercased image names.
 */
export function parseWindowsTasklistCsv(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];
  const names = [];
  for (const line of csvText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^"([^"]+)"/);
    if (match) {
      names.push(match[1].toLowerCase());
    }
  }
  return names;
}

/**
 * Parses `ps -eo comm` output into lowercased command basenames.
 */
export function parsePosixProcessList(psText) {
  if (!psText || typeof psText !== 'string') return [];
  return psText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(comm => path.basename(comm).toLowerCase());
}

/**
 * Inspects running Windows language_server.exe instances to classify orphaned
 * Antigravity Desktop vs CLI sidecars holding SQLite DB locks.
 */
export function getWindowsLanguageServerPids() {
  const result = { desktopPids: [], cliPids: [] };
  if (os.platform() !== 'win32') return result;

  try {
    const psCmd = "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    }).trim();
    if (!out) return result;

    const parsed = JSON.parse(out);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const cmd = (item?.CommandLine || '').toLowerCase();
      const pid = Number(item?.ProcessId);
      if (!pid || !cmd) continue;
      if (/--app_data_dir[=\s]+["']?[^"'\s]*antigravity-cli\b/.test(cmd)) {
        result.cliPids.push(pid);
      } else if (/--app_data_dir[=\s]+["']?[^"'\s]*antigravity\b/.test(cmd)) {
        result.desktopPids.push(pid);
      }
    }
  } catch {
    // Ignore PowerShell/CIM failures
  }
  return result;
}

/**
 * Returns lowercased ancestor process names for the current process, so we can avoid
 * terminating the terminal host we are currently running inside.
 */
export function getAncestorProcessNames() {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      const psCmd = `$m=@{}; Get-CimInstance Win32_Process | ForEach-Object { $m[[int]$_.ProcessId]=@([int]$_.ParentProcessId,$_.Name) }; $cur=${process.pid}; $res=@(); for($i=0;$i-lt 24;$i++){ if(-not $m.ContainsKey($cur)){break}; $p=$m[$cur][0]; if(-not $m.ContainsKey($p)){break}; $res+=$m[$p][1]; if($p -eq $cur){break}; $cur=$p }; $res | ConvertTo-Json -Compress`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim();
      if (!out) return [];
      const parsed = JSON.parse(out);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.filter(Boolean).map(n => String(n).toLowerCase());
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      });
      const procMap = new Map();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (m) procMap.set(Number(m[1]), { ppid: Number(m[2]), comm: path.basename(m[3].trim()).toLowerCase() });
      }
      const res = [];
      let cur = process.pid;
      for (let i = 0; i < 24; i++) {
        const node = procMap.get(cur);
        if (!node || !procMap.has(node.ppid) || node.ppid === cur) break;
        const parent = procMap.get(node.ppid);
        res.push(parent.comm);
        cur = node.ppid;
      }
      return res;
    }
  } catch {
    return [];
  }
}

/**
 * Checks whether Antigravity Desktop and/or Antigravity CLI (`agy`) are running.
 * @returns {{ desktop: boolean, cli: boolean }}
 */
export function getRunningProcesses() {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const names = new Set(parseWindowsTasklistCsv(out));
      let desktop = names.has('antigravity.exe');
      let cli = names.has('agy.exe');
      if (names.has('language_server.exe') && (!desktop || !cli)) {
        const lsPids = getWindowsLanguageServerPids();
        if (lsPids.desktopPids.length > 0) desktop = true;
        if (lsPids.cliPids.length > 0) cli = true;
      }
      return { desktop, cli };
    } else {
      const out = execFileSync('ps', ['-eo', 'comm'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const names = parsePosixProcessList(out);
      return {
        desktop: names.some(n => n === 'antigravity' || n.startsWith('antigravity ')),
        cli: names.some(n => n === 'agy')
      };
    }
  } catch {
    return { desktop: false, cli: false };
  }
}

/**
 * Checks if any requested Antigravity client is currently running.
 * @param {{ desktop?: boolean, cli?: boolean }} targets
 * @returns {boolean}
 */
export function isAntigravityRunning(targets = { desktop: true, cli: true }) {
  const running = getRunningProcesses();
  return Boolean((targets.desktop !== false && running.desktop) || (targets.cli !== false && running.cli));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Attempts to terminate targeted Antigravity processes gracefully, then forcefully if needed.
 * @param {{ desktop?: boolean, cli?: boolean }} targets
 * @param {object} [deps] Optional overrides for testing.
 * @returns {{ stopped: string[], remaining: string[] }}
 */
export function stopAntigravityProcesses(targets = { desktop: true, cli: true }, deps = {}) {
  const platform = deps.platform || os.platform();
  const execFn = deps.execFileSync || execFileSync;
  const getRunningFn = deps.getRunningProcesses || getRunningProcesses;
  const sleepFn = deps.sleepSync || sleepSync;

  const initial = getRunningFn();
  const stopDesktop = targets.desktop !== false && initial.desktop;
  const stopCli = targets.cli !== false && initial.cli;

  if (!stopDesktop && !stopCli) {
    return { stopped: [], remaining: [] };
  }

  const runKill = (cmd, args) => {
    try {
      execFn(cmd, args, { stdio: 'ignore' });
    } catch {
      // Ignore errors when process already exited or partial tree termination occurs
    }
  };

  if (platform === 'win32') {
    const images = [];
    if (stopDesktop) images.push('Antigravity.exe');
    if (stopCli) images.push('agy.exe');

    // Try graceful termination first so SQLite WAL can flush cleanly
    for (const img of images) {
      runKill('taskkill', ['/IM', img, '/T']);
    }

    for (let i = 0; i < 6; i++) {
      sleepFn(250);
      const curr = getRunningFn();
      const stillDesktop = stopDesktop && curr.desktop;
      const stillCli = stopCli && curr.cli;
      if (!stillDesktop && !stillCli) break;
    }

    // Force-kill any remaining targeted processes (e.g., tray/background helpers)
    const afterGraceful = getRunningFn();
    if (stopDesktop && afterGraceful.desktop) {
      runKill('taskkill', ['/F', '/T', '/IM', 'Antigravity.exe']);
    }
    if (stopCli && afterGraceful.cli) {
      runKill('taskkill', ['/F', '/T', '/IM', 'agy.exe']);
    }

    // Also terminate orphaned language_server.exe instances still holding DB locks
    if (!deps.execFileSync) {
      const lsPids = getWindowsLanguageServerPids();
      const targetPids = [
        ...(stopDesktop ? lsPids.desktopPids : []),
        ...(stopCli ? lsPids.cliPids : [])
      ];
      for (const pid of targetPids) {
        runKill('taskkill', ['/F', '/PID', String(pid)]);
      }
    }
  } else {
    if (stopDesktop) {
      runKill('pkill', ['-x', 'Antigravity']);
      runKill('pkill', ['-x', 'antigravity']);
    }
    if (stopCli) {
      runKill('pkill', ['-x', 'agy']);
    }

    for (let i = 0; i < 6; i++) {
      sleepFn(250);
      const curr = getRunningFn();
      const stillDesktop = stopDesktop && curr.desktop;
      const stillCli = stopCli && curr.cli;
      if (!stillDesktop && !stillCli) break;
    }

    const afterGraceful = getRunningFn();
    if (stopDesktop && afterGraceful.desktop) {
      runKill('pkill', ['-9', '-x', 'Antigravity']);
      runKill('pkill', ['-9', '-x', 'antigravity']);
    }
    if (stopCli && afterGraceful.cli) {
      runKill('pkill', ['-9', '-x', 'agy']);
    }
  }

  // Wait briefly for OS process table to settle
  let finalState = getRunningFn();
  for (let i = 0; i < 12; i++) {
    const stillDesktop = stopDesktop && finalState.desktop;
    const stillCli = stopCli && finalState.cli;
    if (!stillDesktop && !stillCli) break;
    sleepFn(250);
    finalState = getRunningFn();
  }

  const stopped = [];
  const remaining = [];
  if (stopDesktop) {
    (finalState.desktop ? remaining : stopped).push('Antigravity Desktop (Antigravity.exe)');
  }
  if (stopCli) {
    (finalState.cli ? remaining : stopped).push('Antigravity CLI (agy)');
  }

  return { stopped, remaining };
}

/**
 * Stops targeted Antigravity processes if running (unless force=true, which only warns).
 * @param {boolean} force If true, only warns instead of stopping/blocking.
 * @param {{ desktop?: boolean, cli?: boolean }} targets
 * @param {object} [deps] Optional overrides for testing.
 */
export function assertAntigravitySafe(force = false, targets = { desktop: true, cli: true }, deps = {}) {
  const getRunningFn = deps.getRunningProcesses || getRunningProcesses;
  const stopFn = deps.stopAntigravityProcesses || ((t) => stopAntigravityProcesses(t, deps));
  const running = getRunningFn();
  const activeLabels = [];
  if (targets.desktop !== false && running.desktop) {
    activeLabels.push('Antigravity Desktop (Antigravity.exe)');
  }
  if (targets.cli !== false && running.cli) {
    activeLabels.push('Antigravity CLI (agy)');
  }

  if (activeLabels.length === 0) return;

  if (force) {
    console.warn([
      `⚠️  실행 중인 Antigravity 프로세스가 감지되었습니다: ${activeLabels.join(', ')}`,
      '   --force 옵션으로 프로세스를 종료하지 않고 계속 진행합니다.'
    ].join('\n'));
    return;
  }

  console.log(`⚠️  실행 중인 Antigravity 프로세스가 감지되었습니다: ${activeLabels.join(', ')}`);

  if (!deps.stopAntigravityProcesses && (!deps.getRunningProcesses || deps.getAncestorProcessNames)) {
    const ancestors = (deps.getAncestorProcessNames || getAncestorProcessNames)();
    const insideDesktop = targets.desktop !== false && (ancestors.includes('antigravity.exe') || ancestors.includes('antigravity'));
    const insideCli = targets.cli !== false && (ancestors.includes('agy.exe') || ancestors.includes('agy'));
    if (insideDesktop || insideCli) {
      throw new Error([
        '⚠️  현재 Antigravity 내부 터미널에서 실행 중이므로 프로세스를 자동으로 종료할 수 없습니다.',
        '   Antigravity 창과 시스템 트레이를 직접 종료한 뒤 외부 터미널(PowerShell, Windows Terminal 등)에서 다시 실행하세요.'
      ].join('\n'));
    }
  }

  console.log('   안전한 DB 작업을 위해 실행 중인 프로세스를 자동으로 종료한 후 진행합니다...');

  const { remaining } = stopFn(targets);
  if (remaining.length > 0) {
    throw new Error([
      `⚠️  Antigravity 프로세스를 자동으로 종료하지 못했습니다: ${remaining.join(', ')}`,
      '   직접 작업 관리자 등에서 완전히 종료한 후 다시 시도하거나, 강제 진행하려면 --force 옵션을 사용하세요.'
    ].join('\n'));
  }

  console.log('✅ Antigravity 프로세스 종료 완료. 작업을 계속합니다.');
}
