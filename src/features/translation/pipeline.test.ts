import { describe, expect, it, vi } from 'vitest';
import {
  applyGlossaryConsistency,
  BACKOFF_MS,
  BATCH_SIZE,
  MAX_CONCURRENCY,
  runTranslationPipeline,
  type TranslationPipelineDeps,
} from './pipeline';
import { captionHash, dedupeRows, reconstructSentences, rowsToSegments } from '~/lib/transcript-parse';
import type { RawTranscriptRow } from '~/types/message';
import type { GlossaryEntry, TranscriptSegment, TranslationRecord } from '~/types/transcript';

// Everything here drives the REAL `runTranslationPipeline` against injected
// mocks — no real Gemini, no real IndexedDB, no real chrome.*, no real
// timers (backoff waits go through the injected `sleep`, asserted on
// directly rather than timed). `dedupeRows`/`reconstructSentences`/
// `rowsToSegments`/`captionHash` ARE the real Task 4 functions: using them
// (instead of hand-built segment fixtures) is what makes the resume test's
// captionHash actually line up with what the pipeline computes internally.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Each row's text ends in '.', so reconstructSentences (sentence-punctuation
// flush) turns every row into exactly one segment, 1:1 — the simplest
// possible fixture for batch-count/index-math assertions.
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
  describe('batch splitting', () => {
    it('splits N segments into ceil(N/BATCH_SIZE) batches of BATCH_SIZE', async () => {
      const rows = makeRows(20); // BATCH_SIZE=8 -> 8, 8, 4
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => ({
        ok: true as const,
        translations: segs.map((s) => ({ index: s.index, translatedText: `t${s.index}` })),
      }));
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(translateBatch).toHaveBeenCalledTimes(3);
      const sizes = translateBatch.mock.calls.map(([segs]) => segs.length).sort((a, b) => b - a);
      expect(sizes).toEqual([8, 8, 4]);
      expect(result.status).toBe('done');
      expect(result.segments).toHaveLength(20);
      expect(result.segments.every((s) => s.translatedText !== null)).toBe(true);
    });
  });

  describe('concurrency cap', () => {
    it('never has more than MAX_CONCURRENCY translateBatch calls in flight at once', async () => {
      const rows = makeRows(40); // 5 batches, > MAX_CONCURRENCY
      const releasers: Array<() => void> = [];
      let active = 0;
      let maxActive = 0;
      const translateBatch = vi.fn((segs: TranscriptSegment[]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
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

      // Flush the microtask queue (extract/resume-decision/glossary awaits,
      // all resolved promises) so the concurrency pool reaches steady state
      // — poolSize calls made, all awaiting our still-unresolved promises.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(translateBatch).toHaveBeenCalledTimes(MAX_CONCURRENCY);
      expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENCY);

      while (releasers.length > 0) {
        releasers.shift()!();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const result = await resultPromise;
      expect(result.status).toBe('done');
      expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENCY);
      expect(translateBatch).toHaveBeenCalledTimes(5);
    });
  });

  describe('429 backoff', () => {
    it('retries a rate-limited batch with the documented exponential schedule, then succeeds', async () => {
      const rows = makeRows(5); // 1 batch
      let calls = 0;
      const translateBatch = vi.fn(async (segs: TranscriptSegment[]) => {
        calls += 1;
        if (calls <= 2) return { ok: false as const, reason: 'rate_limit' as const, message: 'quota' };
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

      expect(sleepCalls).toEqual([BACKOFF_MS[0], BACKOFF_MS[1]]);
      expect(translateBatch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe('done');
    });

    it('gives up after exhausting the retry budget and records a failure', async () => {
      const rows = makeRows(5);
      const translateBatch = vi.fn(async () => ({
        ok: false as const,
        reason: 'rate_limit' as const,
        message: 'quota',
      }));
      const sleep = vi.fn(async () => {});
      const deps = makeDeps({ requestTranscript: async () => rows, translateBatch, sleep });

      const result = await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      // 1 initial attempt + BACKOFF_MS.length retries.
      expect(translateBatch).toHaveBeenCalledTimes(BACKOFF_MS.length + 1);
      expect(sleep).toHaveBeenCalledTimes(BACKOFF_MS.length);
      expect(result.status).toBe('failed');
      expect(result.error?.step).toBe('translating');
      expect(result.error?.reason).toContain('rate_limit');
      expect(result.segments.every((s) => s.translatedText === null)).toBe(true);
    });
  });

  describe('resume under concurrency', () => {
    it('retranslates only batches with a pending (null) segment, leaving already-done batches untouched', async () => {
      const rows = makeRows(24); // 3 batches of 8: [0-7], [8-15], [16-23]
      const parsedSegments = rowsToSegments(reconstructSentences(dedupeRows(rows)), 'v1');
      const fullText = parsedSegments.map((s) => s.sourceText).join('\n');
      const hash = captionHash(fullText);

      // Batch 1 (indices 8-15) is already fully translated from a prior
      // run; batches 0 and 2 are not. `completedBatches: 2` is deliberately
      // MISLEADING — a naive "resume from completedBatches" implementation
      // would read this as "batches 0 and 1 are done, only batch 2 is
      // pending" and wrongly skip batch 0.
      const seededSegments = parsedSegments.map((s, i) => ({
        ...s,
        translatedText: i >= 8 && i < 16 ? `seeded-${i}` : null,
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

      // Only batch 0 and batch 2 were pending.
      expect(translateBatch).toHaveBeenCalledTimes(2);
      const requestedIndexRanges = translateBatch.mock.calls
        .map(([segs]) => (segs as TranscriptSegment[]).map((s) => s.index))
        .sort((a, b) => a[0] - b[0]);
      expect(requestedIndexRanges).toEqual([
        [0, 1, 2, 3, 4, 5, 6, 7],
        [16, 17, 18, 19, 20, 21, 22, 23],
      ]);

      expect(deps.upsertBatch).toHaveBeenCalledWith('v1', 0, expect.any(Array));
      expect(deps.upsertBatch).toHaveBeenCalledWith('v1', 2, expect.any(Array));
      expect(deps.upsertBatch).not.toHaveBeenCalledWith('v1', 1, expect.anything());

      expect(result.status).toBe('done');
      expect(result.segments.every((s) => s.translatedText !== null)).toBe(true);
      for (let i = 0; i < 8; i += 1) expect(result.segments[i].translatedText).toBe(`new-${i}`);
      for (let i = 8; i < 16; i += 1) expect(result.segments[i].translatedText).toBe(`seeded-${i}`);
      for (let i = 16; i < 24; i += 1) expect(result.segments[i].translatedText).toBe(`new-${i}`);
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

  describe('onProgress step sequence', () => {
    it('emits extract -> analyze -> translate -> done, with correct done/total', async () => {
      const rows = makeRows(5); // 1 batch, deterministic ordering
      const progress: Array<{ step: number; status: string; done: number; total: number }> = [];
      const onProgress = vi.fn((p) => progress.push(p));
      const deps = makeDeps({ requestTranscript: async () => rows, onProgress });

      await runTranslationPipeline({ videoId: 'v1', tabId: 1, key: 'k' }, deps);

      expect(progress.map((p) => p.step)).toEqual([1, 2, 3, 3, 4]);
      expect(progress[0]).toMatchObject({ status: 'extracting', done: 0, total: 0 });
      expect(progress[1]).toMatchObject({ status: 'analyzing', done: 0, total: 5 });
      expect(progress[2]).toMatchObject({ status: 'translating', done: 0, total: 5 });
      expect(progress[3]).toMatchObject({ status: 'translating', done: 5, total: 5 });
      expect(progress[4]).toMatchObject({ status: 'done', done: 5, total: 5 });
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
