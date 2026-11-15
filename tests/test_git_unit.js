import { isGitAvailable, isGitRepo, initGitRepo, gitPull, gitCommitAndPush, getGitStatus } from '../src/git.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

assert(isGitAvailable(), 'Git must be available');

const testGitDir = path.join(process.cwd(), 'tests', 'test_git_sandbox');
if (fs.existsSync(testGitDir)) fs.rmSync(testGitDir, { recursive: true, force: true });

try {
  const localDir = path.join(testGitDir, 'local-init');
  const bareDir = path.join(testGitDir, 'remote.git');
  const seedDir = path.join(testGitDir, 'seed');
  const cloneDir = path.join(testGitDir, 'clone-unborn');

  initGitRepo(localDir);
  assert(isGitRepo(localDir), 'Should be a git repo');
  assert(fs.existsSync(path.join(localDir, '.gitignore')), '.gitignore should exist');
  assert(fs.existsSync(path.join(localDir, '.gitattributes')), '.gitattributes should exist');

  // Test commit with CRLF sample file without failing
  fs.writeFileSync(path.join(localDir, 'sample.txt'), 'hello git sync\r\nline2\r\n', 'utf8');
  const commitRes = gitCommitAndPush(localDir, 'test commit');
  console.log('Commit result:', commitRes);
  assert.strictEqual(commitRes.committed, true);
  assert.strictEqual(commitRes.pushed, false);
  assert.strictEqual(commitRes.reason, 'no_remote');

  const status = getGitStatus(localDir);
  console.log('Git status:', status);
  assert.strictEqual(status.hasChanges, false);

  // Test non-main default branch ('master') + unborn HEAD with local .gitignore
  fs.mkdirSync(bareDir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: bareDir, stdio: 'ignore' });

  initGitRepo(seedDir, bareDir);
  execFileSync('git', ['checkout', '-b', 'master'], { cwd: seedDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(seedDir, 'remote-file.txt'), 'from master remote\n', 'utf8');
  const seedPush = gitCommitAndPush(seedDir, 'seed master commit');
  assert.strictEqual(seedPush.pushed, true);

  // Unborn repo initialized with initGitRepo (has untracked .gitignore & .gitattributes on branch main)
  initGitRepo(cloneDir, bareDir);
  const unbornPull = gitPull(cloneDir);
  assert.strictEqual(unbornPull.pulled, true);
  assert.strictEqual(unbornPull.branch, 'master');
  assert.strictEqual(fs.readFileSync(path.join(cloneDir, 'remote-file.txt'), 'utf8'), 'from master remote\n');

  // Test gitPull with dirty working tree auto-stash & rebase
  fs.writeFileSync(path.join(seedDir, 'remote-file-2.txt'), 'second remote commit\n', 'utf8');
  gitCommitAndPush(seedDir, 'second commit');
  fs.writeFileSync(path.join(cloneDir, 'local-dirty.txt'), 'keep me\n', 'utf8');
  const dirtyPull = gitPull(cloneDir);
  assert.strictEqual(dirtyPull.pulled, true);
  assert(fs.existsSync(path.join(cloneDir, 'remote-file-2.txt')));
  assert.strictEqual(fs.readFileSync(path.join(cloneDir, 'local-dirty.txt'), 'utf8'), 'keep me\n');

  // Test broken remote fails on gitCommitAndPush instead of silently succeeding
  execFileSync('git', ['remote', 'set-url', 'origin', path.join(testGitDir, 'nonexistent-remote.git')], { cwd: cloneDir, stdio: 'ignore' });
  assert.throws(
    () => gitCommitAndPush(cloneDir, 'should fail push'),
    /Git error/
  );

  console.log('All git.js unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testGitDir)) fs.rmSync(testGitDir, { recursive: true, force: true });
}
