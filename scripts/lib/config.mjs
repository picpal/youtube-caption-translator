// Shared constants for the dev:chrome tooling. Zero dependencies — plain Node.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// scripts/lib -> scripts -> repo root
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);

// Persistent, gitignored profile so a saved API key survives across runs.
export const PROFILE_DIR = path.join(REPO_ROOT, '.chrome-dev-profile');

export const BUILD_DIR = path.join(REPO_ROOT, '.output', 'chrome-mv3');
export const MANIFEST_PATH = path.join(BUILD_DIR, 'manifest.json');

// Gitignored output dir for screenshots + chrome's own stdout/stderr log.
export const OUTPUT_DIR = path.join(REPO_ROOT, '.chrome-dev-output');
export const CHROME_LOG_PATH = path.join(OUTPUT_DIR, 'chrome.log');

// Obviously-fake key used by dev:chrome:check. Never a real credential.
export const FAKE_API_KEY = 'AIzaFAKE_DEVCHECK_0000';
export const FAKE_API_KEY_MASK = '••••0000'; // matches maskKey() in src/lib/storage.ts

/**
 * Read the built manifest.json's declared background service worker script
 * filename (normally "background.js"). Used to pick our extension's service
 * worker target out of the several a fresh Chrome profile spins up (Chrome
 * ships its own built-in component extensions too).
 */
export function getBackgroundScriptName() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const swScript = manifest.background?.service_worker;
  if (!swScript) {
    throw new Error(`manifest.json at ${MANIFEST_PATH} has no background.service_worker entry`);
  }
  return swScript;
}
