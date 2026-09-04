/**
 * Builds dist/aileethub-v<version>.zip for the Chrome Web Store.
 *
 * There is no bundler — packaging is just "copy the files Chrome loads, zip them
 * with manifest.json at the archive root". Run with `npm run package`.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Everything Chrome actually loads. Anything not listed here (tests, tools,
// node_modules, .git) stays out of the store package.
const INCLUDE = ['manifest.json', 'src', 'icons'];

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

if (manifest.version !== version) {
  console.error(
    `Version mismatch: package.json is ${version}, manifest.json is ${manifest.version}.\n` +
      'Chrome ships the manifest version — align them before packaging.',
  );
  process.exit(1);
}

const staging = join(tmpdir(), `aileethub-package-${Date.now()}`);
const dist = join(ROOT, 'dist');
const output = join(dist, `aileethub-v${version}.zip`);

mkdirSync(staging, { recursive: true });
mkdirSync(dist, { recursive: true });
rmSync(output, { force: true });

for (const entry of INCLUDE) {
  const source = join(ROOT, entry);
  if (!existsSync(source)) {
    console.error(`Missing ${entry} — run \`npm run icons\` first?`);
    process.exit(1);
  }
  cpSync(source, join(staging, entry), { recursive: true });
}

if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${join(staging, '*')}' -DestinationPath '${output}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-r', '-q', output, ...INCLUDE], { cwd: staging, stdio: 'inherit' });
}

rmSync(staging, { recursive: true, force: true });
console.log(`Packaged ${output}`);
