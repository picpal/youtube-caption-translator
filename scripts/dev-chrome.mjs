#!/usr/bin/env node
// Loads the built extension into a real, isolated Chrome instance via CDP
// Extensions.loadUnpacked (--load-extension is dead on Chrome 150 stable).
//
// Usage: pnpm dev:chrome [-- <youtube-url>]
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
  ENV_LOCAL_PATH,
  getBackgroundScriptName,
  resolveYoutubeUrl,
} from './lib/config.mjs';
import { ensureBuilt } from './lib/build.mjs';
import {
  CDP,
  getDebugInfo,
  findExtensionServiceWorker,
  waitForExtensionServiceWorker,
  attachAndEnableRuntime,
  waitForExtensionPageReady,
  evalJson,
  sendMessageExpr,
} from './lib/cdp.mjs';
import { computeExtensionId } from './lib/extension-id.mjs';
import { seedPinnedExtension, PIN_FALLBACK_INSTRUCTIONS_KO } from './lib/pin-extension.mjs';
import { parseEnvFile } from './lib/env-file.mjs';

const youtubeUrl = resolveYoutubeUrl();

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

// Never returns/logs the raw key value — only the masked form the
// extension's own SAVE_API_KEY/GET_API_KEY_STATUS responses provide.
async function seedApiKeyFromEnvIfAbsent(cdp, sessionId) {
  const statusRes = await evalJson(cdp, sessionId, sendMessageExpr('GET_API_KEY_STATUS'));
  if (!statusRes.__ok) {
    return { status: 'error', error: statusRes.error };
  }
  if (statusRes.value?.present === true) {
    return { status: 'already-present', maskedKey: statusRes.value?.maskedKey };
  }

  const env = parseEnvFile(ENV_LOCAL_PATH);
  const key = env.GEMINI_API_KEY;
  if (!key) {
    return { status: 'no-env-key' };
  }

  const saveRes = await evalJson(cdp, sessionId, sendMessageExpr('SAVE_API_KEY', { key }));
  if (saveRes.__ok && saveRes.value?.ok === true) {
    return { status: 'seeded', maskedKey: saveRes.value?.status?.maskedKey };
  }
  return { status: 'error', error: saveRes.error ?? JSON.stringify(saveRes.value) };
}

function printSummary({ reused, extensionId, swFound, pinResult, youtubeTargetId, optionsTargetId, seedResult }) {
  console.log('');
  console.log(`Chrome dev instance ${reused ? 'reused (already running)' : 'ready'}.`);
  console.log(`  Debug port:       ${DEBUG_PORT}`);
  console.log(`  Profile dir:      ${PROFILE_DIR}`);
  console.log(`  Extension ID:     ${extensionId}`);
  console.log(`  Options page:     chrome-extension://${extensionId}/options.html`);
  console.log(`  Side panel page:  chrome-extension://${extensionId}/sidepanel.html`);
  console.log(`  Service worker:   ${swFound ? 'found' : 'NOT FOUND yet — check ' + CHROME_LOG_PATH}`);
  console.log(`  YouTube tab:      ${youtubeUrl}${youtubeTargetId ? '' : ' (not opened this run — instance was reused)'}`);
  console.log(`  Options tab:      ${optionsTargetId ? 'opened (also wakes the service worker)' : 'not left open this run'}`);
  console.log(`  Chrome log:       ${CHROME_LOG_PATH}`);
  console.log('');

  switch (seedResult?.status) {
    case 'already-present':
      console.log(`  API key:          already present (${seedResult.maskedKey}) — left untouched.`);
      break;
    case 'seeded':
      console.log(`  API key:          seeded from .env.local (masked: ${seedResult.maskedKey}).`);
      break;
    case 'no-env-key':
      console.log('  API key:          none in storage, none in .env.local — enter one in the Options page, or set GEMINI_API_KEY in .env.local.');
      break;
    case 'error':
      console.warn(`  API key:          could not check/seed (${seedResult.error})`);
      break;
    default:
      break;
  }

  console.log('');

  if (reused) {
    console.log('  Note: instance was already running — pin state and tabs were left untouched.');
    console.log('  Run `pnpm dev:chrome:stop` first if you want a clean pin/tab setup.');
  } else if (pinResult.seeded) {
    console.log('  Toolbar pin:      seeded automatically before launch (extensions.pinned_extensions).');
    console.log('  If the icon still shows as the generic puzzle piece, use the fallback below.');
  } else {
    console.log('  Toolbar pin:      COULD NOT seed automatically (' + pinResult.error + ')');
  }

  if (reused || !pinResult.seeded) {
    console.log('');
    console.log('  ' + PIN_FALLBACK_INSTRUCTIONS_KO.join('\n  '));
  }

  console.log('');
  console.log('Next steps:');
  console.log('  1. Switch to the YouTube tab (already open, or use the URL above).');
  console.log("  2. Click the extension's toolbar icon to open the side panel — it does NOT");
  console.log('     have a popup; the toolbar click opens the docked side panel directly.');
  console.log('     (한글) 툴바의 확장 프로그램 아이콘을 클릭하면 사이드 패널이 열립니다.');
  console.log('  3. If you only see the generic puzzle-piece icon, see the pin instructions above.');
  console.log('');
  console.log('Stop with:         pnpm dev:chrome:stop');
  console.log('Verify with:       pnpm dev:chrome:check');
  console.log('Verify panel with: pnpm dev:chrome:check:panel');
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
  const expectedExtensionId = computeExtensionId(BUILD_DIR);
  let pinResult = { seeded: false, error: 'skipped (instance reused)' };

  if (reused) {
    console.log(`[dev:chrome] Chrome is already listening on port ${DEBUG_PORT} — reusing it.`);
    console.log('[dev:chrome] (If this is not your dev:chrome instance, stop it and re-run, or set CHROME_DEBUG_PORT.)');
  } else {
    console.log(`[dev:chrome] Expected extension ID for this build path: ${expectedExtensionId}`);
    pinResult = seedPinnedExtension(expectedExtensionId);
    if (pinResult.seeded) {
      console.log(`[dev:chrome] Seeded toolbar pin for ${expectedExtensionId} in Preferences (pre-launch).`);
    } else {
      console.warn(`[dev:chrome] Could not seed toolbar pin: ${pinResult.error}`);
    }

    console.log(`[dev:chrome] Launching Chrome: ${CHROME_PATH}`);
    console.log(`[dev:chrome] Profile dir: ${PROFILE_DIR}`);
    console.log(`[dev:chrome] Landing tab: ${youtubeUrl}`);
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
        youtubeUrl,
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
    if (extensionId !== expectedExtensionId) {
      console.warn(
        `[dev:chrome] NOTE: loaded extension id (${extensionId}) differs from the precomputed id ` +
          `(${expectedExtensionId}) — toolbar pin seeding targeted the wrong id this run.`,
      );
    }
  }

  let youtubeTargetId;
  let optionsTargetId;
  let keepOptionsTabOpen = false;

  if (!reused) {
    // The initial Chrome launch already opened the YouTube URL as the first
    // tab; grab its target id for the banner/verification.
    const { targetInfos } = await cdp.send('Target.getTargets');
    const youtubeTarget = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(youtubeUrl.split('?')[0]));
    youtubeTargetId = youtubeTarget?.targetId;

    // Open the options page as a second, visible tab: gives the user
    // something else to look at immediately, and the act of opening any
    // extension page wakes the (possibly not-yet-started) background
    // service worker. Left open for the user.
    const created = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options.html`,
    });
    optionsTargetId = created.targetId;
    keepOptionsTabOpen = true;
  } else {
    // Reusing an already-running instance: don't disturb whatever tabs the
    // user has open. Open a transient, throwaway options target purely to
    // wake the service worker (if evicted) and check/seed the API key, then
    // close it again.
    const created = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options.html`,
    });
    optionsTargetId = created.targetId;
    keepOptionsTabOpen = false;
  }

  const sw = await waitForExtensionServiceWorker(cdp, workerScriptName, 10000);
  const swFound = Boolean(sw);

  const optionsSession = await attachAndEnableRuntime(cdp, optionsTargetId);
  await waitForExtensionPageReady(cdp, optionsSession);
  const seedResult = await seedApiKeyFromEnvIfAbsent(cdp, optionsSession);

  if (!keepOptionsTabOpen) {
    await cdp.send('Target.closeTarget', { targetId: optionsTargetId }).catch(() => {});
    optionsTargetId = undefined;
  }

  printSummary({ reused, extensionId, swFound, pinResult, youtubeTargetId, optionsTargetId, seedResult });
  cdp.close();
}

main().catch((err) => {
  console.error(`[dev:chrome] ${err.message}`);
  process.exit(1);
});
