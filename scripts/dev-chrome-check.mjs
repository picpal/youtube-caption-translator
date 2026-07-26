#!/usr/bin/env node
// Verifies a running dev:chrome instance end-to-end:
//   1. Wakes (or confirms) the extension service worker target — MV3 service
//      workers are evicted after ~30s idle, so this never assumes one is
//      already there. It opens/uses an extension page target, which wakes
//      the worker, then polls with a bounded retry before asserting.
//   2. GET_API_KEY_STATUS through the real background service worker,
//      chrome.storage.local, and handle() in entrypoints/background.ts.
//      If a real key is already saved, SAVE_API_KEY/DELETE_API_KEY are
//      SKIPPED (not run) so this check can never destroy a user's saved
//      credential — only the read-only GET path is exercised. The full
//      SAVE -> GET -> DELETE -> GET round trip with an obviously-fake key
//      only runs when no key is present yet (nothing to lose).
//   3. TEST_API_KEY is deliberately NOT called (hits real Gemini API/quota)
//   4. screenshots options.html and sidepanel.html
//
// Exits non-zero on any assertion failure. Skipping SAVE/DELETE because a
// real key is present is NOT a failure — it's reported clearly (in Korean)
// and the process still exits 0 if everything else passes.
//
// Usage: pnpm dev:chrome:check
import fs from 'node:fs';
import path from 'node:path';
import {
  DEBUG_PORT,
  OUTPUT_DIR,
  BUILD_DIR,
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
  waitForExtensionServiceWorker,
} from './lib/cdp.mjs';
import { computeExtensionId } from './lib/extension-id.mjs';

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
  const workerScriptName = getBackgroundScriptName();

  console.log('\n1. Extension service worker target (waking it if evicted)');
  // Don't assume a service worker target already exists — MV3 evicts them
  // after ~30s idle. Figure out the extension id from the build path
  // (deterministic, no live target required), then open an extension page,
  // which is what actually wakes a dormant/evicted worker.
  const expectedExtensionId = computeExtensionId(BUILD_DIR);
  console.log(`  extension id (derived from build path): ${expectedExtensionId}`);

  const preexistingSw = await findExtensionServiceWorker(cdp, workerScriptName);
  if (preexistingSw) {
    console.log('  service worker was already active (not evicted).');
  } else {
    console.log('  no active service worker target yet — opening options.html to wake it...');
  }

  const { targetId: optionsTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${expectedExtensionId}/options.html`,
  });
  const optionsSession = await attachAndEnableRuntime(cdp, optionsTargetId);
  const ready = await waitForExtensionPageReady(cdp, optionsSession);
  assertTrue(ready, 'options.html loaded chrome.runtime.sendMessage in time');

  const sw = await waitForExtensionServiceWorker(cdp, workerScriptName, 10000);
  assertTrue(Boolean(sw), 'extension service worker target exists after opening an extension page to wake it');
  if (!sw) {
    console.error('\n[dev:chrome:check] Cannot continue without a service worker target.');
    await cdp.send('Target.closeTarget', { targetId: optionsTargetId }).catch(() => {});
    cdp.close();
    process.exit(1);
  }
  const extensionId = new URL(sw.url).host;
  console.log(`  extension id (confirmed live): ${extensionId}`);
  if (extensionId !== expectedExtensionId) {
    console.warn(
      `  NOTE: live extension id (${extensionId}) differs from the id derived from the build path ` +
        `(${expectedExtensionId}) — options.html target was opened against the derived id, which may ` +
        `now be stale. Investigate before trusting the rest of this run.`,
    );
  }

  console.log('\n2. API key status (non-destructive by default)');
  let deleteRes = null;
  let roundTripMode; // 'skipped-key-present' | 'full-fake-key'
  try {
    const statusRes = await evalJson(cdp, optionsSession, sendMessageExpr('GET_API_KEY_STATUS'));
    assertTrue(statusRes.__ok, `GET_API_KEY_STATUS sendMessage resolved without throwing (${statusRes.error ?? ''})`);

    const present = statusRes.value?.present === true;

    if (present) {
      roundTripMode = 'skipped-key-present';
      console.log(`  실제 API 키가 저장되어 있습니다 (maskedKey: ${statusRes.value?.maskedKey}).`);
      console.log(
        '  SAVE_API_KEY / DELETE_API_KEY 왕복 테스트는 건너뜁니다 — 사용자의 실제 키를 절대 덮어쓰거나 삭제하지 않습니다.',
      );
      assertTrue(
        typeof statusRes.value?.maskedKey === 'string' && statusRes.value.maskedKey.length > 0,
        'GET_API_KEY_STATUS returns a masked (never raw) key value for the present key',
      );
      console.log('  [SKIP] SAVE_API_KEY -> GET_API_KEY_STATUS -> DELETE_API_KEY round trip (real key present)');
    } else {
      roundTripMode = 'full-fake-key';
      console.log('  no key present — running the full SAVE -> GET -> DELETE round trip with a fake key.');
      assertTrue(statusRes.value?.present === false, 'GET_API_KEY_STATUS response.present === false (no key yet)');

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
    }
  } catch (err) {
    console.error(`  [ERROR] key-status check threw: ${err.message}`);
    failures.push(`key-status check threw: ${err.message}`);
  } finally {
    if (roundTripMode === 'full-fake-key') {
      // Only clean up the fake key we ourselves created. Never called when
      // a real key was present (roundTripMode stays 'skipped-key-present'
      // and this block is skipped entirely).
      deleteRes = await evalJson(cdp, optionsSession, sendMessageExpr('DELETE_API_KEY')).catch((err) => {
        console.error(`  [ERROR] DELETE_API_KEY eval threw: ${err.message}`);
        return null;
      });
    }
  }

  if (roundTripMode === 'full-fake-key') {
    assertTrue(deleteRes?.__ok === true, 'DELETE_API_KEY sendMessage resolved without throwing');
    assertTrue(deleteRes?.value?.ok === true, `DELETE_API_KEY response.ok === true (got ${JSON.stringify(deleteRes?.value)})`);

    const getRes2 = await evalJson(cdp, optionsSession, sendMessageExpr('GET_API_KEY_STATUS'));
    assertTrue(getRes2.__ok, 'final GET_API_KEY_STATUS sendMessage resolved without throwing');
    assertTrue(getRes2.value?.present === false, 'final GET_API_KEY_STATUS response.present === false (fake key cleaned up, none left behind)');
  }

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
    console.log('All checks passed.' + (roundTripMode === 'skipped-key-present' ? ' (SAVE/DELETE round trip skipped — real key preserved)' : ''));
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
