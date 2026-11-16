import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function runGit(args, cwd, timeout = 180000) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    throw new Error(`Git error (git ${args.join(' ')}): ${stderr || err.message}`);
  }
}

function removeNestedGitDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== '.git') {
      stack.push(path.join(rootDir, entry.name));
    }
  }
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.name === '.git') {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        stack.push(fullPath);
      }
    }
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

export function isGhAvailable() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a private GitHub repository exists for sync and returns its clone URL.
 * @param {string} repoName
 * @returns {string}
 */
export function ensureGithubSyncRepo(repoName = 'antigravity-sync-data') {
  const execOpts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 };
  const owner = execFileSync('gh', ['api', 'user', '--jq', '.login'], execOpts).trim();
  const fullName = owner ? `${owner}/${repoName}` : repoName;

  let protocol = 'https';
  try {
    const p = execFileSync('gh', ['config', 'get', 'git_protocol'], execOpts).trim();
    if (p === 'ssh') protocol = 'ssh';
  } catch {
    // default https
  }

  const formatRepoUrl = (jsonStr) => {
    const data = JSON.parse(jsonStr);
    if (protocol === 'ssh' && data.sshUrl) return data.sshUrl;
    return data.url ? `${data.url}.git` : '';
  };

  try {
    const existing = execFileSync('gh', ['repo', 'view', fullName, '--json', 'url,sshUrl'], execOpts).trim();
    const url = formatRepoUrl(existing);
    if (url) return url;
  } catch {
    // Repo does not exist yet; create it as private
  }

  execFileSync('gh', ['repo', 'create', fullName, '--private', '--description', 'Antigravity Sync private backup repository'], execOpts);
  const created = execFileSync('gh', ['repo', 'view', fullName, '--json', 'url,sshUrl'], execOpts).trim();
  const url = formatRepoUrl(created);
  if (!url) {
    throw new Error(`GitHub 저장소 URL을 가져오지 못했습니다: ${fullName}`);
  }
  return url;
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

  ensureGitConfigAndAttributes(dir);

  // Create default .gitignore and .gitattributes
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

function ensureGitConfigAndAttributes(dir) {
  for (const [key, val] of [
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['core.longpaths', 'true']
  ]) {
    try {
      runGit(['config', key, val], dir);
    } catch {
      // Ignore if config fails
    }
  }

  const gitattributesPath = path.join(dir, '.gitattributes');
  if (!fs.existsSync(gitattributesPath)) {
    fs.writeFileSync(gitattributesPath, '* -text\n', 'utf8');
  }
}

function getRemoteBranchInfo(dir) {
  let lsHeads = '';
  try {
    lsHeads = runGit(['ls-remote', '--heads', 'origin'], dir);
  } catch {
    return { empty: false, defaultBranch: null, branches: new Set() };
  }

  const branches = new Set();
  for (const line of lsHeads.split(/\r?\n/)) {
    const m = line.match(/refs\/heads\/(.+)$/);
    if (m) branches.add(m[1].trim());
  }
  if (branches.size === 0) {
    return { empty: true, defaultBranch: null, branches };
  }

  let defaultBranch = null;
  try {
    const symref = runGit(['ls-remote', '--symref', 'origin', 'HEAD'], dir);
    const m = symref.match(/ref:\s*refs\/heads\/([^\s]+)/);
    if (m && branches.has(m[1])) {
      defaultBranch = m[1];
    }
  } catch {
    // Fallback below
  }

  if (!defaultBranch) {
    if (branches.has('main')) defaultBranch = 'main';
    else if (branches.has('master')) defaultBranch = 'master';
    else defaultBranch = [...branches][0];
  }

  return { empty: false, defaultBranch, branches };
}

function abortInProgressGitState(dir) {
  const gitDir = path.join(dir, '.git');
  if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
    try {
      runGit(['rebase', '--abort'], dir);
    } catch {
      // ignore if nothing to abort
    }
  }
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    try {
      runGit(['merge', '--abort'], dir);
    } catch {
      // ignore
    }
  }
}

function isGitConflictError(err) {
  return /CONFLICT|could not apply|merge conflict|fix conflicts|unmerged files/i.test(err?.message || '');
}

function isNonFastForwardError(err) {
  return /non-fast-forward|fetch first|failed to push some refs/i.test(err?.message || '');
}

export function gitPull(dir, options = {}) {
  if (!isGitRepo(dir)) return { pulled: false, reason: 'not_git_repo' };

  try {
    runGit(['remote', 'get-url', 'origin'], dir);
  } catch {
    return { pulled: false, reason: 'no_remote' };
  }

  ensureGitConfigAndAttributes(dir);
  abortInProgressGitState(dir);

  const remoteInfo = getRemoteBranchInfo(dir);
  if (remoteInfo.empty) {
    return { pulled: false, reason: 'remote_empty' };
  }

  let currentBranch = '';
  try {
    currentBranch = runGit(['branch', '--show-current'], dir);
  } catch {
    currentBranch = '';
  }

  const targetBranch = (currentBranch && remoteInfo.branches.has(currentBranch))
    ? currentBranch
    : (remoteInfo.defaultBranch || currentBranch || 'main');

  let hasHead = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    hasHead = true;
  } catch {
    hasHead = false;
  }

  if (!hasHead) {
    try {
      runGit(['fetch', 'origin', targetBranch], dir, 300000);
      const out = runGit(['checkout', '-f', '-B', targetBranch, `origin/${targetBranch}`], dir, 300000);
      ensureGitConfigAndAttributes(dir);
      return { pulled: true, output: out, branch: targetBranch };
    } catch (err) {
      if (err.message.includes('couldn\'t find remote ref') || err.message.includes('fatal: couldn\'t find remote')) {
        return { pulled: false, reason: 'remote_empty' };
      }
      throw err;
    }
  }

  let stashed = false;
  const dirtyStatus = runGit(['status', '--porcelain'], dir);
  if (dirtyStatus) {
    runGit(['stash', 'push', '--include-untracked', '-m', 'agy-sync-auto-stash'], dir, 300000);
    stashed = true;
  }

  let pullResult;
  try {
    const out = runGit(['pull', '--rebase', 'origin', targetBranch], dir, 300000);
    pullResult = { pulled: true, output: out, branch: targetBranch };
  } catch (err) {
    if (err.message.includes('couldn\'t find remote ref') || err.message.includes('fatal: couldn\'t find remote')) {
      pullResult = { pulled: false, reason: 'remote_empty' };
    } else if (isGitConflictError(err)) {
      abortInProgressGitState(dir);
      if (options.recoverConflictByReset) {
        runGit(['fetch', 'origin', targetBranch], dir, 300000);
        runGit(['reset', '--hard', `origin/${targetBranch}`], dir, 300000);
        ensureGitConfigAndAttributes(dir);
        pullResult = { pulled: true, branch: targetBranch, conflictRecovered: true };
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  } finally {
    if (stashed) {
      try {
        runGit(['stash', 'pop'], dir, 300000);
      } catch (stashErr) {
        if (options.recoverConflictByReset) {
          // Drop conflicted stash so JSON indexes are never left with conflict markers
          try {
            runGit(['reset', '--hard', 'HEAD'], dir, 300000);
            runGit(['stash', 'drop'], dir, 300000);
          } catch {
            // ignore cleanup error
          }
          console.warn('[Git] 원격 변경과 로컬 임시 변경이 충돌하여 원격 기준으로 정리했습니다.');
        } else {
          console.warn(`[Git] Auto-stash restore had conflicts (stash preserved in git stash list): ${stashErr.message}`);
        }
      }
    }
  }

  return pullResult;
}

export function gitCommitAndPush(dir, commitMessage = 'Auto sync by antigravity-sync', options = {}) {
  if (!isGitRepo(dir)) return { committed: false, pushed: false };

  ensureGitConfigAndAttributes(dir);
  abortInProgressGitState(dir);
  removeNestedGitDirs(dir);
  runGit(['add', '-A'], dir, 300000);

  let hasStagedChanges = false;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: dir, stdio: 'ignore' });
    hasStagedChanges = false;
  } catch {
    hasStagedChanges = true;
  }

  if (hasStagedChanges) {
    runGit(['commit', '-m', commitMessage], dir, 300000);
  }

  let hasRemote = false;
  try {
    runGit(['remote', 'get-url', 'origin'], dir);
    hasRemote = true;
  } catch {
    hasRemote = false;
  }

  if (!hasRemote) {
    return hasStagedChanges
      ? { committed: true, pushed: false, reason: 'no_remote' }
      : { committed: false, pushed: false, message: 'No changes to commit' };
  }

  if (!hasStagedChanges) {
    // Check if there are unpushed local commits waiting to be pushed
    let aheadCount = 0;
    try {
      const countStr = runGit(['rev-list', '--count', '@{u}..HEAD'], dir);
      aheadCount = Number(countStr) || 0;
    } catch {
      aheadCount = 0;
    }
    if (aheadCount === 0) {
      return { committed: false, pushed: false, message: 'No changes to commit' };
    }
  }

  try {
    runGit(['push', '-u', 'origin', 'HEAD'], dir, 300000);
    return { committed: hasStagedChanges, pushed: true };
  } catch (err) {
    if (isNonFastForwardError(err) && typeof options.onPushConflict === 'function') {
      gitPull(dir, { recoverConflictByReset: true });
      options.onPushConflict();
      removeNestedGitDirs(dir);
      runGit(['add', '-A'], dir, 300000);
      try {
        execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: dir, stdio: 'ignore' });
      } catch {
        runGit(['commit', '-m', `${commitMessage} (merged remote)`], dir, 300000);
      }
      runGit(['push', '-u', 'origin', 'HEAD'], dir, 300000);
      return { committed: true, pushed: true, retried: true };
    }
    throw err;
  }
}

export function getGitStatus(dir) {
  if (!isGitRepo(dir)) return null;
  try {
    const status = runGit(['status', '--short'], dir);
    let branch = runGit(['branch', '--show-current'], dir);
    if (!branch) {
      try {
        branch = runGit(['symbolic-ref', '--short', 'HEAD'], dir);
      } catch {
        branch = 'HEAD (detached)';
      }
    }
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
