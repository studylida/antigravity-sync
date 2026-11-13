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

/**
 * Throws or warns if targeted Antigravity processes are active.
 * @param {boolean} force If true, only warns instead of blocking.
 * @param {{ desktop?: boolean, cli?: boolean }} targets
 */
export function assertAntigravitySafe(force = false, targets = { desktop: true, cli: true }) {
  const running = getRunningProcesses();
  const activeLabels = [];
  if (targets.desktop !== false && running.desktop) {
    activeLabels.push('Antigravity Desktop (Antigravity.exe)');
  }
  if (targets.cli !== false && running.cli) {
    activeLabels.push('Antigravity CLI (agy)');
  }

  if (activeLabels.length === 0) return;

  const msg = [
    `⚠️  실행 중인 Antigravity 프로세스가 감지되었습니다: ${activeLabels.join(', ')}`,
    '   앱이나 CLI가 켜져 있을 때 DB 파일을 수정하면 WAL 파일 잠금(Lock) 또는 데이터 손상이 발생할 수 있습니다.',
    '   안내: 데스크톱 창을 닫았더라도 시스템 트레이(작업표시줄)에서 실행 중일 수 있습니다.',
    '   실행 중인 앱/CLI를 완전히 종료한 후 다시 시도하거나, 강제 진행하려면 --force 옵션을 사용하세요.'
  ].join('\n');

  if (!force) {
    throw new Error(msg);
  }
  console.warn(msg);
}
