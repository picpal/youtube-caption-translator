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
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    },
  );
});

async function handle(msg: AppMessage): Promise<AppResponseMap[AppMessage['type']]> {
  switch (msg.type) {
    case 'SAVE_API_KEY': {
      try {
        await saveApiKey(msg.payload.key);
        const status = await getApiKeyStatus();
        return { ok: true, status };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'GET_API_KEY_STATUS':
      return getApiKeyStatus();
    case 'DELETE_API_KEY':
      await deleteApiKey();
      return { ok: true };
    case 'TEST_API_KEY': {
      const key = await getApiKey();
      if (!key) {
        return { ok: false, reason: 'unauthorized', message: 'API key not set' };
      }
      return testGeminiKey(key);
    }
  }
}
