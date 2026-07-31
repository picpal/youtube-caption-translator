import { describe, expect, it, vi } from 'vitest';
import {
  applyGlossaryConsistency,
  COMPLETENESS_THRESHOLD,
  DEFAULT_RETRY_DELAY_MS,
  MAX_COMPLETENESS_PASSES,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_SEGMENTS_PER_REQUEST,
  runTranslationPipeline,
  type TranslationPipelineDeps,
} from './pipeline';
import { captionHash, dedupeRows, reconstructSentences, rowsToSegments } from '~/lib/transcript-parse';
import type { RawTranscriptRow } from '~/types/message';
import type { GlossaryEntry, TranscriptSegment, TranslationProgress, TranslationRecord } from '~/types/transcript';

// Everything here drives the REAL `runTranslationPipeline` against injected
// mocks — no real Gemini, no real IndexedDB, no real chrome.*, no real
// timers (rate-limit waits go through the injected `sleep`, asserted on
// directly rather than timed). `dedupeRows`/`reconstructSentences`/
// `rowsToSegments`/`captionHash` ARE the real Task 4 functions: using them
// (instead of hand-built segment fixtures) is what makes the resume test's
// captionHash actually line up with what the pipeline computes internally.
//
// M2 refactor (single large request + stage progress): the old 8-segment/
// concurrency-3/fixed-backoff suite below is replaced with tests for
// MAX_SEGMENTS_PER_REQUEST-sized SEQUENTIAL chunks, retryDelay-honoring 429
// handling, the truncation guard, and stage-based (not segment-count)
// progress. The per-chunk persistence/resume behavior itself (deriving
// pending work from `translatedText === null`, out-of-order-safe failure
// collection) is unchanged and still covered below.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Each row's text ends in '.', so reconstructSentences (sentence-punctuation
// flush) turns every row into exactly one segment, 1:1 — the simplest
// possible fixture for chunk-count/index-math assertions.
function makeRows(n: number): RawTranscriptRow[] {
  return Array.from({ length: n }, (_, i) => {
    const totalSec = i * 5;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return { tsText: `${m}:${pad2(s)}`, text: `Segment ${i}.` };
  });
}

function seg(index: number, sourceText: string, translatedText: string | null): TranscriptSegment {
  return {
    segmentId: `v1:${index}`,
    videoId: 'v1',
    index,
    startSec: index * 5,
    endSec: index * 5 + 5,
    sourceText,
    translatedText,
  };
}

function makeDeps(overrides: Partial<TranslationPipelineDeps> = {}): TranslationPipelineDeps {
  return {
    requestTranscript: vi.fn(async () => [] as RawTranscriptRow[]),
    analyzeGlossary: vi.fn(async () => ({ ok: true as const, topic: 'test topic', glossary: [] as GlossaryEntry[] })),
    translateBatch: vi.fn(async (segs: TranscriptSegment[]) => ({
      ok: true as const,
      translations: segs.map((s) => ({ index: s.index, translatedText: `번역-${s.index}` })),
    })),
    getTranslation: vi.fn(async () => null),
    putTranslation: vi.fn(async () => {}),
    upsertBatch: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    onProgress: vi.fn(),
    ...overrides,
  };
}

describe('runTranslationPipeline', () => {
  describe('chunk splitting', () => {
    // Task R2: 300 (R1's "fewest possible requests" choice) took 1-2min per
    // request in real Chrome and let MV3 evict the service worker mid-fetch,
    // losing the job. 50 keeps each request to ~15s, safely inside the SW's
    // active-fetch lifetime — see pipeline.ts's doc comment on this constant.
    it('has MAX_SEGMENTS_PER_REQUEST = 50 (R2: SW-lifetime-safe chunk size)', () => {
      expect(MAX_SEGMENTS_PER_REQUEST).toBe(50);
    });

    it('splits N segments into ceil(N/MAX_SEGMENTS_PER_REQUEST) chunks of at most that size', async () => {
      const rows = makeRows(70); // -> chunks of [50, 20]
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(2);
      const sizes = translateBatch.mock.calls.map(([segs]) => segs.length);
      expect(sizes).toEqual([50, 20]);
      expect(result.status).toBe('done');
      expect(result.segments).toHaveLength(70);
      expect(result.segments.every((s) => s.translatedText !== null)).toBe(true);
      expect(result.totalBatches).toBe(2);
      expect(result.completedBatches).toBe(2);
    });

    // Brief's own measured example: a 1hr talk (~247 merged segments) is now
    // 5 sequential translation chunks (50,50,50,50,47), not 1 — the R1
    // "fewest requests" premise this test used to assert is exactly what R2
    // walked back for MV3 safety.
    it('splits a 1hr-talk-sized transcript (247 segments) into 5 sequential chunks', async () => {
      const rows = makeRows(247);
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(5);
      const sizes = translateBatch.mock.calls.map(([segs]) => segs.length);
      expect(sizes).toEqual([50, 50, 50, 50, 47]);
      expect(result.status).toBe('done');
      expect(result.totalBatches).toBe(5);
    });
  });

  describe('sequential execution (never concurrent)', () => {
    it('never starts the next chunk before the previous one resolves', async () => {
      const rows = makeRows(120); // 3 chunks: [50, 50, 20]
      const releasers: Array<() => void> = [];
      let active = 0;
      let maxActive = 0;
      const callOrder: number[][] = [];
      const translateBatch = vi.fn((segs: TranscriptSegment[]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        callOrder.push(segs.map((s) => s.index));
        return new Promise((resolve) => {
          releasers.push(() => {
            active -= 1;
            resolve({
              ok: true,
              translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
            });
          });
        });
      });
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch: translateBatch as any });

      const resultPromise = runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      // Flush the microtask queue (extract/resume-decision/glossary awaits)
      // so the first chunk's request has actually been sent.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(translateBatch).toHaveBeenCalledTimes(1);
      expect(maxActive).toBe(1);

      while (releasers.length > 0) {
        const before = translateBatch.mock.calls.length;
        releasers.shift()!();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Never more than one in flight, and the next call (if any) only
        // happens after the previous one's promise was released.
        expect(maxActive).toBe(1);
        if (translateBatch.mock.calls.length > before) {
          expect(active).toBeLessThanOrEqual(1);
        }
      }

      const result = await resultPromise;
      expect(result.status).toBe('done');
      expect(translateBatch).toHaveBeenCalledTimes(3);
      expect(callOrder).toEqual([
        Array.from({ length: 50 }, (_, i) => i),
        Array.from({ length: 50 }, (_, i) => i + 50),
        Array.from({ length: 20 }, (_, i) => i + 100),
      ]);
    });
  });

  describe('rate-limit (429) retry — honors the server retryDelay', () => {
    it('sleeps for the parsed "retry in Ns" delay, then succeeds', async () => {
      const rows = makeRows(5); // 1 chunk
      let calls = 0;
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        calls += 1;
        if (calls <= 2) {
          return { ok: false as const, reason: 'rate_limit' as const, message: 'Please retry in 2.5s.' };
        }
        return {
          ok: true as const,
          translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
        };
      });
      const sleepCalls: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        sleepCalls.push(ms);
      });
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(sleepCalls).toEqual([2500, 2500]);
      expect(translateBatch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe('done');
    });

    it('falls back to DEFAULT_RETRY_DELAY_MS when the message has no parseable delay', async () => {
      const rows = makeRows(5);
      let calls = 0;
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        calls += 1;
        if (calls === 1) return { ok: false as const, reason: 'rate_limit' as const, message: 'Quota exceeded.' };
        return {
          ok: true as const,
          translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
        };
      });
      const sleepCalls: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        sleepCalls.push(ms);
      });
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(sleepCalls).toEqual([DEFAULT_RETRY_DELAY_MS]);
      expect(result.status).toBe('done');
    });

    // Review fix — a rate_limit result whose message has NO parseable
    // number must still honor the structured `retryDelayMs` gemini.ts
    // surfaces from `error.details[].retryInfo.retryDelay`, rather than
    // falling all the way through to the fixed 5s default (which cannot
    // survive a real 40-60s free-tier quota window).
    it('honors the structured retryDelayMs fallback when the message has no parseable number', async () => {
      const rows = makeRows(5);
      let calls = 0;
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false as const,
            reason: 'rate_limit' as const,
            message: 'Resource has been exhausted (e.g. check quota).',
            retryDelayMs: 56_000,
          };
        }
        return {
          ok: true as const,
          translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
        };
      });
      const sleepCalls: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        sleepCalls.push(ms);
      });
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(sleepCalls).toEqual([56_000]);
      expect(result.status).toBe('done');
    });

    it('prefers the parsed message delay over the structured retryDelayMs when both are present', async () => {
      const rows = makeRows(5);
      let calls = 0;
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false as const,
            reason: 'rate_limit' as const,
            message: 'Please retry in 3s.',
            retryDelayMs: 56_000,
          };
        }
        return {
          ok: true as const,
          translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
        };
      });
      const sleepCalls: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        sleepCalls.push(ms);
      });
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(sleepCalls).toEqual([3_000]);
    });

    it('caps the delay at MAX_RETRY_DELAY_MS even when the server asks for longer', async () => {
      const rows = makeRows(5);
      let calls = 0;
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        calls += 1;
        if (calls === 1) return { ok: false as const, reason: 'rate_limit' as const, message: 'Please retry in 120s.' };
        return {
          ok: true as const,
          translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
        };
      });
      const sleepCalls: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        sleepCalls.push(ms);
      });
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(sleepCalls).toEqual([MAX_RETRY_DELAY_MS]);
    });

    it('gives up after MAX_RATE_LIMIT_RETRIES and records a failure, never persisting a partial batch as done', async () => {
      const rows = makeRows(5);
      const translateBatch = vi.fn(async () => ({
        ok: false as const,
        reason: 'rate_limit' as const,
        message: 'Please retry in 1s.',
      }));
      const sleep = vi.fn(async () => {});
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      // 1 initial attempt + MAX_RATE_LIMIT_RETRIES retries.
      expect(translateBatch).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
      expect(sleep).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES);
      expect(result.status).toBe('failed');
      expect(result.error?.step).toBe('translating');
      expect(result.error?.reason).toContain('rate_limit');
      expect(result.segments.every((s) => s.translatedText === null)).toBe(true);
    });
  });

  // Task R3 — real-Chrome DoD found a single 429 on `analyzeGlossary` used
  // to fail the WHOLE pipeline in ~3s with no wait at all, even though the
  // server's own message asked for a 53.2s retry (the chunk retry loop
  // already honored this; the glossary call did not). Fixed by routing the
  // glossary call through the SAME `callWithRateLimitRetry` helper the
  // chunk loop uses, and — since the glossary is a consistency aid, not a
  // hard requirement (`translateBatch` treats an empty glossary as a
  // no-op) — falling back to an empty glossary rather than failing the
  // pipeline when it still doesn't resolve after retries.
  describe('glossary resilience (Task R3)', () => {
    it('retries a rate-limited glossary call honoring the parsed retryDelay, then succeeds with the resolved glossary', async () => {
      const rows = makeRows(5);
      let calls = 0;
      const analyzeGlossary = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return { ok: false as const, reason: 'rate_limit' as const, message: 'Please retry in 53.2s.' };
        }
        return {
          ok: true as const,
          topic: 't',
          glossary: [{ term: 'React', translation: '리액트', keepOriginal: false }],
        };
      });
      const sleepCalls: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        sleepCalls.push(ms);
      });
      const translateBatch = vi.fn(async (segs: TranscriptSegment[], glossary: GlossaryEntry[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}-${glossary.length}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, analyzeGlossary, sleep, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(analyzeGlossary).toHaveBeenCalledTimes(2);
      expect(sleepCalls).toEqual([53_200]);
      expect(result.status).toBe('done');
      expect(result.glossary).toEqual([{ term: 'React', translation: '리액트', keepOriginal: false }]);
      // translateBatch received the resolved (non-empty) glossary.
      expect(translateBatch).toHaveBeenCalledWith(expect.any(Array), result.glossary, 'k', 'ko');
    });

    it('proceeds with an empty glossary (never fails the pipeline) when the glossary call exhausts its retries', async () => {
      const rows = makeRows(5);
      const analyzeGlossary = vi.fn(async () => ({
        ok: false as const,
        reason: 'rate_limit' as const,
        message: 'Please retry in 1s.',
      }));
      const sleep = vi.fn(async () => {});
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = makeDeps({ requestTranscript: async () => rows, analyzeGlossary, sleep, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      // 1 initial attempt + MAX_RATE_LIMIT_RETRIES retries, same budget as
      // a translate chunk.
      expect(analyzeGlossary).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
      expect(sleep).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES);
      // The glossary hiccup must NOT surface as a pipeline failure.
      expect(result.status).not.toBe('failed');
      expect(result.status).toBe('done');
      expect(result.glossary).toEqual([]);
      // Translation still ran, with an empty glossary passed through.
      expect(translateBatch).toHaveBeenCalledWith(expect.any(Array), [], 'k', 'ko');
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('still emits the analyzing-step progress event even when the glossary call retries', async () => {
      const rows = makeRows(5);
      let calls = 0;
      const analyzeGlossary = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return { ok: false as const, reason: 'rate_limit' as const, message: 'Please retry in 1s.' };
        }
        return { ok: true as const, topic: 't', glossary: [] };
      });
      const sleep = vi.fn(async () => {});
      const progress: TranslationProgress[] = [];
      const onProgress = vi.fn((p: TranslationProgress) => progress.push(p));
      const deps = makeDeps({ requestTranscript: async () => rows, analyzeGlossary, sleep, onProgress });

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      const analyzingEvents = progress.filter((p) => p.status === 'analyzing');
      expect(analyzingEvents).toHaveLength(1);
      expect(analyzingEvents[0]).toMatchObject({ step: 2, chunkIndex: 0, totalChunks: 1 });
    });
  });

  describe('truncation guard', () => {
    it('marks a chunk failed (not retried, not persisted as done) when translateBatch reports reason:truncated', async () => {
      const rows = makeRows(5);
      const translateBatch = vi.fn(async () => ({
        ok: false as const,
        reason: 'truncated' as const,
        message: 'Response truncated at the model output token limit (finishReason: MAX_TOKENS)',
      }));
      const sleep = vi.fn(async () => {});
      const upsertBatch = vi.fn(async () => {});
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep, upsertBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(1); // no retry for a truncation
      expect(sleep).not.toHaveBeenCalled();
      expect(upsertBatch).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.error?.reason).toContain('truncated');
      expect(result.segments.every((s) => s.translatedText === null)).toBe(true);
    });

    it('marks a chunk failed when translateBatch reports reason:bad_json', async () => {
      const rows = makeRows(5);
      const translateBatch = vi.fn(async () => ({
        ok: false as const,
        reason: 'bad_json' as const,
        message: 'Could not parse translation response',
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(result.error?.reason).toContain('bad_json');
    });
  });

  // Task R6 — real-Chrome DoD: gemini-3.5-flash-lite occasionally OMITS a
  // few indices from a large chunk's otherwise-successful (`ok:true`) JSON
  // response (a 247-segment video came back 244/247 on the first attempt),
  // which used to hard-fail the whole job. These tests cover the bounded
  // completeness passes that re-translate soft-omitted segments, and the
  // completeness-threshold tolerance that lets the job still finish `done`
  // when a small residual gap remains — while confirming a genuine HARD
  // chunk error still fails the job regardless of coverage.
  describe('completeness passes (Task R6)', () => {
    it('re-translates soft-omitted segments in a completeness pass, reaching done with full coverage', async () => {
      const rows = makeRows(10); // 1 chunk
      let calls = 0;
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        calls += 1;
        if (calls === 1) {
          // The model omits indices 2 and 5 from its response entirely.
          const omitted = new Set([2, 5]);
          return {
            ok: true as const,
            translations: segs
              .filter((s) => !omitted.has(s.index))
              .map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
          };
        }
        // Completeness pass: whatever it's asked for, it now translates.
        return {
          ok: true as const,
          translations: segs.map((s) => ({ index: s.index, translatedText: `fixed-${s.index}` })),
        };
      });
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(2); // main chunk + 1 completeness pass
      const completenessCallSegs = translateBatch.mock.calls[1][0] as TranscriptSegment[];
      expect(completenessCallSegs.map((s) => s.index)).toEqual([2, 5]);
      expect(result.status).toBe('done');
      expect(result.error).toBeUndefined();
      expect(result.segments.every((s) => s.translatedText !== null)).toBe(true);
      expect(result.segments[2].translatedText).toBe('fixed-2');
      expect(result.segments[5].translatedText).toBe('fixed-5');
    });

    it('reaches done at >=95% coverage even when the same omission persists through every completeness pass', async () => {
      const rows = makeRows(25); // 24/25 = 96% >= COMPLETENESS_THRESHOLD (95%)
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs
          .filter((s) => s.index !== 24)
          .map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      // 1 main chunk call + MAX_COMPLETENESS_PASSES extra attempts, all
      // omitting the same index — bounded, not retried forever.
      expect(translateBatch).toHaveBeenCalledTimes(1 + MAX_COMPLETENESS_PASSES);
      expect(result.status).toBe('done');
      expect(result.error).toBeUndefined();
      expect(result.segments[24].translatedText).toBeNull();
      const translatedCount = result.segments.filter((s) => s.translatedText !== null).length;
      expect(translatedCount / result.segments.length).toBeGreaterThanOrEqual(COMPLETENESS_THRESHOLD);
    });

    it('stays failed on a genuine hard chunk error, even though coverage would otherwise clear the completeness threshold', async () => {
      const rows = makeRows(52); // chunk 0: indices 0-49 (50 segs), chunk 1: indices 50-51 (2 segs)
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        if (segs[0].index === 50) {
          // chunk 1 always rate-limits, exhausting its retry budget.
          return { ok: false as const, reason: 'rate_limit' as const, message: 'Please retry in 1s.' };
        }
        return {
          ok: true as const,
          translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
        };
      });
      const sleep = vi.fn(async () => {});
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      // chunk 0 (1 call) + chunk 1 (1 initial + MAX_RATE_LIMIT_RETRIES retries).
      expect(translateBatch).toHaveBeenCalledTimes(1 + (MAX_RATE_LIMIT_RETRIES + 1));
      expect(result.status).toBe('failed');
      expect(result.error?.reason).toContain('rate_limit');
      // Coverage alone (50/52 ≈ 96%) would have cleared the threshold — the
      // hard chunk error must force `failed` regardless.
      const translatedCount = result.segments.filter((s) => s.translatedText !== null).length;
      expect(translatedCount / result.segments.length).toBeGreaterThanOrEqual(COMPLETENESS_THRESHOLD);
    });

    it('fails when completeness stays below the threshold with no hard chunk errors at all', async () => {
      const rows = makeRows(20);
      const alwaysOmitted = new Set([0, 1, 2]); // 17/20 = 85%, below the 95% threshold
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs
          .filter((s) => !alwaysOmitted.has(s.index))
          .map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(1 + MAX_COMPLETENESS_PASSES);
      expect(result.status).toBe('failed');
      expect(result.error?.reason).toContain('below the');
      expect(result.error?.reason).not.toContain('chunk'); // not the hard-failure message shape
      const translatedCount = result.segments.filter((s) => s.translatedText !== null).length;
      expect(translatedCount / result.segments.length).toBeLessThan(COMPLETENESS_THRESHOLD);
    });
  });

  describe('resume', () => {
    it('retranslates only chunks with a pending (null) segment, leaving already-done chunks untouched', async () => {
      const rows = makeRows(150); // 3 chunks of 50: [0-49], [50-99], [100-149]
      const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), 'v1');
      const fullText = parsedSegments.map((s) => s.sourceText).join('\n');
      const hash = captionHash(fullText);

      // Chunk 1 (indices 50-99) is already fully translated from a prior
      // run; chunks 0 and 2 are not. `completedBatches: 2` is deliberately
      // MISLEADING — a naive "resume from completedBatches" implementation
      // would read this as "chunks 0 and 1 are done, only chunk 2 is
      // pending" and wrongly skip chunk 0.
      const seededSegments = parsedSegments.map((s, i) => ({
        ...s,
        translatedText: i >= 50 && i < 100 ? `seeded-${i}` : null,
      }));

      const existing: TranslationRecord = {
        videoId: 'v1',
        captionHash: hash,
        sourceLang: 'en',
        status: 'translating',
        segments: seededSegments,
        glossary: [],
        completedBatches: 2,
        totalBatches: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `new-${s.index}` })),
      }));
      const analyzeGlossary = vi.fn(async () => ({ ok: true as const, topic: 't', glossary: [] }));

      const deps = makeDeps({
        requestTranscript: async () => rows,
        getTranslation: vi.fn(async () => existing),
        translateBatch,
        analyzeGlossary,
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      // Glossary was already resolved (status was 'translating') — must not
      // be re-analyzed on resume.
      expect(analyzeGlossary).not.toHaveBeenCalled();

      // Only chunk 0 and chunk 2 were pending.
      expect(translateBatch).toHaveBeenCalledTimes(2);
      const requestedIndexRanges = translateBatch.mock.calls.map(([segs]) => (segs as TranscriptSegment[])[0].index);
      expect(requestedIndexRanges).toEqual([0, 100]); // sequential, ascending order

      expect(deps.upsertBatch).toHaveBeenCalledWith('v1', 0, expect.any(Array));
      expect(deps.upsertBatch).toHaveBeenCalledWith('v1', 2, expect.any(Array));
      expect(deps.upsertBatch).not.toHaveBeenCalledWith('v1', 1, expect.anything());

      expect(result.status).toBe('done');
      expect(result.segments.every((s) => s.translatedText !== null)).toBe(true);
      for (let i = 0; i < 50; i += 1) expect(result.segments[i].translatedText).toBe(`new-${i}`);
      for (let i = 50; i < 100; i += 1) expect(result.segments[i].translatedText).toBe(`seeded-${i}`);
      for (let i = 100; i < 150; i += 1) expect(result.segments[i].translatedText).toBe(`new-${i}`);
      expect(result.completedBatches).toBe(3);
    });

    it('re-runs glossary analysis on resume when the prior run never got past it', async () => {
      const rows = makeRows(5);
      const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), 'v1');
      const hash = captionHash(parsedSegments.map((s) => s.sourceText).join('\n'));

      const existing: TranslationRecord = {
        videoId: 'v1',
        captionHash: hash,
        sourceLang: 'en',
        status: 'analyzing', // interrupted before glossary ever resolved
        segments: parsedSegments,
        glossary: [],
        completedBatches: 0,
        totalBatches: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const analyzeGlossary = vi.fn(async () => ({ ok: true as const, topic: 't', glossary: [] }));
      const deps = makeDeps({
        requestTranscript: async () => rows,
        getTranslation: vi.fn(async () => existing),
        analyzeGlossary,
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(analyzeGlossary).toHaveBeenCalledOnce();
      expect(result.status).toBe('done');
    });
  });

  // Language generalization (2026-07-31) — the two rules from the pipeline's
  // own "Step 2: cache/resume decision" comment: a NON-terminal existing
  // record always resumes in ITS OWN stamped language (record state
  // decides, ignoring a differing incoming param), while a TERMINAL record
  // (done/failed) with a differing stamped language is treated as absent —
  // full fresh start, no glossary/batch reuse, stamped with the incoming
  // param.
  describe('target language rules', () => {
    it('stamps a fresh run (no existing record) with the incoming targetLang param', async () => {
      const rows = makeRows(5);
      const analyzeGlossary = vi.fn(async () => ({ ok: true as const, topic: 't', glossary: [] }));
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, analyzeGlossary, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ja' }, deps);

      expect(result.status).toBe('done');
      expect(result.targetLang).toBe('ja');
      expect(analyzeGlossary).toHaveBeenCalledWith(expect.any(String), 'k', 'ja');
      expect(translateBatch).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), 'k', 'ja');
    });

    it('a NON-terminal existing record (mid-flight resume after eviction) ALWAYS resumes in its own stamped language, ignoring a differing incoming param', async () => {
      const rows = makeRows(5); // 1 chunk
      const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), 'v1');
      const hash = captionHash(parsedSegments.map((s) => s.sourceText).join('\n'));

      const interrupted: TranslationRecord = {
        videoId: 'v1',
        captionHash: hash,
        sourceLang: 'en',
        status: 'analyzing', // interrupted before glossary ever resolved (e.g. SW eviction)
        segments: parsedSegments,
        glossary: [],
        completedBatches: 0,
        totalBatches: 1,
        targetLang: 'ko',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const analyzeGlossary = vi.fn(async () => ({ ok: true as const, topic: 't', glossary: [] }));
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({
        requestTranscript: async () => rows,
        getTranslation: vi.fn(async () => interrupted),
        analyzeGlossary,
        translateBatch,
      });

      // The setting has since changed to 'ja', but the interrupted job must
      // finish in the record's own stamped 'ko' — record state decides.
      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ja' }, deps);

      expect(analyzeGlossary).toHaveBeenCalledWith(expect.any(String), 'k', 'ko');
      expect(translateBatch).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), 'k', 'ko');
      expect(result.status).toBe('done');
      expect(result.targetLang).toBe('ko');
    });

    it('a TERMINAL record (failed, glossary already resolved) with a differing stamped language is treated as absent — no glossary/batch reuse, fresh restart in the incoming targetLang', async () => {
      const rows = makeRows(5); // 1 chunk
      const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), 'v1');
      const hash = captionHash(parsedSegments.map((s) => s.sourceText).join('\n'));

      const failedWithResolvedGlossary: TranslationRecord = {
        videoId: 'v1',
        captionHash: hash,
        sourceLang: 'en',
        status: 'failed',
        // Glossary WAS resolved before the translate step failed — a
        // same-language resume would reuse it (glossaryResolved(record) is
        // true for this shape); the language mismatch must override that.
        error: { step: 'translating', reason: 'rate_limit: exhausted' },
        segments: parsedSegments,
        glossary: [{ term: 'OldTerm', translation: 'OldTranslation', keepOriginal: false }],
        completedBatches: 0,
        totalBatches: 1,
        targetLang: 'ko',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const analyzeGlossary = vi.fn(async () => ({
        ok: true as const,
        topic: 't',
        glossary: [{ term: 'NewTerm', translation: 'NewTranslation', keepOriginal: false }],
      }));
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `new-${s.index}` })),
      }));
      const deps = makeDeps({
        requestTranscript: async () => rows,
        getTranslation: vi.fn(async () => failedWithResolvedGlossary),
        analyzeGlossary,
        translateBatch,
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ja' }, deps);

      // A same-language resume would have skipped this call entirely
      // (glossaryResolved(record) === true) — the mismatch forces it anyway.
      expect(analyzeGlossary).toHaveBeenCalledOnce();
      expect(analyzeGlossary).toHaveBeenCalledWith(expect.any(String), 'k', 'ja');
      expect(translateBatch).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), 'k', 'ja');
      expect(result.status).toBe('done');
      expect(result.targetLang).toBe('ja');
      expect(result.glossary).toEqual([{ term: 'NewTerm', translation: 'NewTranslation', keepOriginal: false }]);
    });
  });

  describe('cache hit', () => {
    it('returns the existing record as-is with no Gemini calls when captionHash matches and status is done', async () => {
      const rows = makeRows(5);
      const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), 'v1');
      const hash = captionHash(parsedSegments.map((s) => s.sourceText).join('\n'));
      const done: TranslationRecord = {
        videoId: 'v1',
        captionHash: hash,
        sourceLang: 'en',
        status: 'done',
        segments: parsedSegments.map((s) => ({ ...s, translatedText: `cached-${s.index}` })),
        glossary: [],
        completedBatches: 1,
        totalBatches: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const analyzeGlossary = vi.fn();
      const translateBatch = vi.fn();
      const deps = makeDeps({
        requestTranscript: async () => rows,
        getTranslation: vi.fn(async () => done),
        analyzeGlossary: analyzeGlossary as any,
        translateBatch: translateBatch as any,
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result).toBe(done);
      expect(analyzeGlossary).not.toHaveBeenCalled();
      expect(translateBatch).not.toHaveBeenCalled();
      expect(deps.putTranslation).not.toHaveBeenCalled();
    });
  });

  describe('unavailable transcript', () => {
    it('persists a clean failed record and does not throw', async () => {
      const deps = makeDeps({ requestTranscript: async () => ({ unavailable: true }) });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.status).toBe('failed');
      expect(result.error?.step).toBe('extracting');
      expect(deps.putTranslation).toHaveBeenCalledOnce();
    });

    // Fix round (2026-07-29 task-brief.md) — reason-splitting: back-compat
    // (no `reason` field at all) and an explicit `'no-panel'` both still
    // produce the ORIGINAL message, unchanged.
    it('reports the original "no transcript panel" reason when `reason` is absent (back-compat)', async () => {
      const deps = makeDeps({ requestTranscript: async () => ({ unavailable: true }) });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.error?.reason).toBe('No transcript panel available for this video');
    });

    it('reports the original "no transcript panel" reason for an explicit reason:"no-panel"', async () => {
      const deps = makeDeps({
        requestTranscript: async () => ({ unavailable: true, reason: 'no-panel' as const }),
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.error?.reason).toBe('No transcript panel available for this video');
    });

    it('reports a distinct "panel failed to open" reason for reason:"open-failed" (the field bug this fix addresses)', async () => {
      const deps = makeDeps({
        requestTranscript: async () => ({ unavailable: true, reason: 'open-failed' as const }),
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.status).toBe('failed');
      expect(result.error?.reason).toBe('Transcript panel failed to open');
    });
  });

  // Review round 1, Minor #3: getTranslation/putTranslation/upsertBatch can
  // all reject (a real IndexedDB error) — unlike analyzeGlossary/
  // translateBatch, which route every failure through callGeminiJson and
  // never throw. Each site must resolve the pipeline promise to a `failed`
  // TranslationRecord rather than letting the rejection propagate out of
  // runTranslationPipeline.
  describe('persistence failures (never reject the pipeline promise)', () => {
    it('resolves to a failed record when getTranslation rejects', async () => {
      const rows = makeRows(5);
      const getTranslation = vi.fn(async () => {
        throw new Error('IDB read failed');
      });
      const deps = makeDeps({ requestTranscript: async () => rows, getTranslation });

      await expect(
        runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps),
      ).resolves.toMatchObject({ status: 'failed' });
    });

    it('resolves to a failed record when the initial putTranslation (skeleton) rejects, without ever calling translateBatch', async () => {
      const rows = makeRows(5);
      const putTranslation = vi.fn(async () => {
        throw new Error('IDB write failed');
      });
      const translateBatch = vi.fn();
      const deps = makeDeps({
        requestTranscript: async () => rows,
        putTranslation,
        translateBatch: translateBatch as any,
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.status).toBe('failed');
      // The load-bearing skeleton write never landed, so the pipeline must
      // not have gone on to call translateBatch (which would have raced
      // ahead of a record that upsertBatch — Task 3 — requires to exist).
      expect(translateBatch).not.toHaveBeenCalled();
    });

    it('resolves to a failed record (does not reject) when upsertBatch rejects', async () => {
      const rows = makeRows(5);
      const upsertBatch = vi.fn(async () => {
        throw new Error('IDB write failed');
      });
      const deps = makeDeps({ requestTranscript: async () => rows, upsertBatch });

      await expect(
        runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps),
      ).resolves.toMatchObject({ status: 'failed' });
    });
  });

  describe('parseTimestamp throw guard', () => {
    it('fails cleanly (no throw) when a row has a malformed timestamp', async () => {
      const rows: RawTranscriptRow[] = [{ tsText: 'not-a-timestamp', text: 'Hello world.' }];
      const deps = makeDeps({ requestTranscript: async () => rows });

      await expect(
        runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps),
      ).resolves.toMatchObject({
        status: 'failed',
        error: { step: 'extracting' },
      });
    });
  });

  // Final branch review, Critical: a transient extract/parse failure on a
  // RE-RUN (Task 10's "다시 생성" button, or an auto-resume) used to
  // `putTranslation` a fresh base-less `failed` record (empty segments),
  // clobbering whatever GOOD record was already persisted for this video —
  // a `done` video's fully-translated segments, or an in-progress video's
  // already-upserted batches. `getTranslation` is now read once at the very
  // top of the pipeline and threaded through as `base` to every early
  // `failPipeline` call, so these transient failures preserve the prior
  // record instead of destroying it.
  describe('preserves a prior good record on a transient extract/parse failure (final review fix)', () => {
    function makeDoneRecord(): TranslationRecord {
      return {
        videoId: 'v1',
        captionHash: 'prior-hash',
        sourceLang: 'en',
        status: 'done',
        segments: [seg(0, 'Hello world.', '안녕하세요.'), seg(1, 'Second line.', '두 번째 줄.')],
        glossary: [{ term: 'World', translation: '세계', keepOriginal: false }],
        completedBatches: 1,
        totalBatches: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
    }

    it('does not clobber a done record when a re-run transcript request comes back unavailable', async () => {
      const existingDone = makeDoneRecord();
      const putTranslation = vi.fn(async (_rec: TranslationRecord) => {});
      const deps = makeDeps({
        requestTranscript: async () => ({ unavailable: true }),
        getTranslation: vi.fn(async () => existingDone),
        putTranslation,
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.status).toBe('failed');
      // Prior good segments/glossary/captionHash carried through, not wiped.
      expect(result.segments).toEqual(existingDone.segments);
      expect(result.glossary).toEqual(existingDone.glossary);
      expect(result.captionHash).toBe(existingDone.captionHash);
      // No write ever persisted an empty record over the good one.
      for (const call of putTranslation.mock.calls) {
        const persisted = call[0] as TranslationRecord;
        expect(persisted.segments.length).toBeGreaterThan(0);
      }
    });

    it('does not clobber a done record when a re-run hits the parseTimestamp guard', async () => {
      const existingDone = makeDoneRecord();
      const badRows: RawTranscriptRow[] = [{ tsText: 'not-a-timestamp', text: 'Hello world.' }];
      const putTranslation = vi.fn(async (_rec: TranslationRecord) => {});
      const deps = makeDeps({
        requestTranscript: async () => badRows,
        getTranslation: vi.fn(async () => existingDone),
        putTranslation,
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.status).toBe('failed');
      expect(result.segments).toEqual(existingDone.segments);
      expect(result.glossary).toEqual(existingDone.glossary);
      expect(result.captionHash).toBe(existingDone.captionHash);
      for (const call of putTranslation.mock.calls) {
        const persisted = call[0] as TranslationRecord;
        expect(persisted.segments.length).toBeGreaterThan(0);
      }
    });

    it('still persists a base-less (empty-segments) failed record for a fresh video with nothing to preserve', async () => {
      const deps = makeDeps({
        requestTranscript: async () => ({ unavailable: true }),
        getTranslation: vi.fn(async () => null),
      });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(result.status).toBe('failed');
      expect(result.segments).toEqual([]);
    });
  });

  describe('onProgress stage sequence', () => {
    it('emits extract -> analyze -> translate(sending/receiving/parsing) -> chunk-done -> done for a single-chunk job', async () => {
      const rows = makeRows(5); // 1 chunk, deterministic ordering
      const progress: TranslationProgress[] = [];
      const onProgress = vi.fn((p: TranslationProgress) => progress.push(p));
      const deps = makeDeps({ requestTranscript: async () => rows, onProgress });

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      expect(progress.map((p) => p.step)).toEqual([1, 2, 3, 3, 3, 3, 3, 4]);
      expect(progress.map((p) => p.phase)).toEqual([
        undefined,
        undefined,
        undefined,
        'sending',
        'receiving',
        'parsing',
        undefined,
        undefined,
      ]);
      expect(progress[0]).toMatchObject({ status: 'extracting', chunkIndex: 0, totalChunks: 0 });
      expect(progress[1]).toMatchObject({ status: 'analyzing', chunkIndex: 0, totalChunks: 1 });
      expect(progress[2]).toMatchObject({ status: 'translating', chunkIndex: 0, totalChunks: 1 });
      expect(progress[3]).toMatchObject({ status: 'translating', chunkIndex: 0, totalChunks: 1 });
      expect(progress[4]).toMatchObject({ status: 'translating', chunkIndex: 0, totalChunks: 1 });
      expect(progress[5]).toMatchObject({ status: 'translating', chunkIndex: 0, totalChunks: 1 });
      expect(progress[6]).toMatchObject({ status: 'translating', chunkIndex: 1, totalChunks: 1 });
      expect(progress[7]).toMatchObject({ status: 'done', chunkIndex: 1, totalChunks: 1 });
    });

    it('reports a monotonically non-decreasing chunkIndex across a multi-chunk job', async () => {
      const rows = makeRows(70); // 2 chunks: [50, 20]
      const progress: TranslationProgress[] = [];
      const onProgress = vi.fn((p: TranslationProgress) => progress.push(p));
      const deps = makeDeps({ requestTranscript: async () => rows, onProgress });

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k', targetLang: 'ko' }, deps);

      const chunkIndices = progress.map((p) => p.chunkIndex);
      for (let i = 1; i < chunkIndices.length; i += 1) {
        expect(chunkIndices[i]).toBeGreaterThanOrEqual(chunkIndices[i - 1]);
      }
      expect(chunkIndices[0]).toBe(0);
      expect(chunkIndices.at(-1)).toBe(2);
    });
  });
});

describe('applyGlossaryConsistency', () => {
  it('replaces a leftover untranslated English term with the glossary translation', () => {
    const glossary: GlossaryEntry[] = [{ term: 'React', translation: '리액트', keepOriginal: false }];
    const segments: TranscriptSegment[] = [
      seg(0, 'I love React hooks.', '저는 React 훅을 좋아합니다'),
      seg(1, 'React hooks are great.', '리액트 훅은 훌륭합니다'),
    ];

    const result = applyGlossaryConsistency(segments, glossary);

    expect(result[0].translatedText).toBe('저는 리액트 훅을 좋아합니다');
    expect(result[1].translatedText).toBe('리액트 훅은 훌륭합니다'); // already correct, untouched
  });

  // Review round 1, Important #1: TRANSLATION_RULES (gemini.ts) explicitly
  // allows the model to echo the English term in parentheses alongside the
  // Korean translation ("add the English term in parentheses when it helps
  // clarity"). The old code's guard only checked "does translatedText still
  // contain the bare English term", which that echo satisfies even though
  // the segment is ALREADY correctly translated — corrupting
  // "리액트(React)를 사용합니다" into "리액트(리액트)를 사용합니다".
  it('does not corrupt an already-correct translation that echoes the English term in parentheses', () => {
    const glossary: GlossaryEntry[] = [{ term: 'React', translation: '리액트', keepOriginal: false }];
    const segments: TranscriptSegment[] = [
      seg(0, 'We use React for the frontend.', '프론트엔드에는 리액트(React)를 사용합니다'),
    ];

    const result = applyGlossaryConsistency(segments, glossary);

    expect(result[0].translatedText).toBe('프론트엔드에는 리액트(React)를 사용합니다');
    expect(result[0].translatedText).not.toContain('리액트(리액트)');
  });

  // Review round 1, Minor #2: no word-boundary anchoring meant a short term
  // like "Go" matched as a bare substring inside "Google". A standalone
  // occurrence of the actual term must still be fixed normally.
  it('does not corrupt a short term matching inside a longer word, but still fixes a standalone occurrence', () => {
    const glossary: GlossaryEntry[] = [{ term: 'Go', translation: '고랭', keepOriginal: false }];

    const untouched = applyGlossaryConsistency(
      [seg(0, 'Search on Google now.', '지금 Google에서 검색하세요.')],
      glossary,
    );
    expect(untouched[0].translatedText).toBe('지금 Google에서 검색하세요.');

    const fixed = applyGlossaryConsistency(
      [seg(1, 'Go is a great language.', '저는 Go 언어를 좋아합니다.')],
      glossary,
    );
    expect(fixed[0].translatedText).toBe('저는 고랭 언어를 좋아합니다.');
  });

  it('leaves keepOriginal:true terms alone', () => {
    const glossary: GlossaryEntry[] = [{ term: 'Docker', translation: '도커', keepOriginal: true }];
    const segments: TranscriptSegment[] = [seg(0, 'Use Docker here.', 'Docker를 여기서 사용하세요')];

    const result = applyGlossaryConsistency(segments, glossary);

    expect(result[0].translatedText).toBe('Docker를 여기서 사용하세요');
  });

  it('leaves untranslated (null) segments untouched', () => {
    const glossary: GlossaryEntry[] = [{ term: 'React', translation: '리액트', keepOriginal: false }];
    const segments: TranscriptSegment[] = [seg(0, 'React is nice.', null)];

    const result = applyGlossaryConsistency(segments, glossary);

    expect(result[0].translatedText).toBeNull();
  });

  it('is a no-op when the glossary is empty', () => {
    const segments: TranscriptSegment[] = [seg(0, 'React is nice.', '리액트는 좋아요')];
    const result = applyGlossaryConsistency(segments, []);
    expect(result).toBe(segments);
  });
});
