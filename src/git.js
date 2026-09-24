import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function runGit(args, cwd, timeout = 45000) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    throw new Error(`Git error (git ${args.join(' ')}): ${stderr || err.message}`);
  }
}

export function isGitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

export function initGitRepo(dir, remoteUrl = '') {
  fs.mkdirSync(dir, { recursive: true });
  if (!isGitRepo(dir)) {
    runGit(['init', '-b', 'main'], dir);
  }

  // Ensure git user.name and user.email are configured
  try {
    runGit(['config', 'user.name'], dir);
  } catch {
    runGit(['config', 'user.name', 'Antigravity Sync'], dir);
  }
  try {
    runGit(['config', 'user.email'], dir);
  } catch {
    runGit(['config', 'user.email', 'sync@antigravity.local'], dir);
  }

  // Create default .gitignore
  const gitignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, [
      '# Antigravity Sync ignore',
      '*.tmp',
      '*.temp',
      '*.log',
      '*.db-wal',
      '*.db-shm',
      '.DS_Store',
      'Thumbs.db',
      ''
    ].join('\n'), 'utf8');
  }

  if (remoteUrl) {
    try {
      runGit(['remote', 'get-url', 'origin'], dir);
      runGit(['remote', 'set-url', 'origin', remoteUrl], dir);
    } catch {
      runGit(['remote', 'add', 'origin', remoteUrl], dir);
    }
  }
}

export function gitPull(dir) {
  if (!isGitRepo(dir)) return { pulled: false, reason: 'not_git_repo' };

  try {
    runGit(['remote', 'get-url', 'origin'], dir);
  } catch {
    return { pulled: false, reason: 'no_remote' };
  }

  try {
    const out = runGit(['pull', '--rebase', 'origin', 'main'], dir);
    return { pulled: true, output: out };
  } catch (err) {
    // If branch doesn't exist yet on remote, that's okay
    if (err.message.includes('couldn\'t find remote ref') || err.message.includes('fatal: couldn\'t find remote')) {
      return { pulled: false, reason: 'remote_empty' };
    }
    throw err;
  }
}

export function gitCommitAndPush(dir, commitMessage = 'Auto sync by antigravity-sync') {
  if (!isGitRepo(dir)) return { committed: false, pushed: false };

  runGit(['add', '-A'], dir);

  // Check if anything is staged
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: dir, stdio: 'ignore' });
    // Nothing to commit
    return { committed: false, pushed: false, message: 'No changes to commit' };
  } catch {
    // There are changes
  }

  runGit(['commit', '-m', commitMessage], dir);

  let pushed = false;
  try {
    runGit(['remote', 'get-url', 'origin'], dir);
    runGit(['push', '-u', 'origin', 'HEAD'], dir);
    pushed = true;
  } catch (err) {
    console.warn(`[Git] Push skipped or failed: ${err.message}`);
  }

  return { committed: true, pushed };
}

export function getGitStatus(dir) {
  if (!isGitRepo(dir)) return null;
  try {
    const status = runGit(['status', '--short'], dir);
    const branch = runGit(['branch', '--show-current'], dir);
    let remote = '';
    try {
      remote = runGit(['remote', 'get-url', 'origin'], dir);
    } catch {
      // no remote
    }
    return {
      branch,
      remote,
      hasChanges: status.length > 0,
      statusLines: status ? status.split('\n') : []
    };
  } catch {
    return null;
  }
}
