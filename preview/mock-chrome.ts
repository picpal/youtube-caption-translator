// Minimal `chrome.*` shim for the local preview harness.
//
// This file is imported (via the per-surface `*-entry.ts` files) *before*
// the real entrypoint `main.tsx`, so that by the time popup/options/sidepanel
// code touches `chrome.storage`, `chrome.runtime`, `chrome.tabs`, or
// `chrome.sidePanel`, a working stand-in already exists on `window`.
//
// Production code under entrypoints/ and src/ is completely unmodified and
// unaware of this file — this is the only place in the repo that knows it
// isn't running inside a real extension.
//
// `TEST_API_KEY` never makes a real Gemini call here: it returns a canned
// `GeminiTestResult` selected by the dev panel (see ./dev-panel.ts), after a
// small artificial delay so the "testing" spinner is visible.

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
  },
  tabs: {
    query: async (_queryInfo?: unknown) => {
      const { tabKind } = readMeta();
      return [
        {
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
        },
      ];
    },
  },
  sidePanel: {
    open: async (_options?: unknown) => {
      window.location.href = './sidepanel.html';
    },
  },
};

(window as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;

// Apply the persisted light/dark preference before the app renders (avoids a
// flash of the wrong theme), then mount the harness-only dev panel.
applyStoredTheme();
void mountDevPanel();
