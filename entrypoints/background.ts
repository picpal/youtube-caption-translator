import { defineBackground } from 'wxt/sandbox';
import { saveApiKey, getApiKey, getApiKeyStatus, deleteApiKey } from '~/lib/storage';
import { testGeminiKey, analyzeGlossary, translateBatch, generateSummary, MODEL_ID } from '~/lib/gemini';
import { putVideo, getVideo, getTranslation, putTranslation, upsertBatch, getSummary, putSummary } from '~/lib/db';
import { sendMessage } from '~/lib/messaging';
import { getTargetLang } from '~/lib/target-lang';
import { runTranslationPipeline } from '~/features/translation/pipeline';
import { broadcastToPorts } from '~/features/translation/progress-broadcast';
import { RefCount } from '~/features/translation/keepalive-refcount';
import { summaryRetryPlan } from '~/lib/summary';
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
import type { VideoSummary } from '~/types/summary';

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

// Summary spec §3 — GENERATE_SUMMARY dedup: concurrent requests for the same
// video share one in-flight Promise instead of firing a second Gemini call
// (the panel's retry-after-timeout path joins the running job for free).
// The entry is removed when the promise settles, so a retry after a real
// failure starts a fresh run.
const inFlightSummaries = new Map<string, Promise<AppResponseMap['GENERATE_SUMMARY']>>();

async function runSummaryGeneration(videoId: string): Promise<AppResponseMap['GENERATE_SUMMARY']> {
  const key = await getApiKey();
  if (key === null) return { ok: false, error: 'API key not set' };

  const record = await getTranslation(videoId);
  if (!record || record.status !== 'done' || record.segments.length === 0) {
    // Defense-in-depth: the panel now gates the Summary tab on a done record
    // (fix round, Important #1 — `showSummaryTab` in App.tsx), so reaching
    // this branch means a caller bug or a race with cache clearing, not a
    // normal panel flow. Fail explicitly either way.
    return { ok: false, error: 'No completed translation for this video' };
  }

  // Read once, outside the retry loop — the setting cannot change mid-run,
  // and every retry attempt (and the persisted summary itself) must agree
  // on the same target language.
  const targetLang = await getTargetLang();

  // Same keepalive discipline as the translation pipeline (Task R4): hold
  // the SW open for the duration of the (possibly retried) Gemini call.
  acquireKeepalive();
  try {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await generateSummary(record.segments, key, targetLang);
      if (result.ok) {
        const summary: VideoSummary = {
          videoId,
          ...result.payload,
          model: MODEL_ID,
          targetLang,
          createdAt: new Date().toISOString(),
        };
        await putSummary(summary);
        return { ok: true, summary };
      }
      const plan = summaryRetryPlan(result.reason, attempt, result.retryDelayMs);
      // Fix round, Important #2: embed `result.reason` in the returned error
      // string (pipeline.ts's `summarizeFailures` convention — a reason
      // TOKEN somewhere in the string) so `translationErrorDisplay`'s
      // substring matching can actually map it to Korean; returning bare
      // `result.message` dropped the reason entirely and always fell
      // through to the raw-English default.
      if (!plan.retry) return { ok: false, error: `${result.reason}: ${result.message}` };
      if (plan.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
      }
    }
  } finally {
    releaseKeepalive();
  }
}

// Shared by the GENERATE_SUMMARY handler and the 다시 생성 cascade (spec
// 2026-07-31-regen-cascade §2) below — both need "join the in-flight job for
// this videoId if one exists, else start one", and must share the SAME
// `inFlightSummaries` entry so a cascade racing a panel-initiated
// GENERATE_SUMMARY (or vice versa) still only bills one Gemini call.
function startSummaryJob(videoId: string): Promise<AppResponseMap['GENERATE_SUMMARY']> {
  let job = inFlightSummaries.get(videoId);
  if (!job) {
    job = runSummaryGeneration(videoId).finally(() => {
      inFlightSummaries.delete(videoId);
    });
    inFlightSummaries.set(videoId, job);
  }
  return job;
}

// Task R4 — MV3 service-worker keepalive spanning a translation pipeline's
// ENTIRE run. Root cause (real-Chrome DoD): Chrome's ~30s SW idle-eviction
// timer is reset by chrome.* API activity and messaging, but NOT by an
// in-flight `fetch()` sitting there awaiting a response — a single large
// Gemini request (the glossary call in particular: one shot at the whole
// transcript, thinking can't be disabled for this model per R2's revert,
// and it can legitimately take several minutes) can leave the SW looking
// idle from Chrome's perspective long enough to be evicted mid-request,
// silently losing it with no error ever recorded (confirmed: a record stuck
// at `status:'analyzing'`, empty glossary, no `error` at all). Chunked
// translation (50 segs/request, ~15s, per-chunk `onProgress` broadcasts —
// see the `onConnect` comment below) usually stays under that window; one
// giant glossary call does not.
//
// This is deliberately NOT `chrome.alarms` (forbidden by the M2 plan) — a
// plain `setInterval` calling a cheap chrome.* API (`getPlatformInfo`, which
// needs no extra permission) every 20s, comfortably under the ~30s idle
// window, is the standard MV3 SW-keepalive pattern. `RefCount`
// (keepalive-refcount.ts) makes this safe for CONCURRENT pipelines (two
// videos translating at once, or a resumed job for one video racing a
// fresh START_TRANSLATION for another — both track independently in
// `inFlightTranslations` above): the interval starts on the first pipeline
// to launch (refcount 0->1) and is only cleared once the LAST active
// pipeline finishes (refcount 1->0), so one job completing early can never
// kill the keepalive out from under another still running.
const pipelineKeepalive = new RefCount();
let keepaliveIntervalId: ReturnType<typeof setInterval> | null = null;

function acquireKeepalive(): void {
  if (pipelineKeepalive.acquire()) {
    keepaliveIntervalId = setInterval(() => {
      // Return value/promise deliberately ignored — this call's only job is
      // to touch a chrome.* API so Chrome resets the SW's idle timer.
      void chrome.runtime.getPlatformInfo();
    }, 20_000);
  }
}

function releaseKeepalive(): void {
  if (pipelineKeepalive.release() && keepaliveIntervalId !== null) {
    clearInterval(keepaliveIntervalId);
    keepaliveIntervalId = null;
  }
}

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
  // Port also helps keep this service worker alive — Chrome resets a
  // service worker's idle timer on Port activity, and every chunk's
  // `onProgress` call (`broadcastProgress` above) posts a message on this
  // same channel while a job is running. That alone is NOT sufficient,
  // though (Task R4): it only covers the gaps BETWEEN progress events, and
  // a single long-running Gemini request (the glossary call especially) can
  // sit idle from the SW's perspective for longer than one progress event's
  // spacing, with no panel Port even required to be connected at all (a
  // pipeline can be launched — and must keep running — with no panel open).
  // See the `acquireKeepalive`/`releaseKeepalive` calls in the
  // `START_TRANSLATION` handler below for the explicit keepalive that now
  // spans the whole pipeline regardless of Port activity. Task 6's
  // per-chunk persistence + resume is still the suspenders underneath both:
  // an eviction that slips through anyway just means the next
  // START_TRANSLATION (auto-resume or a retry) picks up from the last
  // persisted chunk, not that the job's work is lost outright.
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
      const targetLang = await getTargetLang();

      // Dedup (see `inFlightTranslations` above): a job for this video is
      // already running — this call is either a genuine double-click, two
      // panels open on the same video, or the panel's own auto-resume
      // racing a job it is already attached to via the Port. Either way the
      // honest answer is "already running, ack accepted" — not a second
      // pipeline.
      if (!inFlightTranslations.has(payload.videoId)) {
        inFlightTranslations.add(payload.videoId);
        // Task R4: acquire the keepalive BEFORE the pipeline's first await,
        // so there is no window where a slow first step (e.g. the initial
        // `getTranslation` IndexedDB read) runs without it.
        acquireKeepalive();

        // Fire-and-forget: START_TRANSLATION acks "accepted", not
        // "finished". The promise is intentionally not awaited/returned to
        // the caller; its rejection is only logged (there is no one left to
        // answer by the time it could reject — the ack below has already
        // gone out). `.finally` removes this video from the in-flight set
        // AND releases the keepalive regardless of outcome, so a later
        // START_TRANSLATION (a real retry, or a future resume) is never
        // dedup'd against a job that has already settled, and the shared
        // interval is torn down once nothing needs it anymore.
        void runTranslationPipeline(
          { videoId: payload.videoId, tabId: payload.tabId, key, targetLang },
          {
            requestTranscript: async (tabId, videoId) =>
              (await chrome.tabs.sendMessage(tabId, {
                type: 'REQUEST_TRANSCRIPT',
                videoId,
              } satisfies RequestTranscriptMessage)) as RequestTranscriptResponse,
            // Deliberately forward the CALL's language argument, not this
            // closure's own `targetLang` const above: the pipeline decides
            // the EFFECTIVE language itself (resume rule — a non-terminal
            // existing record resumes in ITS stamped language, which can
            // differ from the setting read here), so background must never
            // bake this closure's value into the call. Named `lang` (not
            // `targetLang`) so it cannot shadow the outer const — dropping
            // this parameter would then be a compile error instead of a
            // silent rebind to the closure.
            analyzeGlossary: (fullText, key, lang) => analyzeGlossary(fullText, key, lang),
            translateBatch: (segs, glossary, key, lang) => translateBatch(segs, glossary, key, lang),
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
            // Final-review fix (C2): freed as soon as the PIPELINE itself
            // settles, NOT after the cascade below — the cascade's own
            // summary regeneration can run for the better part of a minute
            // (full-transcript Gemini call, retries), and a `다시 생성`
            // click during that window must start a REAL second pipeline,
            // not be silently deduped against a job that, from the
            // pipeline's own perspective, already finished. See
            // `src/background.test.ts`'s "does not dedup a second
            // START_TRANSLATION while the cascade is still running" test.
            inFlightTranslations.delete(payload.videoId);
          })
          .then(async () => {
            // 다시 생성 캐스케이드 (spec 2026-07-31-regen-cascade §2): a
            // re-translation that ends `done` refreshes this video's summary
            // too — but only if one already exists (summaries stay opt-in,
            // and a `failed` run must not burn a summary call on top). Runs
            // AFTER the `.catch` above, so it is never skipped by a pipeline
            // failure — `rec?.status !== 'done'` is what actually gates it.
            const [rec, cached] = await Promise.all([getTranslation(payload.videoId), getSummary(payload.videoId)]);
            if (rec?.status !== 'done' || !cached) return;
            const result = await startSummaryJob(payload.videoId);
            if (result.ok) {
              // Final-review fix (C1): the ONLY way an already-open Summary
              // tab learns the cascade just replaced its summary — see
              // `useSummary.ts`'s `chrome.runtime.onMessage` listener. No
              // receiver (panel closed, or open on a different video) is
              // the common case, not an error — same fire-and-forget
              // discipline as the `CURRENT_VIDEO_UPDATED` broadcast above.
              void sendMessage({
                type: 'SUMMARY_REFRESHED',
                payload: { videoId: payload.videoId },
              }).catch(() => {});
            } else {
              console.warn('[bg] summary cascade failed:', result.error);
            }
          })
          .catch((err) => {
            // The cascade `.then` above has no `.catch` upstream of it (that
            // belongs to the pipeline, not this step) — without this, a
            // throw here would surface as an unhandled rejection instead of
            // reaching `.finally` below cleanly.
            console.warn('[bg] summary cascade error:', err);
          })
          .finally(() => {
            releaseKeepalive();
          });
      }

      return { ok: true } as AppResponseMap[T];
    }
    case 'GET_TRANSLATION': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_TRANSLATION' }>;
      return (await getTranslation(payload.videoId)) as AppResponseMap[T];
    }
    case 'GET_VIDEO_META': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_VIDEO_META' }>;
      return (await getVideo(payload.videoId)) as AppResponseMap[T];
    }
    case 'GET_SUMMARY': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_SUMMARY' }>;
      return (await getSummary(payload.videoId)) as AppResponseMap[T];
    }
    case 'GENERATE_SUMMARY': {
      const { payload } = msg as Extract<AppMessage, { type: 'GENERATE_SUMMARY' }>;
      return (await startSummaryJob(payload.videoId)) as AppResponseMap[T];
    }
    case 'SUMMARY_REFRESHED':
      // Only ever produced by this file's own broadcast in the START_TRANSLATION
      // cascade below. Handled here solely so the switch — and
      // `errorResponseFor`'s below — stay exhaustive if this is ever
      // redelivered to the sender; there is no state to update on receipt.
      return { ok: true } as AppResponseMap[T];
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
    case 'GET_VIDEO_META':
      return null;
    case 'GET_SUMMARY':
      return null;
    case 'GENERATE_SUMMARY':
      return { ok: false, error: message };
    case 'SUMMARY_REFRESHED':
      return { ok: true };
  }
}
