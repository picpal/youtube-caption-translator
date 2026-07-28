import { defineBackground } from 'wxt/sandbox';
import { saveApiKey, getApiKey, getApiKeyStatus, deleteApiKey } from '~/lib/storage';
import { testGeminiKey, analyzeGlossary, translateBatch } from '~/lib/gemini';
import { putVideo, getTranslation, putTranslation, upsertBatch } from '~/lib/db';
import { sendMessage } from '~/lib/messaging';
import { runTranslationPipeline } from '~/features/translation/pipeline';
import { broadcastToPorts } from '~/features/translation/progress-broadcast';
import { TRANSLATION_PROGRESS_PORT } from '~/types/message';
import type {
  AppMessage,
  AppResponseMap,
  CurrentVideoState,
  ReemitVideoMessage,
  RequestTranscriptMessage,
  RequestTranscriptResponse,
} from '~/types/message';
import type { TranslationProgress } from '~/types/transcript';

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

// M2 Task 7 — panels currently connected on the translation-progress
// channel. One entry per open panel Port; a panel that reconnects mid-job
// (e.g. closed and reopened) starts receiving progress events from that
// point on — it does NOT get replayed history, since a Port has no memory
// of messages sent before it connected. A reopened panel instead learns how
// far an in-progress job already got from the persisted `TranslationRecord`
// (`GET_TRANSLATION`, Task 6), which is exactly what `useTranslation`
// (Task 7) pulls before deciding whether to auto-resume.
const progressPorts = new Set<chrome.runtime.Port>();

// Fans a progress event out to every connected panel. Wraps the actual
// posting in `broadcastToPorts` (progress-broadcast.ts) so a since-closed
// port can't throw out of this call and abort the pipeline mid-broadcast;
// a throwing port is pruned on the spot rather than left to throw again
// next time.
function broadcastProgress(progress: TranslationProgress): void {
  broadcastToPorts(progressPorts, progress);
}

// videoIds with a translation pipeline currently running in this service
// worker. THIS IS WHAT MAKES PANEL-REOPEN AUTO-RESUME SAFE: `useTranslation`
// (Task 7) calls `START_TRANSLATION` unconditionally whenever a loaded
// record is still in-progress, with no way for the panel to know on its own
// whether a job for that video is already running here — two panels open on
// the same video, or a reopen racing an already-running job, would otherwise
// each kick off their own pipeline: wasted Gemini calls, and two writers
// racing on the same persisted record (Task 3's `upsertBatch` is per-call
// idempotent, but running the SAME batch work twice concurrently is still
// pure waste, not a correctness feature). A plain `Set<string>` is enough —
// nothing here needs to await the running job's result, only know that one
// exists; see the `START_TRANSLATION` handler below for the add/delete.
const inFlightTranslations = new Set<string>();

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

  // Registers/deregisters a panel's translation-progress Port. A connected
  // Port is also what keeps this service worker alive for the duration of a
  // streaming job — Chrome resets a service worker's idle timer on Port
  // activity, and every batch's `onProgress` call (`broadcastProgress`
  // above) posts a message on this same channel while a job is actually
  // running. No separate keepalive ping is added on top of that: Task 6's
  // per-batch persistence + resume already makes a worker eviction
  // recoverable regardless (the Port is the belt, persist+resume is the
  // suspenders) — an eviction mid-job just means progress streaming pauses
  // until the panel's next reconnect, not that the job's work is lost, and
  // `chrome.alarms` is deliberately not used to paper over that (M2 scope).
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TRANSLATION_PROGRESS_PORT) return;
    progressPorts.add(port);
    port.onDisconnect.addListener(() => {
      progressPorts.delete(port);
    });
  });

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

      // Dedup (see `inFlightTranslations` above): a job for this video is
      // already running — this call is either a genuine double-click, two
      // panels open on the same video, or the panel's own auto-resume
      // racing a job it is already attached to via the Port. Either way the
      // honest answer is "already running, ack accepted" — not a second
      // pipeline.
      if (!inFlightTranslations.has(payload.videoId)) {
        inFlightTranslations.add(payload.videoId);

        // Fire-and-forget: START_TRANSLATION acks "accepted", not
        // "finished". The promise is intentionally not awaited/returned to
        // the caller; its rejection is only logged (there is no one left to
        // answer by the time it could reject — the ack below has already
        // gone out). `.finally` removes this video from the in-flight set
        // regardless of outcome, so a later START_TRANSLATION (a real
        // retry, or a future resume) is never dedup'd against a job that
        // has already settled.
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
            onProgress: broadcastProgress,
          },
        )
          .catch((err) => {
            console.error('translation pipeline failed', err);
          })
          .finally(() => {
            inFlightTranslations.delete(payload.videoId);
          });
      }

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
