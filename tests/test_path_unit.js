import { templatizePaths, expandPaths } from '../src/path_utils.js';
import assert from 'node:assert';

const sourceHome = 'C:\\Users\\BISTelligence';
const targetHome = 'C:\\Users\\dam';

// Test 1: File URI
const originalUri = 'file:///c:/Users/BISTelligence/ontology-map-lite';
const templatizedUri = templatizePaths(originalUri, sourceHome);
console.log('Templatized URI:', templatizedUri);
assert.strictEqual(templatizedUri, 'file:///{{USER_HOME}}/ontology-map-lite');

const expandedUri = expandPaths(templatizedUri, targetHome);
console.log('Expanded URI:', expandedUri);
assert.strictEqual(expandedUri, 'file:///C:/Users/dam/ontology-map-lite');

// Test 2: Windows Backslash
const originalBackslash = 'C:\\Users\\BISTelligence\\ontology-map-lite\\server';
const templatizedBackslash = templatizePaths(originalBackslash, sourceHome);
console.log('Templatized Backslash:', templatizedBackslash);
assert.strictEqual(templatizedBackslash, '{{USER_HOME_BACKSLASH}}\\ontology-map-lite\\server');

const expandedBackslash = expandPaths(templatizedBackslash, targetHome);
console.log('Expanded Backslash:', expandedBackslash);
assert.strictEqual(expandedBackslash, 'C:\\Users\\dam\\ontology-map-lite\\server');

// Test 3: JSON Escaped string
const originalJson = '{"path":"c:\\\\Users\\\\BISTelligence\\\\ontology-map-lite"}';
const templatizedJson = templatizePaths(originalJson, sourceHome);
console.log('Templatized JSON:', templatizedJson);
assert(templatizedJson.includes('{{USER_HOME_JSON}}'));

const expandedJson = expandPaths(templatizedJson, targetHome);
console.log('Expanded JSON:', expandedJson);
assert(expandedJson.includes('C:\\\\Users\\\\dam'));

// Test 4: Legacy path fallback (sourceHome passed directly without template)
const legacyString = 'c:\\Users\\BISTelligence\\ontology-map-lite';
const autoAdapted = expandPaths(legacyString, targetHome, sourceHome);
console.log('Legacy adapted:', autoAdapted);
assert.strictEqual(autoAdapted, 'C:\\Users\\dam\\ontology-map-lite');

// Test 5: Custom path mappings
const customString = 'D:/legacy-workspace/my-project';
const customAdapted = expandPaths(customString, targetHome, '', { 'D:/legacy-workspace': 'C:/Users/dam/projects' });
console.log('Custom adapted:', customAdapted);
assert.strictEqual(customAdapted, 'C:/Users/dam/projects/my-project');

console.log('All path_utils unit tests passed successfully! 🎉');
