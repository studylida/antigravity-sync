import os from 'node:os';

/**
 * Normalizes any path string into clean parts (e.g. ['C:', 'Users', 'username'] or ['home', 'username']).
 */
export function getPathParts(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return [];
  return pathStr.trim().split(/[\\/]+/).filter(Boolean);
}

/**
 * Generates all path variations for a given home directory.
 */
export function getHomeVariations(homePath) {
  const parts = getPathParts(homePath);
  if (parts.length === 0) return [];

  // Generate casing variations for drive letter if Windows (e.g. C: and c:)
  const driveVariations = [];
  if (parts[0].includes(':')) {
    driveVariations.push([parts[0].toUpperCase(), ...parts.slice(1)]);
    driveVariations.push([parts[0].toLowerCase(), ...parts.slice(1)]);
  } else {
    driveVariations.push(parts);
  }

  const variations = [];
  for (const p of driveVariations) {
    const isWindows = p[0].includes(':');
    const fwd = isWindows ? p.join('/') : '/' + p.join('/');
    const back = p.join('\\');
    const doubleEscaped = p.join('\\\\');
    const uri = 'file:///' + fwd.replace(/^\//, '');
    const uriEnc = isWindows
      ? 'file:///' + p[0].replace(':', '%3A') + '/' + p.slice(1).join('/')
      : 'file://' + fwd;

    variations.push(
      { search: uri, replace: 'file:///{{USER_HOME}}' },
      { search: uriEnc, replace: 'file:///{{USER_HOME}}' },
      { search: doubleEscaped, replace: '{{USER_HOME_JSON}}' },
      { search: back, replace: '{{USER_HOME_BACKSLASH}}' },
      { search: fwd, replace: '{{USER_HOME}}' }
    );
  }

  return variations;
}

/**
 * Replaces machine-specific user home directory paths with portable placeholders.
 */
export function templatizePaths(text, homeDir = os.homedir()) {
  if (!text || typeof text !== 'string') return text;

  let result = text;
  const variations = getHomeVariations(homeDir);

  for (const { search, replace } of variations) {
    if (search && search.length > 0) {
      result = result.replaceAll(search, replace);
    }
  }

  return result;
}

/**
 * Expands placeholders (and legacy source paths) into the target machine's current home directory.
 */
export function expandPaths(text, targetHomeDir = os.homedir(), sourceHomeDir = '', customMappings = {}) {
  if (!text || typeof text !== 'string') return text;

  let result = text;
  const targetParts = getPathParts(targetHomeDir);
  if (targetParts.length === 0) return text;

  const isWindows = targetParts[0].includes(':');
  const targetFwd = isWindows ? targetParts.join('/') : '/' + targetParts.join('/');
  const targetBack = targetParts.join('\\');
  const targetDouble = targetParts.join('\\\\');
  const targetUri = 'file:///' + targetFwd.replace(/^\//, '');

  // 1. Expand standard template placeholders
  result = result.replaceAll('file:///{{USER_HOME}}', targetUri);
  result = result.replaceAll('{{USER_HOME_JSON}}', targetDouble);
  result = result.replaceAll('{{USER_HOME_BACKSLASH}}', targetBack);
  result = result.replaceAll('{{USER_HOME}}', targetFwd);

  // 2. If sourceHomeDir was specified and legacy un-templatized paths exist, convert them too
  if (sourceHomeDir && sourceHomeDir.trim().length > 0) {
    const legacyVariations = getHomeVariations(sourceHomeDir);
    for (const { search } of legacyVariations) {
      if (search.startsWith('file:///')) {
        result = result.replaceAll(search, targetUri);
      } else if (search.includes('\\\\')) {
        result = result.replaceAll(search, targetDouble);
      } else if (search.includes('\\')) {
        result = result.replaceAll(search, targetBack);
      } else {
        result = result.replaceAll(search, targetFwd);
      }
    }
  }

  // 3. Apply optional custom path mappings (e.g. from "D:/projects" to "C:/Users/dam/workspace")
  if (customMappings && typeof customMappings === 'object') {
    for (const [fromPath, toPath] of Object.entries(customMappings)) {
      if (fromPath && toPath) {
        const fromParts = getPathParts(fromPath);
        const toParts = getPathParts(toPath);
        if (fromParts.length > 0 && toParts.length > 0) {
          result = result.replaceAll(fromParts.join('/'), toParts.join('/'));
          result = result.replaceAll(fromParts.join('\\'), toParts.join('\\'));
          result = result.replaceAll(fromParts.join('\\\\'), toParts.join('\\\\'));
        }
      }
    }
  }

  return result;
}
