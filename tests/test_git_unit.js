import { isGitAvailable, isGitRepo, initGitRepo, gitCommitAndPush, getGitStatus } from '../src/git.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

assert(isGitAvailable(), 'Git must be available');

const testGitDir = path.join(process.cwd(), 'tests', 'test_git_sandbox');
if (fs.existsSync(testGitDir)) fs.rmSync(testGitDir, { recursive: true, force: true });

try {
  initGitRepo(testGitDir);
  assert(isGitRepo(testGitDir), 'Should be a git repo');
  assert(fs.existsSync(path.join(testGitDir, '.gitignore')), '.gitignore should exist');

  // Test commit with a sample file
  fs.writeFileSync(path.join(testGitDir, 'sample.txt'), 'hello git sync', 'utf8');
  const commitRes = gitCommitAndPush(testGitDir, 'test commit');
  console.log('Commit result:', commitRes);
  assert.strictEqual(commitRes.committed, true);

  const status = getGitStatus(testGitDir);
  console.log('Git status:', status);
  assert.strictEqual(status.hasChanges, false);

  console.log('All git.js unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testGitDir)) fs.rmSync(testGitDir, { recursive: true, force: true });
}
