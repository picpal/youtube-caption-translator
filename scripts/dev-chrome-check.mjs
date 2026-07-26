#!/usr/bin/env node
// Verifies a running dev:chrome instance end-to-end:
//   1. extension service worker target exists
//   2. SAVE_API_KEY -> GET_API_KEY_STATUS -> DELETE_API_KEY round-trips
//      through the real background service worker, chrome.storage.local,
//      and handle() in entrypoints/background.ts
//   3. TEST_API_KEY is deliberately NOT called (hits real Gemini API/quota)
//   4. screenshots options.html and sidepanel.html
//
// Exits non-zero on any assertion failure. Always attempts to delete the
// fake key it created, even if an earlier assertion failed.
//
// Usage: pnpm dev:chrome:check
import fs from 'node:fs';
import path from 'node:path';
import {
  DEBUG_PORT,
  OUTPUT_DIR,
  FAKE_API_KEY,
  FAKE_API_KEY_MASK,
  getBackgroundScriptName,
} from './lib/config.mjs';
import {
  CDP,
  getDebugInfo,
  attachAndEnableRuntime,
  evalJson,
  waitForExtensionPageReady,
  findExtensionServiceWorker,
} from './lib/cdp.mjs';

const failures = [];

function assertTrue(cond, msg) {
  if (cond) {
    console.log(`  [PASS] ${msg}`);
  } else {
    console.log(`  [FAIL] ${msg}`);
    failures.push(msg);
  }
}

function sendMessageExpr(type, payload) {
  const msg = payload === undefined ? { type } : { type, payload };
  const literal = JSON.stringify(msg);
  return `(async () => { try { return { __ok: true, value: await chrome.runtime.sendMessage(${literal}) }; } catch (e) { return { __ok: false, error: String(e) }; } })()`;
}

async function main() {
  console.log('[dev:chrome:check] Connecting to Chrome debug port...');
  const info = await getDebugInfo(DEBUG_PORT);
  if (!info) {
    console.error(`[dev:chrome:check] Nothing responding on port ${DEBUG_PORT}.`);
    console.error('[dev:chrome:check] Run `pnpm dev:chrome` first.');
    process.exit(1);
  }
  const cdp = await CDP.connect(info.webSocketDebuggerUrl);

  console.log('\n1. Extension service worker target');
  const workerScriptName = getBackgroundScriptName();
  const sw = await findExtensionServiceWorker(cdp, workerScriptName);
  assertTrue(Boolean(sw), 'extension service worker target exists');
  if (!sw) {
    console.error('\n[dev:chrome:check] Cannot continue without a service worker target.');
    cdp.close();
    process.exit(1);
  }
  const extensionId = new URL(sw.url).host;
  console.log(`  extension id: ${extensionId}`);

  console.log('\n2. Message round trip (SAVE_API_KEY -> GET_API_KEY_STATUS -> DELETE_API_KEY)');
  const { targetId: optionsTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/options.html`,
  });
  const optionsSession = await attachAndEnableRuntime(cdp, optionsTargetId);
  const ready = await waitForExtensionPageReady(cdp, optionsSession);
  assertTrue(ready, 'options.html loaded chrome.runtime.sendMessage in time');

  let deleteRes = null;
  try {
    const saveRes = await evalJson(cdp, optionsSession, sendMessageExpr('SAVE_API_KEY', { key: FAKE_API_KEY }));
    assertTrue(saveRes.__ok, `SAVE_API_KEY sendMessage resolved without throwing (${saveRes.error ?? ''})`);
    assertTrue(saveRes.value?.ok === true, `SAVE_API_KEY response.ok === true (got ${JSON.stringify(saveRes.value)})`);
    assertTrue(saveRes.value?.status?.present === true, 'SAVE_API_KEY response.status.present === true');
    assertTrue(
      saveRes.value?.status?.maskedKey === FAKE_API_KEY_MASK,
      `SAVE_API_KEY response.status.maskedKey === ${FAKE_API_KEY_MASK} (got ${saveRes.value?.status?.maskedKey})`,
    );

    const getRes1 = await evalJson(cdp, optionsSession, sendMessageExpr('GET_API_KEY_STATUS'));
    assertTrue(getRes1.__ok, `GET_API_KEY_STATUS sendMessage resolved without throwing (${getRes1.error ?? ''})`);
    assertTrue(getRes1.value?.present === true, 'GET_API_KEY_STATUS response.present === true');
    assertTrue(
      getRes1.value?.maskedKey === FAKE_API_KEY_MASK,
      `GET_API_KEY_STATUS response.maskedKey === ${FAKE_API_KEY_MASK} (got ${getRes1.value?.maskedKey})`,
    );
  } catch (err) {
    console.error(`  [ERROR] round trip threw before cleanup: ${err.message}`);
    failures.push(`round trip threw: ${err.message}`);
  } finally {
    // Always attempt cleanup, even if an assertion above failed.
    deleteRes = await evalJson(cdp, optionsSession, sendMessageExpr('DELETE_API_KEY')).catch((err) => {
      console.error(`  [ERROR] DELETE_API_KEY eval threw: ${err.message}`);
      return null;
    });
  }

  assertTrue(deleteRes?.__ok === true, 'DELETE_API_KEY sendMessage resolved without throwing');
  assertTrue(deleteRes?.value?.ok === true, `DELETE_API_KEY response.ok === true (got ${JSON.stringify(deleteRes?.value)})`);

  const getRes2 = await evalJson(cdp, optionsSession, sendMessageExpr('GET_API_KEY_STATUS'));
  assertTrue(getRes2.__ok, 'final GET_API_KEY_STATUS sendMessage resolved without throwing');
  assertTrue(getRes2.value?.present === false, 'final GET_API_KEY_STATUS response.present === false (fake key cleaned up, none left behind)');

  console.log('\n3. TEST_API_KEY: intentionally skipped — it calls the real Gemini endpoint and would fail or burn quota.');

  console.log('\n4. Screenshots');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  await cdp.send('Page.enable', {}, optionsSession);
  await new Promise((r) => setTimeout(r, 400));
  const optionsShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, optionsSession);
  const optionsPath = path.join(OUTPUT_DIR, 'options.png');
  fs.writeFileSync(optionsPath, Buffer.from(optionsShot.data, 'base64'));
  console.log(`  saved ${optionsPath}`);

  const { targetId: sidepanelTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel.html`,
  });
  const sidepanelSession = await attachAndEnableRuntime(cdp, sidepanelTargetId);
  await waitForExtensionPageReady(cdp, sidepanelSession);
  await cdp.send('Page.enable', {}, sidepanelSession);
  await new Promise((r) => setTimeout(r, 400));
  const sidepanelShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sidepanelSession);
  const sidepanelPath = path.join(OUTPUT_DIR, 'sidepanel.png');
  fs.writeFileSync(sidepanelPath, Buffer.from(sidepanelShot.data, 'base64'));
  console.log(`  saved ${sidepanelPath}`);
  console.log('  NOTE: this is sidepanel.html rendered as a normal tab, not the docked side panel (see README limitation).');

  await cdp.send('Target.closeTarget', { targetId: optionsTargetId }).catch(() => {});
  await cdp.send('Target.closeTarget', { targetId: sidepanelTargetId }).catch(() => {});
  cdp.close();

  console.log('\n--- Summary ---');
  if (failures.length === 0) {
    console.log('All checks passed.');
    process.exit(0);
  } else {
    console.log(`${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[dev:chrome:check] Unhandled error: ${err.stack || err.message}`);
  process.exit(1);
});
