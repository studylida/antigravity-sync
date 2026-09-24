import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * Checks if Antigravity application is currently running.
 * @returns {boolean}
 */
export function isAntigravityRunning() {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return out.toLowerCase().includes('antigravity.exe');
    } else {
      // macOS / Linux
      const out = execFileSync('pgrep', ['-i', 'antigravity'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return out.trim().length > 0;
    }
  } catch {
    // If command fails or process not found (exit code 1 on pgrep), assume not running
    return false;
  }
}

/**
 * Throws or alerts if Antigravity is active.
 * @param {boolean} force If true, only warns instead of blocking.
 */
export function assertAntigravitySafe(force = false) {
  if (isAntigravityRunning()) {
    const msg = [
      '⚠️  Antigravity가 현재 백그라운드 또는 화면에서 실행 중입니다!',
      '   앱이 켜져 있을 때 DB 파일을 수정하면 파일 잠금(Lock) 또는 데이터 손상이 발생할 수 있습니다.',
      '   안내: 창을 닫았더라도 시스템 트레이(시계 옆 작업표시줄)에서 실행 중일 수 있습니다.',
      '   Antigravity를 완전히 종료한 후 다시 시도하거나, 강제 진행하려면 --force 옵션을 사용하세요.'
    ].join('\n');
    if (!force) {
      throw new Error(msg);
    } else {
      console.warn(msg);
    }
  }
}
