import {
  toFileUri,
  fromFileUri,
  normalizeGitUrl,
  findLocalProjectCandidates,
  resolveProjectLocalPath
} from '../src/project_locator.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

// Test 1: URI round-trip
const winPath = 'C:\\git\\ontology-map-lite';
const fileUri = toFileUri(winPath);
console.log('toFileUri:', fileUri);
assert(fileUri.includes('file:///c%3A/git/ontology-map-lite') || fileUri.includes('file:///C:/git/ontology-map-lite'));
const backPath = fromFileUri(fileUri);
console.log('fromFileUri:', backPath);
assert.strictEqual(backPath.toLowerCase(), 'c:/git/ontology-map-lite');

// Test 2: Git URL normalization
const httpsUrl = 'https://github.com/studylida/ontology-map-lite.git';
const sshUrl = 'git@github.com:studylida/ontology-map-lite.git';
const normHttps = normalizeGitUrl(httpsUrl);
const normSsh = normalizeGitUrl(sshUrl);
console.log('normHttps:', normHttps);
console.log('normSsh:', normSsh);
assert.strictEqual(normHttps, normSsh);
assert.strictEqual(normHttps, 'github.com/studylida/ontology-map-lite');

// Test 3: Candidate search in sandbox
const testDir = path.join(process.cwd(), 'tests', 'test_locator_sandbox');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const mockGitRoot = path.join(testDir, 'my-git-root');
const mockProjectDir = path.join(mockGitRoot, 'cool-project');
fs.mkdirSync(mockProjectDir, { recursive: true });

try {
  // Find project without git
  const candidates1 = findLocalProjectCandidates('cool-project', [mockGitRoot]);
  console.log('Candidates without git:', candidates1);
  assert.strictEqual(candidates1.length, 1);
  assert.strictEqual(candidates1[0].hasGit, false);

  // Test interactive resolution with askFn = 'y'
  let asked = false;
  const resolvedPath = await resolveProjectLocalPath(
    { name: 'cool-project' },
    '',
    {
      searchRoots: [mockGitRoot],
      askFn: async (q) => {
        asked = true;
        console.log('Prompt displayed:', q);
        return 'y';
      }
    }
  );
  assert(asked);
  assert.strictEqual(resolvedPath, mockProjectDir);

  console.log('All project_locator unit tests passed successfully! 🎉');
} finally {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}
