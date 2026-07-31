import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, getVideo, getTranslation, getSummary, putTranslation, putSummary } from '~/lib/db';
import { analyzeGlossary, generateSummary, translateBatch, MODEL_ID } from '~/lib/gemini';
import type { GenerateSummaryResult } from '~/lib/gemini';
import { captionHash, dedupeRows, reconstructSentences, rowsToSegments } from '~/lib/transcript-parse';
import type { AppMessage, RawTranscriptRow } from '~/types/message';
import type { TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import { handle } from '../entrypoints/background';

// GENERATE_SUMMARY suite (fix round, Important #3) — `generateSummary` is
// the one collaborator worth mocking here: it's the actual network/Gemini
// call, everything else (getTranslation/putSummary, the in-flight dedup map,
// summaryRetryPlan) is this repo's own code and already exercised for real
// against fake-indexeddb, same as every other describe block in this file.
// `analyzeGlossary`/`translateBatch` (fix rounds 1-2, Important #1 + the
// round-1 re-review's test-hygiene finding) are mocked for the same
// reason — the START_TRANSLATION language-boundary test below needs to
// assert on the argument `analyzeGlossary` actually received, and letting
// `translateBatch` stay real let the pipeline fire a genuine outbound fetch
// (with a 120s abort timer) past that point and return before it settled,
// leaking a live pipeline run into later tests. Partial mock (not a full
// auto-mock) so MODEL_ID and every OTHER gemini.ts export stay real —
// nothing else in this file (or a future addition to it) should silently
// start getting auto-mocked undefined stubs.
vi.mock('~/lib/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/gemini')>();
  return { ...actual, generateSummary: vi.fn(), analyzeGlossary: vi.fn(), translateBatch: vi.fn() };
});

// Closes the M0 review's "no test for the message dispatch layer" gap: this
// drives the REAL `handle()` exported from entrypoints/background.ts — the
// same function `chrome.runtime.onMessage.addListener` calls in production —
// against a real IndexedDB (via fake-indexeddb, same pattern as
// src/lib/db.test.ts) and a stubbed `chrome.*`, asserting the actual response
// shapes rather than mocking handle()'s own collaborators away.
//
// Lives under src/, not beside entrypoints/background.ts, on purpose: WXT
// globs entrypointsDir for `*.[jt]s?(x)` to discover "unlisted-script"
// entrypoints, derives an entrypoint NAME by taking the filename up to its
// first dot, and rejects duplicate names. `entrypoints/background.test.ts`
// collided with `entrypoints/background.ts` under that rule — both name to
// "background" — and broke `pnpm wxt build` with "Multiple entrypoints with
// the same name detected" (measured; see task-8-report.md). vitest.config.ts
// only points `~` at `src/`, and WXT's `entrypointsDir` only globs
// `entrypoints/`, so `src/` is invisible to WXT and safe for this file.

let nextTabId = 1;
// A fresh tabId per test avoids any dependency on `latestByTab`'s module-level
// state being reset between tests (it has no reset hook, by design — see
// background.ts's comment on why losing it is harmless in production).
function freshTabId(): number {
  return nextTabId++;
}

function senderFor(tabId: number | undefined): chrome.runtime.MessageSender {
  return tabId === undefined ? {} : { tab: { id: tabId } as chrome.tabs.Tab };
}

// Final-review fix (I1, spec 2026-07-31-regen-cascade) — the cascade "skip"
// tests below observe a TERMINAL translation status via `vi.waitFor`, but
// the cascade's own decision (`Promise.all([getTranslation, getSummary])`
// then an `if` check, all inside the `.then` background.ts schedules once
// the pipeline settles) is a SEPARATE, independently-timed async chain:
// observing `done`/`failed` proves the PIPELINE finished, not that the
// cascade has already decided. Without this, a test asserting
// `generateSummary` was never called could pass "green" even if the
// cascade's `!cached`/`rec?.status !== 'done'` guard were deleted, purely
// because the observation raced ahead of the cascade's own reads — exactly
// the final review's finding. Yielding several real event-loop turns gives
// those pending fake-indexeddb reads (and the `.then` continuation reading
// them) a chance to actually run first.
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

let sendMessageMock: ReturnType<typeof vi.fn>;
let tabsSendMessageMock: ReturnType<typeof vi.fn>;

// Minimal in-memory fake of the one `chrome.storage.local` surface
// `getApiKey`/`saveApiKey` (src/lib/storage.ts) need — only exercised by the
// START_TRANSLATION dedup suite below, which needs a "present" API key to
// get past `handle()`'s own key gate before it can assert on dedup.
let storageData: Record<string, unknown>;

beforeEach(async () => {
  await deleteDb();
  storageData = {};
  sendMessageMock = vi.fn().mockResolvedValue({ ok: true });
  tabsSendMessageMock = vi.fn().mockResolvedValue(undefined);
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: sendMessageMock,
    },
    tabs: {
      sendMessage: tabsSendMessageMock,
    },
    storage: {
      local: {
        get: vi.fn((keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of keyList) {
            if (key in storageData) result[key] = storageData[key];
          }
          return Promise.resolve(result);
        }),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(storageData, items);
          return Promise.resolve();
        }),
        remove: vi.fn((keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) delete storageData[key];
          return Promise.resolve();
        }),
      },
    },
  };
});

const SETTLED_META = {
  videoId: 'zjkBMFhNj_g',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  title: '[1hr Talk] Intro to Large Language Models',
  channelName: 'Andrej Karpathy',
  thumbnailUrl: 'https://i.ytimg.com/vi/zjkBMFhNj_g/hqdefault.jpg',
  durationSeconds: 3588,
  captionAvailability: 'auto-only' as const,
};

// Fix round, Important #3 — GENERATE_SUMMARY fixtures. A minimal but valid
// `done` TranslationRecord: the one shape `runSummaryGeneration`'s guard
// requires before it calls `generateSummary` at all.
function doneTranslationRecord(videoId: string, overrides: Partial<TranslationRecord> = {}): TranslationRecord {
  const now = new Date().toISOString();
  return {
    videoId,
    captionHash: 'hash',
    sourceLang: 'en',
    status: 'done',
    segments: [
      {
        segmentId: `${videoId}:0`,
        videoId,
        index: 0,
        startSec: 0,
        endSec: 5,
        sourceText: 'Hello world',
        translatedText: '안녕하세요',
      },
    ],
    glossary: [],
    completedBatches: 1,
    totalBatches: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const SUMMARY_PAYLOAD = {
  purpose: '이 영상은 대규모 언어 모델의 기초를 설명합니다.',
  mainArguments: ['LLM은 다음 토큰을 예측하도록 학습된다.'],
  sections: [{ startSec: 0, title: '도입' }],
  keywords: ['LLM', 'transformer'],
  conclusion: '전반적인 개념을 정리하며 마칩니다.',
};

describe('VIDEO_DETECTED', () => {
  it('caches to IndexedDB when settled with non-null meta, stamping fetchedAt', async () => {
    const tabId = freshTabId();
    const before = Date.now();

    const res = await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    expect(res).toEqual({ ok: true });

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).not.toBeNull();
    expect(cached?.title).toBe(SETTLED_META.title);
    expect(new Date(cached!.fetchedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does NOT cache a provisional report, even with non-null meta', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'provisional', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });

  it('does NOT cache an unsettled report', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'unsettled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });

  it('does NOT cache a settled report whose meta is null (not a video page)', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: null } },
      senderFor(tabId),
    );

    // Nothing to look up by id, so assert indirectly: GET_CURRENT_VIDEO still
    // reflects the in-memory report (proving the message WAS processed), but
    // no video with this id exists in the store.
    const res = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId } }, senderFor(undefined));
    expect(res).toEqual({ status: 'settled', meta: null });
    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });

  it('broadcasts CURRENT_VIDEO_UPDATED with the tabId and the real payload', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'CURRENT_VIDEO_UPDATED',
      payload: { tabId, video: { status: 'settled', meta: SETTLED_META } },
    });
  });

  it('acknowledges without throwing and without caching when the sender has no tab', async () => {
    const res = await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(undefined),
    );
    expect(res).toEqual({ ok: true });

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });
});

describe('GET_CURRENT_VIDEO', () => {
  it('returns null for a tab with no prior report', async () => {
    const tabId = freshTabId();
    const res = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId } }, senderFor(undefined));
    expect(res).toBeNull();
  });

  it('returns the most recent report for that tab, overwriting an earlier one', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'provisional', meta: SETTLED_META } },
      senderFor(tabId),
    );
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const res = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId } }, senderFor(undefined));
    expect(res).toEqual({ status: 'settled', meta: SETTLED_META });
  });

  it('keeps two tabs independent', async () => {
    const tabA = freshTabId();
    const tabB = freshTabId();
    const metaB = { ...SETTLED_META, videoId: 'other-video', title: 'A different video' };

    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabA),
    );
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: metaB } },
      senderFor(tabB),
    );

    const resA = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId: tabA } }, senderFor(undefined));
    const resB = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId: tabB } }, senderFor(undefined));

    expect(resA).toEqual({ status: 'settled', meta: SETTLED_META });
    expect(resB).toEqual({ status: 'settled', meta: metaB });
  });
});

describe('REQUEST_VIDEO_REEMIT', () => {
  it('asks the tab\'s content script to re-emit via chrome.tabs.sendMessage', async () => {
    const tabId = freshTabId();

    const res = await handle(
      { type: 'REQUEST_VIDEO_REEMIT', payload: { tabId } },
      senderFor(undefined),
    );

    expect(res).toEqual({ ok: true });
    expect(tabsSendMessageMock).toHaveBeenCalledWith(tabId, { type: 'REEMIT_VIDEO' });
  });

  it('does not throw out of handle() when the tab has no content script to receive it', async () => {
    const tabId = freshTabId();
    tabsSendMessageMock.mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await expect(
      handle({ type: 'REQUEST_VIDEO_REEMIT', payload: { tabId } }, senderFor(undefined)),
    ).resolves.toEqual({ ok: true });
  });
});

describe('CURRENT_VIDEO_UPDATED (self-delivery)', () => {
  it('is handled gracefully rather than falling through to the unhandled-type throw', async () => {
    const res = await handle(
      {
        type: 'CURRENT_VIDEO_UPDATED',
        payload: { tabId: freshTabId(), video: { status: 'settled', meta: null } },
      } as AppMessage as Extract<AppMessage, { type: 'CURRENT_VIDEO_UPDATED' }>,
      senderFor(undefined),
    );
    expect(res).toEqual({ ok: true });
  });
});

// Task 7 — the in-flight job registry that makes the panel's auto-resume-
// on-open safe: START_TRANSLATION must be a no-op against an already-
// running job for the same videoId, not a second pipeline. `runTranslationPipeline`
// itself calls `chrome.tabs.sendMessage` (via `requestTranscript`) as the
// very first thing it does after its synchronous initial `onProgress` call —
// before any `await` inside `handle()`'s own START_TRANSLATION case runs
// again — so `tabsSendMessageMock`'s call count is a reliable proxy for "did
// a second pipeline actually start", with no polling/timing needed for the
// dedup assertion itself (only the cleanup below needs `vi.waitFor`, to let
// the stuck first pipeline settle before the next test).
describe('START_TRANSLATION dedup', () => {
  it('does not start a second pipeline for two concurrent calls with the same videoId', async () => {
    const tabId = freshTabId();
    await chrome.storage.local.set({ geminiApiKey: 'test-key', geminiApiKeySavedAt: new Date().toISOString() });

    let releaseTranscript!: (value: unknown) => void;
    const stuckTranscript = new Promise((resolve) => {
      releaseTranscript = resolve;
    });
    tabsSendMessageMock.mockReturnValueOnce(stuckTranscript);

    // Fired concurrently (both in flight before either resolves), rather
    // than awaited one after another — self-evidently the race the dedup
    // registry exists for, not just an inference from `handle()`'s
    // synchronous check-then-add being race-free by construction.
    const [res1, res2] = await Promise.all([
      handle({ type: 'START_TRANSLATION', payload: { videoId: 'dedup-video', tabId } }, senderFor(undefined)),
      handle({ type: 'START_TRANSLATION', payload: { videoId: 'dedup-video', tabId } }, senderFor(undefined)),
    ]);
    expect(res1).toEqual({ ok: true });
    expect(res2).toEqual({ ok: true });

    // The dedup check itself (`inFlightTranslations.has`/`.add` in
    // background.ts) is synchronous and already resolved by the time
    // `Promise.all` above settles — both `handle()` calls only ack
    // "accepted", they don't await the pipeline. What's still pending is the
    // WINNING pipeline's own internal work before it reaches
    // `requestTranscript` (Task 6's final-review fix reads the cached
    // record via a real — fake-indexeddb-backed — `getTranslation` call
    // FIRST, which is a genuine async IndexedDB round trip, not a
    // synchronously-resolving mock), so this waits for that to land rather
    // than asserting immediately.
    await vi.waitFor(() => {
      expect(tabsSendMessageMock).toHaveBeenCalledTimes(1);
    });
    // ...and it never grows past 1: the second call's dedup no-op means no
    // second pipeline is ever going to reach the content script at all.
    expect(tabsSendMessageMock).toHaveBeenCalledTimes(1);

    // Let the stuck pipeline finish (requestTranscript resolves to a shape
    // that fails `Array.isArray` -> pipeline records a clean "no transcript
    // panel" failure) so its videoId is removed from the in-flight set and
    // this test doesn't leak state into the next one.
    releaseTranscript({ unavailable: true });
    await vi.waitFor(async () => {
      const record = await getTranslation('dedup-video');
      expect(record?.status).toBe('failed');
    });
  });

  it('allows starting a new job once the previous one for that videoId has settled', async () => {
    const tabId = freshTabId();
    await chrome.storage.local.set({ geminiApiKey: 'test-key', geminiApiKeySavedAt: new Date().toISOString() });
    tabsSendMessageMock.mockResolvedValue({ unavailable: true });

    await handle(
      { type: 'START_TRANSLATION', payload: { videoId: 'settle-video', tabId } },
      senderFor(undefined),
    );
    await vi.waitFor(async () => {
      const record = await getTranslation('settle-video');
      expect(record?.status).toBe('failed');
    });

    await handle(
      { type: 'START_TRANSLATION', payload: { videoId: 'settle-video', tabId } },
      senderFor(undefined),
    );
    await vi.waitFor(() => {
      expect(tabsSendMessageMock).toHaveBeenCalledTimes(2);
    });
  });

  it('does not start any pipeline when no API key is set', async () => {
    const tabId = freshTabId();
    const res = await handle(
      { type: 'START_TRANSLATION', payload: { videoId: 'no-key-video', tabId } },
      senderFor(undefined),
    );
    expect(res).toEqual({ ok: false, error: 'API key not set' });
    expect(tabsSendMessageMock).not.toHaveBeenCalled();
  });
});

// Fix round 1, Important #1 — pins the deps boundary at the START_TRANSLATION
// injection site: the pipeline decides the EFFECTIVE language itself (the
// resume rule), and background's `analyzeGlossary`/`translateBatch` wrapper
// lambdas must forward whatever the PIPELINE calls them with, never the
// closure's own `targetLang` const read from the current setting. This is
// the only test that would catch a regression where those wrappers get
// "simplified" back into closing over the setting instead of forwarding the
// call argument.
describe('START_TRANSLATION language boundary', () => {
  beforeEach(() => {
    vi.mocked(analyzeGlossary).mockReset();
    vi.mocked(translateBatch).mockReset();
  });

  it('forwards the resuming record\'s own stamped language to analyzeGlossary, not the current (different) setting', async () => {
    const tabId = freshTabId();
    await chrome.storage.local.set({
      geminiApiKey: 'test-key',
      geminiApiKeySavedAt: new Date().toISOString(),
      // The CURRENT setting is 'ja' — this must NOT be what analyzeGlossary
      // receives below, since the existing record is non-terminal and the
      // resume rule says record state decides.
      translationTargetLang: 'ja',
    });

    const videoId = 'lang-boundary-video';
    const rows: RawTranscriptRow[] = [{ tsText: '0:00', text: 'Hello world.' }];
    const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), videoId);
    const hash = captionHash(parsedSegments.map((s) => s.sourceText).join('\n'));

    // Non-terminal — interrupted before glossary ever resolved (e.g. SW
    // eviction), stamped 'ko' from an earlier run.
    await putTranslation({
      videoId,
      captionHash: hash,
      sourceLang: 'en',
      status: 'analyzing',
      segments: parsedSegments,
      glossary: [],
      completedBatches: 0,
      totalBatches: 1,
      targetLang: 'ko',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    tabsSendMessageMock.mockResolvedValueOnce(rows);
    vi.mocked(analyzeGlossary).mockResolvedValue({ ok: true, topic: 't', glossary: [] });
    // Real Gemini network calls are never acceptable from this unit suite —
    // mocked with a normal successful batch result so the pipeline can run
    // to completion entirely in-process (round-1 re-review finding: leaving
    // this real let the pipeline fire a genuine outbound fetch, with a 120s
    // abort timer, past the point this test used to return at).
    vi.mocked(translateBatch).mockResolvedValue({
      ok: true,
      translations: parsedSegments.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
    });

    await handle({ type: 'START_TRANSLATION', payload: { videoId, tabId } }, senderFor(undefined));

    await vi.waitFor(() => {
      expect(analyzeGlossary).toHaveBeenCalled();
    });
    // The record's own stamped 'ko' — never the 'ja' setting read from the
    // outer closure.
    expect(analyzeGlossary).toHaveBeenCalledWith(expect.any(String), 'test-key', 'ko');

    // Let the pipeline actually settle before the test returns — same
    // discipline as the START_TRANSLATION dedup suite above ("this test
    // doesn't leak state into the next one"). Without this, the run
    // continues past the test (translateBatch -> putTranslation ->
    // keepalive teardown) and can race the next test's `beforeEach`.
    await vi.waitFor(async () => {
      expect((await getTranslation(videoId))?.status).toBe('done');
    });
  });

  // Final-review fix, Important #1 — the complement of the test above: that
  // one seeds a non-terminal record stamped 'ko' and asserts 'ko', so its
  // expected value happens to coincide with what a hardcoded-'ko' regression
  // at background.ts:366 would ALSO produce — it cannot tell "correctly
  // resumed in the record's language" apart from "background silently
  // hardcodes 'ko' regardless of the setting". A FRESH job (no existing
  // record at all) has no record language to resume into, so it is the only
  // shape that pins background.ts actually reading and forwarding the
  // CURRENT `translationTargetLang` setting for the headline "first
  // translation of a video" path.
  it('uses the current target-language setting for a FRESH job with no existing record', async () => {
    const tabId = freshTabId();
    await chrome.storage.local.set({
      geminiApiKey: 'test-key',
      geminiApiKeySavedAt: new Date().toISOString(),
      translationTargetLang: 'ja',
    });

    const videoId = 'fresh-lang-video';
    const rows: RawTranscriptRow[] = [{ tsText: '0:00', text: 'Hello world.' }];

    tabsSendMessageMock.mockResolvedValueOnce(rows);
    vi.mocked(analyzeGlossary).mockResolvedValue({ ok: true, topic: 't', glossary: [] });
    vi.mocked(translateBatch).mockResolvedValue({
      ok: true,
      translations: [{ index: 0, translatedText: 't0' }],
    });

    await handle({ type: 'START_TRANSLATION', payload: { videoId, tabId } }, senderFor(undefined));

    await vi.waitFor(() => {
      expect(analyzeGlossary).toHaveBeenCalled();
    });
    // The current setting — nothing exists yet to resume into, so this is
    // the only source the language could have come from.
    expect(analyzeGlossary).toHaveBeenCalledWith(expect.any(String), 'test-key', 'ja');

    await vi.waitFor(async () => {
      expect((await getTranslation(videoId))?.status).toBe('done');
    });
  });
});

// Fix round, Important #3 — drives the real `handle()` for GENERATE_SUMMARY,
// same discipline as the START_TRANSLATION dedup suite above: real
// fake-indexeddb, stubbed chrome.*, only `generateSummary` itself mocked.
describe('GENERATE_SUMMARY', () => {
  beforeEach(() => {
    vi.mocked(generateSummary).mockReset();
  });

  async function withApiKey(): Promise<void> {
    await chrome.storage.local.set({ geminiApiKey: 'test-key', geminiApiKeySavedAt: new Date().toISOString() });
  }

  it('rejects with the guard error and calls gemini zero times when no record exists', async () => {
    await withApiKey();

    const res = await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'missing-video' } }, senderFor(undefined));

    expect(res).toEqual({ ok: false, error: 'No completed translation for this video' });
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it('rejects with the guard error and calls gemini zero times when the record is not done', async () => {
    await withApiKey();
    await putTranslation(doneTranslationRecord('failed-video', { status: 'failed' }));

    const res = await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'failed-video' } }, senderFor(undefined));

    expect(res).toEqual({ ok: false, error: 'No completed translation for this video' });
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it('happy path: one generateSummary call, persists the summary, and stamps videoId/model/createdAt', async () => {
    await withApiKey();
    await putTranslation(doneTranslationRecord('happy-video'));
    vi.mocked(generateSummary).mockResolvedValueOnce({ ok: true, payload: SUMMARY_PAYLOAD });
    const before = Date.now();

    const res = await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'happy-video' } }, senderFor(undefined));

    expect(generateSummary).toHaveBeenCalledTimes(1);
    if (!res.ok) throw new Error(`expected ok:true, got ${JSON.stringify(res)}`);
    expect(res.summary.videoId).toBe('happy-video');
    expect(res.summary.model).toBe(MODEL_ID);
    expect(new Date(res.summary.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(res.summary.purpose).toBe(SUMMARY_PAYLOAD.purpose);

    const persisted = await getSummary('happy-video');
    expect(persisted).toEqual(res.summary);
  });

  // Language generalization (2026-07-31) — `runSummaryGeneration` reads the
  // configured target-lang setting and both passes it to `generateSummary`
  // and stamps it onto the persisted `VideoSummary`.
  it('stamps the persisted summary with the configured target language', async () => {
    await withApiKey();
    await chrome.storage.local.set({ translationTargetLang: 'ja' });
    await putTranslation(doneTranslationRecord('lang-video'));
    vi.mocked(generateSummary).mockResolvedValueOnce({ ok: true, payload: SUMMARY_PAYLOAD });

    const res = await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'lang-video' } }, senderFor(undefined));

    expect(generateSummary).toHaveBeenCalledWith(expect.any(Array), 'test-key', 'ja');
    if (!res.ok) throw new Error(`expected ok:true, got ${JSON.stringify(res)}`);
    expect(res.summary.targetLang).toBe('ja');

    // putSummary itself is real (fake-indexeddb) here — reading it back is
    // the observable proof that the write it received carried targetLang.
    const persisted = await getSummary('lang-video');
    expect(persisted?.targetLang).toBe('ja');
  });

  it('single-flight: two concurrent calls share one gemini call and get the same result; a third call afterward starts a fresh one', async () => {
    await withApiKey();
    await putTranslation(doneTranslationRecord('sf-video'));

    let resolveGemini!: (value: GenerateSummaryResult) => void;
    const stuck = new Promise<GenerateSummaryResult>((resolve) => {
      resolveGemini = resolve;
    });
    vi.mocked(generateSummary).mockReturnValueOnce(stuck);

    const call1 = handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'sf-video' } }, senderFor(undefined));
    const call2 = handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'sf-video' } }, senderFor(undefined));

    // Same reasoning as the START_TRANSLATION dedup test above: the dedup
    // check itself is synchronous, but `getTranslation` is a genuine
    // fake-indexeddb round trip `runSummaryGeneration` awaits BEFORE ever
    // reaching `generateSummary`, so this waits for that to land rather than
    // asserting immediately.
    await vi.waitFor(() => {
      expect(generateSummary).toHaveBeenCalledTimes(1);
    });

    resolveGemini({ ok: true, payload: SUMMARY_PAYLOAD });
    const [res1, res2] = await Promise.all([call1, call2]);
    expect(res1).toEqual(res2);
    expect(generateSummary).toHaveBeenCalledTimes(1);

    vi.mocked(generateSummary).mockResolvedValueOnce({ ok: true, payload: SUMMARY_PAYLOAD });
    await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'sf-video' } }, senderFor(undefined));
    expect(generateSummary).toHaveBeenCalledTimes(2);
  });

  it('retries once on a bad_json reason then succeeds', async () => {
    await withApiKey();
    await putTranslation(doneTranslationRecord('retry-video'));
    vi.mocked(generateSummary)
      .mockResolvedValueOnce({ ok: false, reason: 'bad_json', message: 'Could not parse summary response' })
      .mockResolvedValueOnce({ ok: true, payload: SUMMARY_PAYLOAD });

    const res = await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'retry-video' } }, senderFor(undefined));

    expect(generateSummary).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
  });

  it('does not retry a terminal reason (unauthorized) and embeds the reason token in the error string (locks in Important #2)', async () => {
    await withApiKey();
    await putTranslation(doneTranslationRecord('terminal-video'));
    vi.mocked(generateSummary).mockResolvedValueOnce({
      ok: false,
      reason: 'unauthorized',
      message: 'API key not valid',
    });

    const res = await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'terminal-video' } }, senderFor(undefined));

    expect(generateSummary).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, error: 'unauthorized: API key not valid' });
  });

  it('rejects with a missing-key error and calls gemini zero times when no API key is saved', async () => {
    await putTranslation(doneTranslationRecord('no-key-video'));

    const res = await handle({ type: 'GENERATE_SUMMARY', payload: { videoId: 'no-key-video' } }, senderFor(undefined));

    expect(res).toEqual({ ok: false, error: 'API key not set' });
    expect(generateSummary).not.toHaveBeenCalled();
  });
});

// 다시 생성 캐스케이드 (spec 2026-07-31-regen-cascade §2) — the transcript-side
// 다시 생성 button (a normal START_TRANSLATION call) now refreshes this
// video's summary too, but ONLY when the run settles `done` AND a summary
// already existed. Driven from inside START_TRANSLATION's own promise
// chain (background.ts, the `.then` inserted before the final
// `.finally(release keepalive)`) — there is no separate message type for
// this, so these tests drive the real pipeline to `done`/`failed` the same
// way the language-boundary suite above does (mocked `analyzeGlossary` /
// `translateBatch`, real fake-indexeddb) rather than mocking the cascade
// itself away.
function existingSummary(videoId: string, overrides: Partial<VideoSummary> = {}): VideoSummary {
  return {
    videoId,
    ...SUMMARY_PAYLOAD,
    model: MODEL_ID,
    targetLang: 'ko',
    createdAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('START_TRANSLATION summary cascade', () => {
  beforeEach(() => {
    vi.mocked(generateSummary).mockReset();
    vi.mocked(analyzeGlossary).mockReset();
    vi.mocked(translateBatch).mockReset();
  });

  it('refreshes an existing summary once a re-translation settles done, using the current target-lang setting', async () => {
    const tabId = freshTabId();
    const videoId = 'cascade-video';
    await chrome.storage.local.set({
      geminiApiKey: 'test-key',
      geminiApiKeySavedAt: new Date().toISOString(),
      // Deliberately different from the seeded summary's 'ko' below — the
      // cascade's `runSummaryGeneration` reads the CURRENT setting fresh,
      // not whatever language the prior summary happened to be in.
      translationTargetLang: 'ja',
    });
    await putSummary(existingSummary(videoId));

    const rows: RawTranscriptRow[] = [{ tsText: '0:00', text: 'Hello world.' }];
    tabsSendMessageMock.mockResolvedValueOnce(rows);
    vi.mocked(analyzeGlossary).mockResolvedValue({ ok: true, topic: 't', glossary: [] });
    vi.mocked(translateBatch).mockResolvedValue({
      ok: true,
      translations: [{ index: 0, translatedText: 't0' }],
    });
    vi.mocked(generateSummary).mockResolvedValueOnce({ ok: true, payload: SUMMARY_PAYLOAD });

    await handle({ type: 'START_TRANSLATION', payload: { videoId, tabId } }, senderFor(undefined));

    await vi.waitFor(() => {
      expect(generateSummary).toHaveBeenCalledTimes(1);
    });

    const refreshed = await getSummary(videoId);
    expect(refreshed?.targetLang).toBe('ja');
    expect(refreshed?.createdAt).not.toBe('2020-01-01T00:00:00.000Z');

    // Final-review fix (C1) — background must broadcast so an already-open
    // Summary tab's `useSummary` listener can converge on the new summary;
    // without this the panel had no way to ever see the cascade's result.
    await vi.waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'SUMMARY_REFRESHED',
        payload: { videoId },
      });
    });
  });

  it('does not call generateSummary when the video has no prior summary', async () => {
    const tabId = freshTabId();
    const videoId = 'cascade-no-summary-video';
    await chrome.storage.local.set({ geminiApiKey: 'test-key', geminiApiKeySavedAt: new Date().toISOString() });

    const rows: RawTranscriptRow[] = [{ tsText: '0:00', text: 'Hello world.' }];
    tabsSendMessageMock.mockResolvedValueOnce(rows);
    vi.mocked(analyzeGlossary).mockResolvedValue({ ok: true, topic: 't', glossary: [] });
    vi.mocked(translateBatch).mockResolvedValue({
      ok: true,
      translations: [{ index: 0, translatedText: 't0' }],
    });

    await handle({ type: 'START_TRANSLATION', payload: { videoId, tabId } }, senderFor(undefined));

    await vi.waitFor(async () => {
      expect((await getTranslation(videoId))?.status).toBe('done');
    });
    await flushMicrotasks();
    expect(generateSummary).not.toHaveBeenCalled();
    expect(await getSummary(videoId)).toBeNull();
  });

  it('does not call generateSummary and leaves an existing summary untouched when the pipeline ends failed', async () => {
    const tabId = freshTabId();
    const videoId = 'cascade-failed-video';
    await chrome.storage.local.set({ geminiApiKey: 'test-key', geminiApiKeySavedAt: new Date().toISOString() });
    const seeded = existingSummary(videoId);
    await putSummary(seeded);

    // No transcript panel available — same failure fixture as the
    // START_TRANSLATION dedup suite above.
    tabsSendMessageMock.mockResolvedValueOnce({ unavailable: true });

    await handle({ type: 'START_TRANSLATION', payload: { videoId, tabId } }, senderFor(undefined));

    await vi.waitFor(async () => {
      expect((await getTranslation(videoId))?.status).toBe('failed');
    });
    await flushMicrotasks();
    expect(generateSummary).not.toHaveBeenCalled();
    expect(await getSummary(videoId)).toEqual(seeded);
  });

  // Final-review regression test (C2) — before this fix, `inFlightTranslations
  // .delete(payload.videoId)` was deferred into the FINAL `.finally`, i.e.
  // AFTER the cascade's own (possibly long-running) summary regeneration.
  // That meant a `다시 생성` click while a cascade was still in flight for the
  // same videoId got silently deduped against a pipeline that, from the
  // pipeline's own perspective, had already finished — no error, no second
  // pipeline, just a swallowed click. Proves the fix: while the cascade's
  // `generateSummary` call is deliberately held open (not yet resolved), a
  // second START_TRANSLATION for the SAME videoId still reaches
  // `requestTranscript` a second time — i.e. is NOT deduped.
  it('does not dedup a second START_TRANSLATION while the first run\'s cascade is still generating a summary', async () => {
    const tabId = freshTabId();
    const videoId = 'cascade-inflight-video';
    await chrome.storage.local.set({ geminiApiKey: 'test-key', geminiApiKeySavedAt: new Date().toISOString() });
    await putSummary(existingSummary(videoId));

    const rows: RawTranscriptRow[] = [{ tsText: '0:00', text: 'Hello world.' }];
    tabsSendMessageMock.mockResolvedValueOnce(rows);
    vi.mocked(analyzeGlossary).mockResolvedValue({ ok: true, topic: 't', glossary: [] });
    vi.mocked(translateBatch).mockResolvedValue({
      ok: true,
      translations: [{ index: 0, translatedText: 't0' }],
    });

    // Held open deliberately — this is the cascade's "still generating"
    // window the regression is about. Resolved at the end so the job
    // settles cleanly and doesn't leak into the next test.
    let resolveGemini!: (value: GenerateSummaryResult) => void;
    const stuck = new Promise<GenerateSummaryResult>((resolve) => {
      resolveGemini = resolve;
    });
    vi.mocked(generateSummary).mockReturnValueOnce(stuck);

    await handle({ type: 'START_TRANSLATION', payload: { videoId, tabId } }, senderFor(undefined));

    await vi.waitFor(async () => {
      expect((await getTranslation(videoId))?.status).toBe('done');
    });
    // The cascade has reached (and is now blocked inside) generateSummary —
    // i.e. it is provably still "in progress" at this instant.
    await vi.waitFor(() => {
      expect(generateSummary).toHaveBeenCalledTimes(1);
    });
    expect(tabsSendMessageMock).toHaveBeenCalledTimes(1);

    // Same videoId, second click, while the above is still unresolved.
    tabsSendMessageMock.mockResolvedValueOnce(rows);
    await handle({ type: 'START_TRANSLATION', payload: { videoId, tabId } }, senderFor(undefined));

    await vi.waitFor(() => {
      expect(tabsSendMessageMock).toHaveBeenCalledTimes(2);
    });

    // Let both runs settle (the second pipeline's own cascade joins the
    // still-in-flight `inFlightSummaries` job for this videoId via
    // single-flight, so this does NOT bill a second Gemini call) so nothing
    // leaks into the next test.
    resolveGemini({ ok: true, payload: SUMMARY_PAYLOAD });
    await vi.waitFor(async () => {
      const refreshed = await getSummary(videoId);
      expect(refreshed?.createdAt).not.toBe('2020-01-01T00:00:00.000Z');
    });
    expect(generateSummary).toHaveBeenCalledTimes(1);
  });
});

describe('GET_VIDEO_META', () => {
  it('returns the cached VideoMeta for a videoId', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const res = await handle(
      { type: 'GET_VIDEO_META', payload: { videoId: SETTLED_META.videoId } },
      senderFor(undefined),
    );

    expect(res).not.toBeNull();
    expect((res as { title: string }).title).toBe(SETTLED_META.title);
    expect((res as { videoId: string }).videoId).toBe(SETTLED_META.videoId);
  });

  it('returns null for a videoId that was never cached', async () => {
    const res = await handle(
      { type: 'GET_VIDEO_META', payload: { videoId: 'nEvErSeEn11' } },
      senderFor(undefined),
    );

    expect(res).toBeNull();
  });
});
