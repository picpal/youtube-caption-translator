#!/usr/bin/env node
// Loads the built extension into a real, isolated Chrome instance via CDP
// Extensions.loadUnpacked (--load-extension is dead on Chrome 150 stable).
//
// Usage: pnpm dev:chrome
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CHROME_PATH,
  DEBUG_PORT,
  PROFILE_DIR,
  BUILD_DIR,
  MANIFEST_PATH,
  OUTPUT_DIR,
  CHROME_LOG_PATH,
  getBackgroundScriptName,
} from './lib/config.mjs';
import { ensureBuilt } from './lib/build.mjs';
import { CDP, getDebugInfo, findExtensionServiceWorker } from './lib/cdp.mjs';

async function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getDebugInfo(port);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Timed out waiting for Chrome debug port ${port} to come up. Check ${CHROME_LOG_PATH}.`,
  );
}

function printSummary({ reused, extensionId, swFound }) {
  console.log('');
  console.log(`Chrome dev instance ${reused ? 'reused (already running)' : 'ready'}.`);
  console.log(`  Debug port:       ${DEBUG_PORT}`);
  console.log(`  Profile dir:      ${PROFILE_DIR}`);
  console.log(`  Extension ID:     ${extensionId}`);
  console.log(`  Options page:     chrome-extension://${extensionId}/options.html`);
  console.log(`  Side panel page:  chrome-extension://${extensionId}/sidepanel.html`);
  console.log(`  Service worker:   ${swFound ? 'found' : 'NOT FOUND yet — check ' + CHROME_LOG_PATH}`);
  console.log(`  Chrome log:       ${CHROME_LOG_PATH}`);
  console.log('');
  console.log('Stop with:   pnpm dev:chrome:stop');
  console.log('Verify with: pnpm dev:chrome:check');
  console.log('');
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  ensureBuilt();

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[dev:chrome] Build output not found at ${BUILD_DIR} (build failed?).`);
    process.exit(1);
  }

  const existing = await getDebugInfo(DEBUG_PORT);
  const reused = Boolean(existing);

  if (reused) {
    console.log(`[dev:chrome] Chrome is already listening on port ${DEBUG_PORT} — reusing it.`);
    console.log('[dev:chrome] (If this is not your dev:chrome instance, stop it and re-run, or set CHROME_DEBUG_PORT.)');
  } else {
    console.log(`[dev:chrome] Launching Chrome: ${CHROME_PATH}`);
    console.log(`[dev:chrome] Profile dir: ${PROFILE_DIR}`);
    const logFd = fs.openSync(CHROME_LOG_PATH, 'a');
    const child = spawn(
      CHROME_PATH,
      [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic', // avoid a macOS Keychain prompt hang on a fresh profile
        'about:blank',
      ],
      { detached: true, stdio: ['ignore', logFd, logFd] },
    );
    child.unref();
    await waitForPort(DEBUG_PORT);
  }

  const info = await getDebugInfo(DEBUG_PORT);
  const cdp = await CDP.connect(info.webSocketDebuggerUrl);
  const workerScriptName = getBackgroundScriptName();

  let extensionId;
  const existingSw = await findExtensionServiceWorker(cdp, workerScriptName);
  if (existingSw) {
    extensionId = new URL(existingSw.url).host;
    console.log(`[dev:chrome] Extension already loaded (service worker present): ${extensionId}`);
  } else {
    console.log(`[dev:chrome] Loading unpacked extension from ${BUILD_DIR}...`);
    const result = await cdp.send('Extensions.loadUnpacked', { path: BUILD_DIR });
    extensionId = result.id;
  }

  let swFound = Boolean(existingSw);
  for (let i = 0; i < 15 && !swFound; i++) {
    await new Promise((r) => setTimeout(r, 300));
    swFound = Boolean(await findExtensionServiceWorker(cdp, workerScriptName));
  }

  printSummary({ reused, extensionId, swFound });
  cdp.close();
}

main().catch((err) => {
  console.error(`[dev:chrome] ${err.message}`);
  process.exit(1);
});
