import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { normalizeSlashes } from './path_utils.js';

/**
 * Converts a local path to an Antigravity file URI.
 * e.g. "C:\git\my-project" -> "file:///c%3A/git/my-project"
 */
export function toFileUri(localPath) {
  if (!localPath) return '';
  const fwd = normalizeSlashes(localPath);
  if (/^[A-Za-z]:/.test(fwd)) {
    const drive = fwd[0].toLowerCase();
    const rest = fwd.slice(2);
    return `file:///${drive}%3A${rest.startsWith('/') ? '' : '/'}${rest}`;
  }
  return `file://${fwd.startsWith('/') ? '' : '/'}${fwd}`;
}

/**
 * Converts an Antigravity file URI to a standard local path.
 * e.g. "file:///c%3A/git/my-project" -> "C:/git/my-project"
 */
export function fromFileUri(uri) {
  if (!uri || typeof uri !== 'string') return '';
  let cleaned = uri.replace(/^file:\/\/\/?/, '');
  cleaned = decodeURIComponent(cleaned);
  // Match drive letter: e.g. "c:/git/..." or "C:/git/..."
  if (/^[a-zA-Z]:/.test(cleaned)) {
    const drive = cleaned[0].toUpperCase();
    return drive + cleaned.slice(1);
  }
  return os.platform() === 'win32' ? cleaned : '/' + cleaned;
}

/**
 * Normalizes a git remote URL for comparison (removes protocol, .git, trailing slashes).
 */
export function normalizeGitUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/^ssh:\/\//, '')
    .replace(/:/g, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * Reads git remote.origin.url from a local directory.
 */
export function getLocalGitRemote(dir) {
  try {
    const out = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Collects candidate root directories where development projects typically live.
 */
export function getCandidateSearchRoots(projectsDir = '', extraRoots = []) {
  const roots = new Set();

  // 1. Learn from existing registered projects
  if (projectsDir && fs.existsSync(projectsDir)) {
    try {
      const files = fs.readdirSync(projectsDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          const raw = fs.readFileSync(path.join(projectsDir, f), 'utf8');
          const data = JSON.parse(raw);
          const resources = data.projectResources?.resources || [];
          for (const res of resources) {
            const uri = res.gitFolder?.folderUri || res.workspaceUri || '';
            const localPath = fromFileUri(uri);
            if (localPath) {
              const parentDir = path.dirname(localPath);
              if (fs.existsSync(parentDir)) {
                roots.add(parentDir);
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Extra user-defined roots
  if (Array.isArray(extraRoots)) {
    for (const r of extraRoots) {
      if (r && fs.existsSync(r)) roots.add(r);
    }
  }

  // 3. Platform common roots
  const home = os.homedir();
  if (os.platform() === 'win32') {
    const commonWinRoots = [
      'C:\\git',
      'C:\\workspace',
      'C:\\projects',
      'D:\\git',
      'D:\\workspace',
      'D:\\projects',
      path.join(home, 'git'),
      path.join(home, 'workspace'),
      path.join(home, 'projects'),
      path.join(home, 'source', 'repos'),
      home
    ];
    for (const r of commonWinRoots) {
      if (fs.existsSync(r)) roots.add(r);
    }
  } else {
    // macOS / Linux
    const commonUnixRoots = [
      path.join(home, 'git'),
      path.join(home, 'workspace'),
      path.join(home, 'projects'),
      path.join(home, 'src'),
      path.join(home, 'Development'),
      home
    ];
    for (const r of commonUnixRoots) {
      if (fs.existsSync(r)) roots.add(r);
    }
  }

  return Array.from(roots);
}

/**
 * Searches candidate root directories for a project matching `projectName`.
 */
export function findLocalProjectCandidates(projectName, searchRoots, expectedRemoteUrl = '') {
  if (!projectName || !Array.isArray(searchRoots)) return [];

  const candidates = [];
  const normalizedExpected = normalizeGitUrl(expectedRemoteUrl);

  for (const root of searchRoots) {
    const candidatePath = path.join(root, projectName);
    if (fs.existsSync(candidatePath)) {
      try {
        const stat = fs.statSync(candidatePath);
        if (stat.isDirectory()) {
          const gitDir = path.join(candidatePath, '.git');
          const hasGit = fs.existsSync(gitDir);
          const localRemote = hasGit ? getLocalGitRemote(candidatePath) : null;
          const normalizedLocal = normalizeGitUrl(localRemote);
          const matchesRemote = !!(
            normalizedExpected &&
            normalizedLocal &&
            normalizedExpected === normalizedLocal
          );

          candidates.push({
            path: candidatePath,
            hasGit,
            remoteUrl: localRemote,
            matchesRemote
          });
        }
      } catch {
        // ignore inaccessible
      }
    }
  }

  // Sort: candidates matching git remote come first
  candidates.sort((a, b) => {
    if (a.matchesRemote && !b.matchesRemote) return -1;
    if (!a.matchesRemote && b.matchesRemote) return 1;
    if (a.hasGit && !b.hasGit) return -1;
    if (!a.hasGit && b.hasGit) return 1;
    return 0;
  });

  return candidates;
}

/**
 * Resolves the actual local path for a project, prompting the user if interactive.
 */
export async function resolveProjectLocalPath(projectData, projectsDir, options = {}) {
  const projectName = projectData.name;
  const resources = projectData.projectResources?.resources || [];
  let expectedRemoteUrl = '';

  for (const res of resources) {
    if (res.gitFolder?.remoteUrl) expectedRemoteUrl = res.gitFolder.remoteUrl;
  }

  const searchRoots = getCandidateSearchRoots(projectsDir, options.searchRoots || []);
  const candidates = findLocalProjectCandidates(projectName, searchRoots, expectedRemoteUrl);

  // If non-interactive and autoYes is true, use top candidate if found
  if (options.autoYes && candidates.length > 0) {
    return candidates[0].path;
  }

  // If interactive prompt is available
  if (options.askFn && typeof options.askFn === 'function') {
    if (candidates.length > 0) {
      const top = candidates[0];
      console.log(`\n🔍 [프로젝트 매칭] '${projectName}' 프로젝트의 로컬 폴더를 발견했습니다:`);
      console.log(`   - 경로: ${top.path}`);
      if (top.matchesRemote) {
        console.log(`   - Git 원격 URL: ${top.remoteUrl} (일치함 ✅)`);
      } else if (top.remoteUrl) {
        console.log(`   - Git 원격 URL: ${top.remoteUrl}`);
      } else if (top.hasGit) {
        console.log(`   - Git 저장소 감지됨 (원격 URL 없음)`);
      }

      const ans = await options.askFn(
        `? 이 로컬 폴더를 Antigravity 프로젝트에 연결할까요? (Y/n/경로 직접입력) [기본값: Y]: `
      );
      const trimmed = ans.trim();

      if (!trimmed || trimmed.toLowerCase() === 'y' || trimmed.toLowerCase() === 'yes') {
        return top.path;
      }

      if (trimmed.toLowerCase() !== 'n' && fs.existsSync(trimmed)) {
        return trimmed;
      }
    } else {
      console.log(`\n⚠️  [프로젝트 감지] '${projectName}' 프로젝트의 로컬 폴더를 찾지 못했습니다.`);
      const customPathAns = await options.askFn(
        `? 로컬에 이미 클론해둔 폴더 경로가 있다면 입력해주세요 (엔터 시 기본값 유지): `
      );
      const customPath = customPathAns.trim();
      if (customPath && fs.existsSync(customPath)) {
        return customPath;
      }
    }
  }

  // Fallback: top candidate if available, else null
  return candidates.length > 0 ? candidates[0].path : null;
}
