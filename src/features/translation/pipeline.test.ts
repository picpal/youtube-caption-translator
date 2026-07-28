import { describe, expect, it, vi } from 'vitest';
import {
  applyGlossaryConsistency,
  DEFAULT_RETRY_DELAY_MS,
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
    it('has MAX_SEGMENTS_PER_REQUEST = 300 (brief: fits a 1hr talk in one request)', () => {
      expect(MAX_SEGMENTS_PER_REQUEST).toBe(300);
    });

    it('splits N segments into ceil(N/MAX_SEGMENTS_PER_REQUEST) chunks of at most that size', async () => {
      const rows = makeRows(350); // -> chunks of [300, 50]
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(2);
      const sizes = translateBatch.mock.calls.map(([segs]) => segs.length);
      expect(sizes).toEqual([300, 50]);
      expect(result.status).toBe('done');
      expect(result.segments).toHaveLength(350);
      expect(result.segments.every((s) => s.translatedText !== null)).toBe(true);
      expect(result.totalBatches).toBe(2);
      expect(result.completedBatches).toBe(2);
    });

    it('fits a 1hr-talk-sized transcript (247 segments) in exactly one request', async () => {
      const rows = makeRows(247);
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('done');
      expect(result.totalBatches).toBe(1);
    });
  });

  describe('sequential execution (never concurrent)', () => {
    it('never starts the next chunk before the previous one resolves', async () => {
      const rows = makeRows(700); // 3 chunks: [300, 300, 100]
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

      const resultPromise = runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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
        Array.from({ length: 300 }, (_, i) => i),
        Array.from({ length: 300 }, (_, i) => i + 300),
        Array.from({ length: 100 }, (_, i) => i + 600),
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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(sleepCalls).toEqual([DEFAULT_RETRY_DELAY_MS]);
      expect(result.status).toBe('done');
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

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      // 1 initial attempt + MAX_RATE_LIMIT_RETRIES retries.
      expect(translateBatch).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
      expect(sleep).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES);
      expect(result.status).toBe('failed');
      expect(result.error?.step).toBe('translating');
      expect(result.error?.reason).toContain('rate_limit');
      expect(result.segments.every((s) => s.translatedText === null)).toBe(true);
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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(result.error?.reason).toContain('bad_json');
    });
  });

  describe('resume', () => {
    it('retranslates only chunks with a pending (null) segment, leaving already-done chunks untouched', async () => {
      const rows = makeRows(900); // 3 chunks of 300: [0-299], [300-599], [600-899]
      const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), 'v1');
      const fullText = parsedSegments.map((s) => s.sourceText).join('\n');
      const hash = captionHash(fullText);

      // Chunk 1 (indices 300-599) is already fully translated from a prior
      // run; chunks 0 and 2 are not. `completedBatches: 2` is deliberately
      // MISLEADING — a naive "resume from completedBatches" implementation
      // would read this as "chunks 0 and 1 are done, only chunk 2 is
      // pending" and wrongly skip chunk 0.
      const seededSegments = parsedSegments.map((s, i) => ({
        ...s,
        translatedText: i >= 300 && i < 600 ? `seeded-${i}` : null,
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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      // Glossary was already resolved (status was 'translating') — must not
      // be re-analyzed on resume.
      expect(analyzeGlossary).not.toHaveBeenCalled();

      // Only chunk 0 and chunk 2 were pending.
      expect(translateBatch).toHaveBeenCalledTimes(2);
      const requestedIndexRanges = translateBatch.mock.calls.map(([segs]) => (segs as TranscriptSegment[])[0].index);
      expect(requestedIndexRanges).toEqual([0, 600]); // sequential, ascending order

      expect(deps.upsertBatch).toHaveBeenCalledWith('v1', 0, expect.any(Array));
      expect(deps.upsertBatch).toHaveBeenCalledWith('v1', 2, expect.any(Array));
      expect(deps.upsertBatch).not.toHaveBeenCalledWith('v1', 1, expect.anything());

      expect(result.status).toBe('done');
      expect(result.segments.every((s) => s.translatedText !== null)).toBe(true);
      for (let i = 0; i < 300; i += 1) expect(result.segments[i].translatedText).toBe(`new-${i}`);
      for (let i = 300; i < 600; i += 1) expect(result.segments[i].translatedText).toBe(`seeded-${i}`);
      for (let i = 600; i < 900; i += 1) expect(result.segments[i].translatedText).toBe(`new-${i}`);
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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(analyzeGlossary).toHaveBeenCalledOnce();
      expect(result.status).toBe('done');
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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(result).toBe(done);
      expect(analyzeGlossary).not.toHaveBeenCalled();
      expect(translateBatch).not.toHaveBeenCalled();
      expect(deps.putTranslation).not.toHaveBeenCalled();
    });
  });

  describe('unavailable transcript', () => {
    it('persists a clean failed record and does not throw', async () => {
      const deps = makeDeps({ requestTranscript: async () => ({ unavailable: true }) });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(result.status).toBe('failed');
      expect(result.error?.step).toBe('extracting');
      expect(deps.putTranslation).toHaveBeenCalledOnce();
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
        runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps),
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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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
        runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps),
      ).resolves.toMatchObject({ status: 'failed' });
    });
  });

  describe('parseTimestamp throw guard', () => {
    it('fails cleanly (no throw) when a row has a malformed timestamp', async () => {
      const rows: RawTranscriptRow[] = [{ tsText: 'not-a-timestamp', text: 'Hello world.' }];
      const deps = makeDeps({ requestTranscript: async () => rows });

      await expect(
        runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps),
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
        glossary: [{ term: 'World', translation: '세계', keepEnglish: false }],
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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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
      const rows = makeRows(350); // 2 chunks: [300, 50]
      const progress: TranslationProgress[] = [];
      const onProgress = vi.fn((p: TranslationProgress) => progress.push(p));
      const deps = makeDeps({ requestTranscript: async () => rows, onProgress });

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

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
    const glossary: GlossaryEntry[] = [{ term: 'React', translation: '리액트', keepEnglish: false }];
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
    const glossary: GlossaryEntry[] = [{ term: 'React', translation: '리액트', keepEnglish: false }];
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
    const glossary: GlossaryEntry[] = [{ term: 'Go', translation: '고랭', keepEnglish: false }];

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

  it('leaves keepEnglish:true terms alone', () => {
    const glossary: GlossaryEntry[] = [{ term: 'Docker', translation: '도커', keepEnglish: true }];
    const segments: TranscriptSegment[] = [seg(0, 'Use Docker here.', 'Docker를 여기서 사용하세요')];

    const result = applyGlossaryConsistency(segments, glossary);

    expect(result[0].translatedText).toBe('Docker를 여기서 사용하세요');
  });

  it('leaves untranslated (null) segments untouched', () => {
    const glossary: GlossaryEntry[] = [{ term: 'React', translation: '리액트', keepEnglish: false }];
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
