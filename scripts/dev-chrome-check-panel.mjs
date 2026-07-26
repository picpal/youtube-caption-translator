#!/usr/bin/env node
// Verifies the REAL docked side panel (not a tab pointed at sidepanel.html)
// against a real YouTube watch page. This cannot be triggered
// programmatically: chrome.sidePanel.open() requires a genuine user gesture
// from within the extension's own toolbar-icon click handler, and even a
// CDP-dispatched, browser-trusted synthetic click does not satisfy that
// (confirmed previously — see README "Known limitation"). So this script
// does not open the panel; it only detects and asserts against it once a
// human has opened it by clicking the pinned toolbar icon.
//
// Usage: pnpm dev:chrome:check:panel
import fs from 'node:fs';
import path from 'node:path';
import { DEBUG_PORT, OUTPUT_DIR, BUILD_DIR } from './lib/config.mjs';
import {
  CDP,
  getDebugInfo,
  attachAndEnableRuntime,
  evalJson,
  findExtensionPageTargets,
  waitForExtensionPageReady,
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

const PANEL_CHECK_EXPR = `(() => {
  const bodyText = document.body.innerText || '';
  const buttons = Array.from(document.querySelectorAll('button'));
  const generateBtn = buttons.find((b) => b.textContent && b.textContent.includes('AI 자막 생성'));
  return {
    hasSubtitleLabel: bodyText.includes('자막 표시'),
    hasNonYoutubeMessage: bodyText.includes('유튜브 영상 페이지로 이동해주세요'),
    hasGenerateButton: Boolean(generateBtn),
    generateButtonDisabled: generateBtn ? generateBtn.disabled === true : null,
    bodyTextSnippet: bodyText.slice(0, 200),
  };
})()`;

async function pollPanelState(cdp, sessionId, timeoutMs = 5000, intervalMs = 300) {
  const start = Date.now();
  let state = await evalJson(cdp, sessionId, PANEL_CHECK_EXPR);
  while (
    !state.hasSubtitleLabel &&
    !state.hasNonYoutubeMessage &&
    Date.now() - start < timeoutMs
  ) {
    await new Promise((r) => setTimeout(r, intervalMs));
    state = await evalJson(cdp, sessionId, PANEL_CHECK_EXPR);
  }
  return state;
}

async function main() {
  console.log('[dev:chrome:check:panel] Connecting to Chrome debug port...');
  const info = await getDebugInfo(DEBUG_PORT);
  if (!info) {
    console.error(`[dev:chrome:check:panel] Nothing responding on port ${DEBUG_PORT}.`);
    console.error('[dev:chrome:check:panel] Run `pnpm dev:chrome` first.');
    process.exit(1);
  }
  const cdp = await CDP.connect(info.webSocketDebuggerUrl);
  const extensionId = computeExtensionId(BUILD_DIR);
  console.log(`  extension id (derived from build path): ${extensionId}`);

  console.log('\n1. Looking for a sidepanel.html target');
  const targets = await findExtensionPageTargets(cdp, extensionId, 'sidepanel.html');

  if (targets.length === 0) {
    console.log('  [NONE FOUND]');
    console.log('');
    console.log('사이드 패널이 열려 있지 않습니다.');
    console.log('1. Karpathy 영상 탭(YouTube watch 페이지)으로 전환하세요.');
    console.log('2. 툴바에 고정된 확장 프로그램 아이콘을 클릭해 사이드 패널을 여세요.');
    console.log('3. 패널이 열린 상태에서 이 명령을 다시 실행하세요: pnpm dev:chrome:check:panel');
    cdp.close();
    process.exit(1);
  }

  console.log(`  found ${targets.length} target(s) for chrome-extension://${extensionId}/sidepanel.html:`);
  for (const t of targets) {
    console.log(`    - type=${t.type} targetId=${t.targetId} title=${JSON.stringify(t.title)} attached=${t.attached}`);
  }

  // If there are multiple matches (e.g. a stray tab left over from a
  // previous check run, plus the real docked panel), prefer one whose type
  // differs from "page" (a plain tab is always type "page"); otherwise
  // fall back to the first match and say so.
  const nonPageTarget = targets.find((t) => t.type !== 'page');
  const chosen = nonPageTarget ?? targets[0];
  if (!nonPageTarget) {
    console.log(
      '  LIMITATION (stated plainly): every matching target reports type="page" — on this Chrome version, ' +
        'the docked side panel and a plain tab pointed at the same chrome-extension://<id>/sidepanel.html URL ' +
        'are INDISTINGUISHABLE by `Target.getTargets()` type alone. This check proceeds with the first match ' +
        'and verifies its rendered content (below), but that alone does NOT prove the target is the actual ' +
        'docked panel rather than a tab someone opened at the same URL. Treat this as content verification, ' +
        'not proof of docking — true docking can currently only be confirmed by looking at the browser window.',
    );
  } else {
    console.log(`  Using target with type="${chosen.type}" (distinguishable from a plain "page" tab).`);
  }

  console.log('\n2. Reloading the panel for a deterministic reading');
  // KNOWN PRODUCT BUG (tracked separately, NOT fixed here — do not touch
  // entrypoints/): the panel's active-tab detection in
  // entrypoints/sidepanel/App.tsx runs once on mount via chrome.tabs.query
  // and never re-reacts to tab switches. So the panel's rendered branch
  // depends on which tab was active at the moment it was *opened*, not the
  // moment this check runs — without a reload, this check's result would
  // silently depend on click order (YouTube tab active before opening the
  // panel vs. after). Reloading forces a fresh mount against whatever tab
  // is active *right now*, making this check's result deterministic
  // regardless of when/how the panel was opened.
  const sessionId = await attachAndEnableRuntime(cdp, chosen.targetId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.reload', {}, sessionId);
  const readyAfterReload = await waitForExtensionPageReady(cdp, sessionId);
  assertTrue(readyAfterReload, 'panel reloaded and chrome.runtime.sendMessage became available again');

  console.log('\n3. Asserting the panel rendered the READY branch (real YouTube watch tab)');
  const state = await pollPanelState(cdp, sessionId);
  console.log(`  body text snippet: ${JSON.stringify(state.bodyTextSnippet)}`);

  assertTrue(state.hasSubtitleLabel, 'panel shows the READY-branch "자막 표시" label');
  assertTrue(!state.hasNonYoutubeMessage, 'panel does NOT show the non-YouTube "유튜브 영상 페이지로 이동해주세요" message');
  assertTrue(state.hasGenerateButton, 'panel shows the "AI 자막 생성" button');
  assertTrue(state.generateButtonDisabled === true, '"AI 자막 생성" button is disabled (M1 not landed yet)');

  console.log('\n4. Screenshot');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await cdp.send('Page.enable', {}, sessionId);
  await new Promise((r) => setTimeout(r, 300));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const shotPath = path.join(OUTPUT_DIR, 'sidepanel-docked.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`  saved ${shotPath}`);

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
  console.error(`[dev:chrome:check:panel] Unhandled error: ${err.stack || err.message}`);
  process.exit(1);
});
