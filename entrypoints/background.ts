import { defineBackground } from 'wxt/sandbox';
import { saveApiKey, getApiKey, getApiKeyStatus, deleteApiKey } from '~/lib/storage';
import { testGeminiKey, analyzeGlossary, translateBatch } from '~/lib/gemini';
import { putVideo, getTranslation, putTranslation, upsertBatch } from '~/lib/db';
import { sendMessage } from '~/lib/messaging';
import { runTranslationPipeline } from '~/features/translation/pipeline';
import type {
  AppMessage,
  AppResponseMap,
  CurrentVideoState,
  ReemitVideoMessage,
  RequestTranscriptMessage,
  RequestTranscriptResponse,
} from '~/types/message';

// Latest known state per tab, keyed by the tab the content script's message
// arrived FROM (`sender.tab.id`) — never by the panel's notion of "the
// active tab", which the panel tracks for itself. In-memory only: an MV3
// service worker can be evicted and this map lost with it. That is
// acceptable rather than a bug to work around — `GET_CURRENT_VIDEO` then
// answers `null` ("no report yet"), which the panel already renders as
// loading, and the content script's settle loop (which re-emits on every
// navigation and un-eviction wakes the worker to receive it) refills the
// entry on its very next tick. Nothing here needs to survive a restart on
// its own.
const latestByTab = new Map<number, CurrentVideoState>();

export default defineBackground(() => {
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((err) => console.warn('sidePanel.setPanelBehavior failed', err));

  chrome.runtime.onMessage.addListener(
    (msg: AppMessage, sender, sendResponse) => {
      handle(msg, sender)
        .then((res) => sendResponse(res))
        .catch((err) => {
          console.error('background handler error', err);
          sendResponse(errorResponseFor(msg, err));
        });
      return true;
    },
  );

  // Drops a closed tab's entry so the map does not grow for the lifetime of
  // the browser session. Fires without the "tabs" permission (only reading
  // url/title on the event requires it, which this doesn't do).
  chrome.tabs.onRemoved.addListener((tabId) => {
    latestByTab.delete(tabId);
  });
});

export async function handle<T extends AppMessage['type']>(
  msg: Extract<AppMessage, { type: T }>,
  sender?: chrome.runtime.MessageSender,
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
    case 'VIDEO_DETECTED': {
      const { payload } = msg as Extract<AppMessage, { type: 'VIDEO_DETECTED' }>;
      const tabId = sender?.tab?.id;
      // A message with no tab (should not happen for a content script, but
      // the type only makes `sender` optional, not `sender.tab`) has nothing
      // to key the cache on — acknowledge and drop rather than throw.
      if (tabId === undefined) return { ok: true } as AppResponseMap[T];

      latestByTab.set(tabId, payload);

      // Load-bearing: only a `settled` report with a real record is safe to
      // cache. `provisional` is, by definition (see `VideoMetaReport` in
      // entrypoints/content.ts), a record the settle loop still expects to
      // improve — most pointedly a pre-roll-ad `durationSeconds: null`
      // (Task 7), which caching now would freeze at the wrong value forever.
      // `unsettled` is best-effort and may never improve, but it is still not
      // a confirmed final answer, so it is not cached either. `meta: null`
      // has nothing to persist regardless of status.
      if (payload.status === 'settled' && payload.meta !== null) {
        // `fetchedAt` is stamped HERE, not by the extractor: `ExtractedVideoMeta`
        // (what the content script produces) omits it on purpose so the
        // settle loop's byte-identity comparison (`serialised === previous`)
        // isn't broken by a timestamp that changes on every read. The cache
        // is the first and only place a `VideoMeta` (with `fetchedAt`) comes
        // into existence.
        await putVideo({ ...payload.meta, fetchedAt: new Date().toISOString() });
      }

      // Push to the panel. Polling `chrome.tabs` events (as the panel's M0
      // logic already does for tab-switch detection) cannot substitute for
      // this: a same-tab SPA transition never fires a `tabs` event the panel
      // could poll on — the content script's `yt-page-data-updated` listener
      // is the only thing that sees it, so the only way the panel learns
      // about it is a message FROM here. `sendMessage` here is fire-and-forget
      // by design (see `.catch` below): if no panel is listening — closed, or
      // open on a different tab that will filter this out by `tabId` anyway
      // — there is nothing to retry.
      void sendMessage({
        type: 'CURRENT_VIDEO_UPDATED',
        payload: { tabId, video: payload },
      }).catch(() => {
        // "Could not establish connection. Receiving end does not exist." —
        // expected whenever the panel isn't open. Not an error.
      });

      return { ok: true } as AppResponseMap[T];
    }
    case 'GET_CURRENT_VIDEO': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_CURRENT_VIDEO' }>;
      return (latestByTab.get(payload.tabId) ?? null) as AppResponseMap[T];
    }
    case 'REQUEST_VIDEO_REEMIT': {
      const { payload } = msg as Extract<AppMessage, { type: 'REQUEST_VIDEO_REEMIT' }>;
      // `chrome.runtime.sendMessage` from a service worker never reaches a
      // content script — only `chrome.tabs.sendMessage` does. This needs no
      // "tabs" permission: host_permissions for youtube.com already covers
      // messaging a youtube.com tab.
      //
      // Expected to reject whenever there is no content script to receive
      // it — a non-YouTube tab, or one that has since closed/navigated away
      // — so swallow rather than throw; the caller only cares that it tried.
      try {
        const reemit: ReemitVideoMessage = { type: 'REEMIT_VIDEO' };
        await chrome.tabs.sendMessage(payload.tabId, reemit);
      } catch {
        // "Could not establish connection. Receiving end does not exist." —
        // not an error, see above.
      }
      return { ok: true } as AppResponseMap[T];
    }
    case 'CURRENT_VIDEO_UPDATED':
      // Only ever produced by this file's own broadcast above. Handled here
      // solely so the switch — and `errorResponseFor`'s below — stay
      // exhaustive if this is ever redelivered to the sender; there is no
      // state to update on receipt.
      return { ok: true } as AppResponseMap[T];
    case 'START_TRANSLATION': {
      const { payload } = msg as Extract<AppMessage, { type: 'START_TRANSLATION' }>;
      const key = await getApiKey();
      // The one synchronous "can't even start" check per message.ts's own
      // doc comment on this response ("whether the pipeline could be
      // started", not whether it will succeed) — everything else, including
      // "this video has no transcript panel", is a normal pipeline OUTCOME
      // (a `failed` TranslationRecord), not a reason to refuse the kickoff.
      if (!key) {
        return { ok: false, error: 'API key not set' } as AppResponseMap[T];
      }

      // Fire-and-forget: START_TRANSLATION acks "accepted", not "finished".
      // The promise is intentionally not awaited/returned to the caller;
      // its rejection is only logged (there is no one left to answer by the
      // time it could reject — the ack below has already gone out).
      void runTranslationPipeline(
        { videoId: payload.videoId, tabId: payload.tabId, key },
        {
          requestTranscript: async (tabId, videoId) =>
            (await chrome.tabs.sendMessage(tabId, {
              type: 'REQUEST_TRANSCRIPT',
              videoId,
            } satisfies RequestTranscriptMessage)) as RequestTranscriptResponse,
          analyzeGlossary,
          translateBatch,
          getTranslation,
          putTranslation,
          upsertBatch,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          // TODO(Task 7): stream progress to the panel over the
          // TRANSLATION_PROGRESS_PORT Port instead. No Port exists yet, so
          // this is a log-only placeholder with no consumer.
          onProgress: (progress) => {
            console.log('[translation progress]', progress);
          },
        },
      ).catch((err) => {
        console.error('translation pipeline failed', err);
      });

      return { ok: true } as AppResponseMap[T];
    }
    case 'GET_TRANSLATION': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_TRANSLATION' }>;
      return (await getTranslation(payload.videoId)) as AppResponseMap[T];
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
    case 'VIDEO_DETECTED':
      return { ok: true };
    case 'GET_CURRENT_VIDEO':
      return null;
    case 'REQUEST_VIDEO_REEMIT':
      return { ok: true };
    case 'CURRENT_VIDEO_UPDATED':
      return { ok: true };
    case 'START_TRANSLATION':
      return { ok: false, error: message };
    case 'GET_TRANSLATION':
      return null;
  }
}
