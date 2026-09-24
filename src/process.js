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
      '⚠️  Antigravity is currently running!',
      '   Modifying SQLite databases while the app is active can cause database corruption or file lock errors.',
      '   Please close Antigravity before syncing, or pass --force to proceed anyway.'
    ].join('\n');
    if (!force) {
      throw new Error(msg);
    } else {
      console.warn(msg);
    }
  }
}
