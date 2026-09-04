/**
 * Guards the manifest against typos: Chrome fails to load the whole extension if a
 * single referenced path is wrong, and that failure is easy to miss during a reload.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function collectPaths(node, found = []) {
  if (typeof node === 'string') {
    if (/^(src|icons)\//.test(node)) found.push(node);
  } else if (Array.isArray(node)) {
    node.forEach((item) => collectPaths(item, found));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach((value) => collectPaths(value, found));
  }
  return found;
}

test('every file referenced by the manifest exists', () => {
  const missing = collectPaths(manifest).filter((path) => !existsSync(join(ROOT, path)));
  assert.deepEqual(missing, [], `missing files: ${missing.join(', ')}`);
});

test('manifest and package versions agree', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
});

test('the interceptor runs in the main world and the bridge does not', () => {
  const main = manifest.content_scripts.find((entry) => entry.world === 'MAIN');
  const isolated = manifest.content_scripts.find((entry) => entry.world !== 'MAIN');

  assert.ok(main, 'a MAIN-world content script is required to see page fetch/XHR');
  assert.deepEqual(main.js, ['src/content/interceptor.js']);
  assert.equal(main.run_at, 'document_start', 'must patch fetch before the page uses it');

  assert.ok(isolated.js.includes('src/content/bridge.js'));
});

test('host permissions cover LeetCode, GitHub and Groq', () => {
  for (const host of ['https://leetcode.com/*', 'https://api.github.com/*', 'https://api.groq.com/*']) {
    assert.ok(manifest.host_permissions.includes(host), `missing host permission: ${host}`);
  }
});

test('secrets-bearing pages are not exposed to the web', () => {
  assert.equal(manifest.web_accessible_resources, undefined);
});
