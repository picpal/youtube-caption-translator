import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VideoMeta } from '~/types/video';
import type { TranscriptSegment, TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import {
  DB_NAME,
  STORE_NAME,
  TRANSLATIONS_STORE,
  getTranslation,
  getVideo,
  putTranslation,
  putVideo,
  upsertBatch,
  putSummary,
  getSummary,
} from './db';

function makeMeta(overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    videoId: 'zjkBMFhNj_g',
    url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
    title: '[1hr Talk] Intro to Large Language Models',
    channelName: 'Andrej Karpathy',
    thumbnailUrl: 'https://i.ytimg.com/vi/zjkBMFhNj_g/hqdefault.jpg',
    durationSeconds: 3588,
    captionAvailability: 'auto-only',
    fetchedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

// Deletes the whole database so each test starts from a clean slate. This is
// a real IndexedDB operation (via fake-indexeddb), not a mock reset.
function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

// Counts records directly in the object store, bypassing db.ts entirely, so
// the "overwrites rather than duplicates" test verifies real storage state
// instead of trusting getVideo() to tell the truth about it.
function countRecords(): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const countRequest = tx.objectStore(STORE_NAME).count();
      countRequest.onsuccess = () => resolve(countRequest.result);
      countRequest.onerror = () => reject(countRequest.error);
      tx.oncomplete = () => db.close();
    };
    request.onerror = () => reject(request.error);
  });
}

// Counts records directly in the translations object store, bypassing db.ts,
// mirroring countRecords() above for the M2 store.
function countTranslationRecords(): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(TRANSLATIONS_STORE, 'readonly');
      const countRequest = tx.objectStore(TRANSLATIONS_STORE).count();
      countRequest.onsuccess = () => resolve(countRequest.result);
      countRequest.onerror = () => reject(countRequest.error);
      tx.oncomplete = () => db.close();
    };
    request.onerror = () => reject(request.error);
  });
}

// Seeds a v1 database (only the `videos` store, as db.ts shipped in M1)
// using raw indexedDB calls that bypass db.ts entirely, so the later v2
// migration test exercises a real 1->2 onupgradeneeded transition rather
// than a same-version no-op.
function seedV1Database(video: VideoMeta): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(video);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    request.onerror = () => reject(request.error);
  });
}

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  const index = overrides.index ?? 0;
  return {
    segmentId: `zjkBMFhNj_g:${index}`,
    videoId: 'zjkBMFhNj_g',
    index,
    startSec: index * 10,
    endSec: index * 10 + 10,
    sourceText: `source text ${index}`,
    translatedText: null,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<TranslationRecord> = {}): TranslationRecord {
  return {
    videoId: 'zjkBMFhNj_g',
    captionHash: 'hash-a',
    sourceLang: 'en',
    status: 'translating',
    segments: [makeSegment({ index: 0 }), makeSegment({ index: 1 }), makeSegment({ index: 2 })],
    glossary: [{ term: 'LLM', translation: 'LLM', keepEnglish: true }],
    completedBatches: 0,
    totalBatches: 2,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  await deleteDb();
});

describe('putVideo / getVideo', () => {
  it('round-trips a stored video', async () => {
    const meta = makeMeta();
    await putVideo(meta);
    const result = await getVideo(meta.videoId);
    expect(result).toEqual(meta);
  });

  it('returns null for an absent id', async () => {
    const result = await getVideo('does-not-exist');
    expect(result).toBeNull();
  });

  it('overwrites rather than duplicating on repeated put with the same videoId', async () => {
    const original = makeMeta({ title: 'Original title' });
    const updated = makeMeta({ title: 'Updated title' });

    await putVideo(original);
    await putVideo(updated);

    const result = await getVideo(original.videoId);
    expect(result?.title).toBe('Updated title');

    const count = await countRecords();
    expect(count).toBe(1);
  });

  it('round-trips a null captionAvailability as null, not undefined', async () => {
    // `null` means "nothing about captions could be read, ask again later",
    // which is a different instruction to a caller than any of the four
    // verdicts. If structured clone or the store dropped it to `undefined`,
    // a consumer using `?? 'none'` would silently invent a negative.
    const meta = makeMeta({ captionAvailability: null });
    await putVideo(meta);
    const result = await getVideo(meta.videoId);
    expect(result?.captionAvailability).toBeNull();
    expect('captionAvailability' in (result as object)).toBe(true);
  });

  it('preserves fetchedAt through the round trip', async () => {
    const meta = makeMeta({ fetchedAt: '2026-07-27T12:34:56.789Z' });
    await putVideo(meta);
    const result = await getVideo(meta.videoId);
    expect(result?.fetchedAt).toBe('2026-07-27T12:34:56.789Z');
  });
});

describe('v1 -> v2 migration', () => {
  it('adds the translations store without touching existing videos data', async () => {
    const seeded = makeMeta({ title: 'Seeded before migration' });
    await seedV1Database(seeded);

    // Any db.ts call opens with DB_VERSION (2), triggering the 1->2
    // onupgradeneeded on the database seeded above.
    const migratedVideo = await getVideo(seeded.videoId);
    expect(migratedVideo).toEqual(seeded);

    const translationCount = await countTranslationRecords();
    expect(translationCount).toBe(0);
  });
});

describe('putTranslation / getTranslation', () => {
  it('round-trips a full TranslationRecord with segments and glossary', async () => {
    const record = makeRecord();
    await putTranslation(record);
    const result = await getTranslation(record.videoId);
    expect(result).toEqual(record);
  });

  it('returns null for an absent videoId', async () => {
    const result = await getTranslation('does-not-exist');
    expect(result).toBeNull();
  });
});

describe('upsertBatch', () => {
  it('is idempotent: re-applying the same batch does not double-advance or duplicate segments', async () => {
    const record = makeRecord({ completedBatches: 0, totalBatches: 2 });
    await putTranslation(record);

    const batch0Segs = [
      makeSegment({ index: 0, translatedText: '번역 0' }),
      makeSegment({ index: 1, translatedText: '번역 1' }),
    ];

    await upsertBatch(record.videoId, 0, batch0Segs);
    const firstResult = await getTranslation(record.videoId);

    await upsertBatch(record.videoId, 0, batch0Segs);
    const secondResult = await getTranslation(record.videoId);

    expect(secondResult?.completedBatches).toBe(firstResult?.completedBatches);
    expect(secondResult?.completedBatches).toBe(1);
    expect(secondResult?.segments).toEqual(firstResult?.segments);
    expect(secondResult?.segments.find((s) => s.index === 0)?.translatedText).toBe('번역 0');
    expect(secondResult?.segments.find((s) => s.index === 1)?.translatedText).toBe('번역 1');
    // Untouched by either batch.
    expect(secondResult?.segments.find((s) => s.index === 2)?.translatedText).toBeNull();

    const count = await countTranslationRecords();
    expect(count).toBe(1);
  });

  it('advances completedBatches for a later batch and only touches its own segments', async () => {
    const record = makeRecord({ completedBatches: 0, totalBatches: 2 });
    await putTranslation(record);

    await upsertBatch(record.videoId, 0, [
      makeSegment({ index: 0, translatedText: '번역 0' }),
      makeSegment({ index: 1, translatedText: '번역 1' }),
    ]);
    await upsertBatch(record.videoId, 1, [makeSegment({ index: 2, translatedText: '번역 2' })]);

    const result = await getTranslation(record.videoId);
    expect(result?.completedBatches).toBe(2);
    expect(result?.segments.find((s) => s.index === 0)?.translatedText).toBe('번역 0');
    expect(result?.segments.find((s) => s.index === 1)?.translatedText).toBe('번역 1');
    expect(result?.segments.find((s) => s.index === 2)?.translatedText).toBe('번역 2');
  });

  it('does not regress completedBatches when an earlier batch is re-applied after a later one', async () => {
    const record = makeRecord({ completedBatches: 0, totalBatches: 2 });
    await putTranslation(record);

    await upsertBatch(record.videoId, 1, [makeSegment({ index: 2, translatedText: '번역 2' })]);
    await upsertBatch(record.videoId, 0, [makeSegment({ index: 0, translatedText: '번역 0' })]);

    const result = await getTranslation(record.videoId);
    expect(result?.completedBatches).toBe(2);
  });

  it('rejects rather than fabricating a record when none exists for the videoId', async () => {
    await expect(
      upsertBatch('no-such-video', 0, [makeSegment({ index: 0, translatedText: '번역 0' })])
    ).rejects.toThrow();

    const count = await countTranslationRecords();
    expect(count).toBe(0);
  });
});

describe('captionHash invalidation via overwrite', () => {
  it('replaces stale translations when putTranslation overwrites with a new captionHash', async () => {
    const original = makeRecord({
      captionHash: 'A',
      segments: [makeSegment({ index: 0, translatedText: '오래된 번역' })],
      completedBatches: 1,
    });
    await putTranslation(original);

    const regenerated = makeRecord({
      captionHash: 'B',
      segments: [makeSegment({ index: 0, translatedText: null })],
      completedBatches: 0,
    });
    await putTranslation(regenerated);

    const result = await getTranslation(original.videoId);
    expect(result?.captionHash).toBe('B');
    expect(result?.segments[0].translatedText).toBeNull();

    const count = await countTranslationRecords();
    expect(count).toBe(1);
  });
});

function makeSummary(overrides: Partial<VideoSummary> = {}): VideoSummary {
  return {
    videoId: 'zjkBMFhNj_g',
    purpose: 'Explains how LLMs are trained and used.',
    mainArguments: ['Training is compression.', 'Fine-tuning aligns behavior.'],
    sections: [
      { startSec: 0, title: '문제 정의' },
      { startSec: 620, title: '모델 구조' },
    ],
    keywords: ['LLM', 'Fine-tuning'],
    conclusion: 'LLMs are becoming an OS-like platform.',
    model: 'gemini-3.5-flash-lite',
    createdAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

// Seeds a v2 database (videos + translations, as db.ts shipped in M2) with
// raw indexedDB calls, so the v3 migration test exercises a real 2->3
// onupgradeneeded transition — mirrors seedV1Database above.
function seedV2Database(rec: TranslationRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
      db.createObjectStore(TRANSLATIONS_STORE, { keyPath: 'videoId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(TRANSLATIONS_STORE, 'readwrite');
      tx.objectStore(TRANSLATIONS_STORE).put(rec);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    request.onerror = () => reject(request.error);
  });
}

describe('v2 -> v3 migration', () => {
  it('adds the summaries store without touching existing translations data', async () => {
    const rec = makeRecord({ status: 'done' });
    await seedV2Database(rec);
    await putSummary(makeSummary());
    expect(await getSummary('zjkBMFhNj_g')).toEqual(makeSummary());
    expect(await getTranslation('zjkBMFhNj_g')).toEqual(rec);
  });
});

describe('putSummary / getSummary', () => {
  it('round-trips a stored summary', async () => {
    const summary = makeSummary();
    await putSummary(summary);
    expect(await getSummary(summary.videoId)).toEqual(summary);
  });

  it('returns null for an absent videoId', async () => {
    expect(await getSummary('missing')).toBeNull();
  });

  it('overwrites rather than duplicating on repeated put (regeneration path)', async () => {
    await putSummary(makeSummary({ purpose: 'first' }));
    await putSummary(makeSummary({ purpose: 'second' }));
    expect((await getSummary('zjkBMFhNj_g'))?.purpose).toBe('second');
  });
});
