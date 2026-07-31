// Minimal `chrome.*` shim for the local preview harness.
//
// This file is imported (via the per-surface `*-entry.ts` files) *before*
// the real entrypoint `main.tsx`, so that by the time options/sidepanel code
// touches `chrome.storage`, `chrome.runtime`, or `chrome.tabs`, a working
// stand-in already exists on `window`.
//
// Production code under entrypoints/ and src/ is completely unmodified and
// unaware of this file — this is the only place in the repo that knows it
// isn't running inside a real extension.
//
// `TEST_API_KEY` never makes a real Gemini call here: it returns a canned
// `GeminiTestResult` selected by the dev panel (see ./dev-panel.ts), after a
// small artificial delay so the "testing" spinner is visible.

import pkg from '../package.json';
import { deleteApiKey, getApiKey, getApiKeyStatus, saveApiKey } from '~/lib/storage';
import type { AppMessage, AppResponseMap, GeminiTestResult } from '~/types/message';
import { applyStoredTheme, mountDevPanel } from './dev-panel';
import {
  addStorageListener,
  readMeta,
  removeStorageListener,
  storageGet,
  storageRemove,
  storageSet,
  tabUrlFor,
  type ChangeListener,
  type TestResultKind,
} from './state';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Very small subset of chrome's match-pattern semantics: only `*` as a
// wildcard, everything else literal. Good enough for the one pattern this
// app actually uses ('https://www.youtube.com/watch*').
function matchesUrlPattern(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

function matchesAnyUrlPattern(url: string, patterns: string | string[]): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((pattern) => matchesUrlPattern(url, pattern));
}

// The tab hosting *this* preview page (options.html), distinct from the
// switcher-driven "current tab" below (which stands in for whatever tab the
// side panel would be attached to, e.g. a YouTube tab). Options opens
// in its own tab in the real extension, so it needs its own fake id.
const FAKE_OPTIONS_TAB_ID = 2;

function cannedResult(kind: TestResultKind): GeminiTestResult {
  switch (kind) {
    case 'ok':
      return {
        ok: true,
        latencyMs: 240 + Math.round(Math.random() * 160),
        model: 'gemini-2.5-flash',
      };
    case 'unauthorized':
      return { ok: false, reason: 'unauthorized', message: '[mock] API key rejected (401)' };
    case 'rate_limit':
      return { ok: false, reason: 'rate_limit', message: '[mock] Rate limit exceeded (429)' };
    case 'network':
      return { ok: false, reason: 'network', message: '[mock] Failed to fetch (network error)' };
    case 'unknown':
      return { ok: false, reason: 'unknown', message: '[mock] Unexpected server error (500)' };
  }
}

// Mirrors entrypoints/background.ts's `handle()` against the mock store
// instead of the real chrome.storage/background message bus (there is no
// service worker in this harness). Reuses ~/lib/storage as-is since it only
// touches chrome.storage.local, which is mocked below.
async function handleMessage<T extends AppMessage['type']>(
  msg: Extract<AppMessage, { type: T }>,
): Promise<AppResponseMap[T]> {
  switch (msg.type) {
    case 'SAVE_API_KEY': {
      try {
        await saveApiKey(msg.payload.key);
        const status = await getApiKeyStatus();
        return { ok: true, status } as AppResponseMap[T];
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as AppResponseMap[T];
      }
    }
    case 'GET_API_KEY_STATUS':
      return (await getApiKeyStatus()) as AppResponseMap[T];
    case 'DELETE_API_KEY':
      await deleteApiKey();
      return { ok: true } as AppResponseMap[T];
    case 'TEST_API_KEY': {
      const key = await getApiKey();
      await delay(700);
      if (!key) {
        return {
          ok: false,
          reason: 'unauthorized',
          message: '[mock] API key not set',
        } as AppResponseMap[T];
      }
      return cannedResult(readMeta().nextTestResult) as AppResponseMap[T];
    }
  }
  throw new Error(`[preview mock] unhandled message type: ${(msg as AppMessage).type}`);
}

const mockChrome = {
  storage: {
    local: {
      get: async (keys?: string | string[] | Record<string, unknown> | null) => storageGet(keys),
      set: async (items: Record<string, unknown>) => storageSet(items),
      remove: async (keys: string | string[]) => storageRemove(keys),
    },
    onChanged: {
      addListener: (listener: ChangeListener) => addStorageListener(listener),
      removeListener: (listener: ChangeListener) => removeStorageListener(listener),
    },
  },
  runtime: {
    sendMessage: (msg: AppMessage) => handleMessage(msg as never),
    openOptionsPage: async () => {
      window.location.href = './options.html';
    },
    // Sourced from package.json (not hardcoded) so this mock can't drift from
    // the real manifest version the way entrypoints/options/App.tsx's footer
    // used to before it started reading chrome.runtime.getManifest() itself.
    getManifest: () => ({ manifest_version: 3, version: pkg.version }),
  },
  tabs: {
    // `queryInfo.url` drives the entrypoints/options/App.tsx "YouTube 탭으로
    // 돌아가기" show/hide logic: it should resolve against whatever the DEV
    // PREVIEW panel's "현재 탭" switcher (state.ts's `tabKind`) is currently
    // set to, so that switching the fake tab to a watch-page state is enough
    // to exercise the real button-visibility logic with no other changes.
    query: async (queryInfo?: { url?: string | string[]; active?: boolean; currentWindow?: boolean }) => {
      const { tabKind } = readMeta();
      const fakeCurrentTab = {
        id: 1,
        index: 0,
        windowId: 1,
        active: true,
        highlighted: true,
        pinned: false,
        incognito: false,
        selected: true,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
        url: tabUrlFor(tabKind),
        title: '[Preview] Fake Tab',
      };
      if (queryInfo?.url != null) {
        return matchesAnyUrlPattern(fakeCurrentTab.url, queryInfo.url) ? [fakeCurrentTab] : [];
      }
      return [fakeCurrentTab];
    },
    // Stands in for the Options tab itself (see FAKE_OPTIONS_TAB_ID above) —
    // used by the "설정 닫기" button to find its own tab id to remove.
    getCurrent: async () => ({
      id: FAKE_OPTIONS_TAB_ID,
      index: 0,
      windowId: 1,
      active: true,
      highlighted: true,
      pinned: false,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      url: window.location.href,
      title: '[Preview] Options Tab',
    }),
    // A real browser tab can't be closed from inside itself here, so this
    // mocks the *effect* users care about — "the Options tab is gone" — by
    // sending them back to the harness launcher instead.
    remove: async (tabId: number | number[]) => {
      console.log('[mock] chrome.tabs.remove', tabId, '-> navigating to preview launcher (./index.html)');
      window.location.href = './index.html';
    },
    update: async (tabId: number, updateProperties: Record<string, unknown>) => {
      console.log('[mock] chrome.tabs.update', tabId, updateProperties, '-> would focus this tab');
    },
  },
  windows: {
    update: async (windowId: number, updateInfo: Record<string, unknown>) => {
      console.log('[mock] chrome.windows.update', windowId, updateInfo, '-> would focus this window');
    },
  },
};

(window as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;

// Real MV3 side panel documents close themselves via `window.close()` (see
// entrypoints/sidepanel/App.tsx's "패널 닫기" button), and that's the correct
// production call — real Chrome honors it there. But in this harness every
// surface is just a plain page opened by navigation, not `window.open()`
// from script, so the browser silently no-ops `window.close()`: no error,
// no visible change, nothing to click through in a local test pass.
//
// Overridden here (not per-surface) so *any* harness page that calls
// `window.close()` — not just the side panel — gets an observable result.
// Mirrors the `[mock] chrome.tabs.remove ...` logging convention above.
//
// Renders a "closed" placeholder in place of #root rather than navigating
// away (contrast with chrome.tabs.remove's redirect to ./index.html): a
// side panel closing is not the same action as an Options tab closing, and
// swapping #root's content — instead of leaving the page — is what actually
// demonstrates *closing* while keeping the DEV PREVIEW panel (appended
// directly to document.body, untouched by this) usable to get back.
window.close = () => {
  console.log('[mock] window.close()', '-> rendering closed placeholder in #root');
  renderClosedPlaceholder();
};

function renderClosedPlaceholder(): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div class="flex min-h-[280px] flex-col items-center justify-center gap-3 bg-white p-6 text-center dark:bg-neutral-950">
      <p class="text-sm font-medium text-neutral-700 dark:text-neutral-300">패널이 닫혔습니다</p>
      <button
        type="button"
        data-action="ypa-reopen"
        class="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        다시 열기
      </button>
    </div>
  `;
  root.querySelector('[data-action="ypa-reopen"]')?.addEventListener('click', () => {
    location.reload();
  });
}

// Apply the persisted light/dark preference before the app renders (avoids a
// flash of the wrong theme), then mount the harness-only dev panel.
applyStoredTheme();
void mountDevPanel();
