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
      return {
        desktop: names.has('antigravity.exe'),
        cli: names.has('agy.exe')
      };
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
