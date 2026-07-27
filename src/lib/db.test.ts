import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VideoMeta } from '~/types/video';
import { DB_NAME, STORE_NAME, getVideo, putVideo } from './db';

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

  it('preserves fetchedAt through the round trip', async () => {
    const meta = makeMeta({ fetchedAt: '2026-07-27T12:34:56.789Z' });
    await putVideo(meta);
    const result = await getVideo(meta.videoId);
    expect(result?.fetchedAt).toBe('2026-07-27T12:34:56.789Z');
  });
});
