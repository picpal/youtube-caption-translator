import { defineBackground } from 'wxt/sandbox';
import { saveApiKey, getApiKey, getApiKeyStatus, deleteApiKey } from '~/lib/storage';
import { testGeminiKey } from '~/lib/gemini';
import type { AppMessage, AppResponseMap } from '~/types/message';

export default defineBackground(() => {
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((err) => console.warn('sidePanel.setPanelBehavior failed', err));

  chrome.runtime.onMessage.addListener(
    (msg: AppMessage, _sender, sendResponse) => {
      handle(msg)
        .then((res) => sendResponse(res))
        .catch((err) => {
          console.error('background handler error', err);
          sendResponse(errorResponseFor(msg, err));
        });
      return true;
    },
  );
});

async function handle<T extends AppMessage['type']>(
  msg: Extract<AppMessage, { type: T }>,
): Promise<AppResponseMap[T]> {
  switch (msg.type) {
    case 'SAVE_API_KEY': {
      const { payload } = msg as Extract<AppMessage, { type: 'SAVE_API_KEY' }>;
      try {
        await saveApiKey(payload.key);
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
      if (!key) {
        return { ok: false, reason: 'unauthorized', message: 'API key not set' } as AppResponseMap[T];
      }
      return (await testGeminiKey(key)) as AppResponseMap[T];
    }
  }
  throw new Error(`Unhandled message type: ${(msg as AppMessage).type}`);
}

function errorResponseFor(msg: AppMessage, err: unknown): AppResponseMap[AppMessage['type']] {
  const message = err instanceof Error ? err.message : String(err);
  switch (msg.type) {
    case 'SAVE_API_KEY':
      return { ok: false, error: message };
    case 'GET_API_KEY_STATUS':
      return { present: false };
    case 'DELETE_API_KEY':
      return { ok: true };
    case 'TEST_API_KEY':
      return { ok: false, reason: 'unknown', message };
  }
}
