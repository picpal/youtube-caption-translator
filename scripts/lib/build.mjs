// Build policy for dev:chrome: rebuild if the manifest is missing, or older
// than the newest file among the watched source paths. Otherwise skip.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, MANIFEST_PATH } from './config.mjs';

const WATCHED_PATHS = [
  'entrypoints',
  'src',
  'wxt.config.ts',
  'package.json',
  'tailwind.config.ts',
  'postcss.config.js',
  'tsconfig.json',
];

function newestMtimeMs(relPath) {
  const full = path.join(REPO_ROOT, relPath);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;

  let max = stat.mtimeMs;
  for (const entry of fs.readdirSync(full)) {
    max = Math.max(max, newestMtimeMs(path.join(relPath, entry)));
  }
  return max;
}

export function ensureBuilt() {
  let manifestMtime = 0;
  try {
    manifestMtime = fs.statSync(MANIFEST_PATH).mtimeMs;
  } catch {
    // manifest doesn't exist yet
  }

  const newestSource = Math.max(...WATCHED_PATHS.map(newestMtimeMs));

  if (manifestMtime === 0) {
    console.log('[dev:chrome] .output/chrome-mv3/manifest.json not found — running `pnpm wxt build`...');
  } else if (newestSource > manifestMtime) {
    console.log('[dev:chrome] source files are newer than the build output — running `pnpm wxt build`...');
  } else {
    console.log('[dev:chrome] build output is up to date — skipping build.');
    return;
  }

  execFileSync('pnpm', ['wxt', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
}
