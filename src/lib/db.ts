import type { VideoMeta } from '~/types/video';
import type { TranscriptSegment, TranslationRecord } from '~/types/transcript';

// Hand-rolled IndexedDB wrapper instead of the `idb` package: the surface is
// a handful of put/get operations on two object stores, and MV3 service
// workers can call the native `indexedDB` global directly. Promisifying
// `IDBRequest` and `IDBTransaction` is a handful of lines; pulling in a
// dependency for that is not justified yet. If a future schema needs
// cursors, indexes, or more complex multi-store transactions, `idb` is
// worth revisiting then — YAGNI applies.

export const DB_NAME = 'youtube-play-assistant';
export const DB_VERSION = 2;
export const STORE_NAME = 'videos';
// M2: one record per video, keyed the same way as `videos` so it can be
// looked up alongside VideoMeta with the same id.
export const TRANSLATIONS_STORE = 'translations';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Guarded by `contains` so a 1->2 upgrade only adds the new store;
      // createObjectStore never touches an existing store's data, so this
      // is non-destructive to `videos` by construction (see db.test.ts's
      // "v1 -> v2 migration" suite).
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
      }
      if (!db.objectStoreNames.contains(TRANSLATIONS_STORE)) {
        db.createObjectStore(TRANSLATIONS_STORE, { keyPath: 'videoId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putVideo(meta: VideoMeta): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(meta);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getVideo(videoId: string): Promise<VideoMeta | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(videoId);
    let result: VideoMeta | null = null;
    request.onsuccess = () => {
      result = (request.result as VideoMeta | undefined) ?? null;
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
  });
}

export async function putTranslation(rec: TranslationRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
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
  });
}

export async function getTranslation(videoId: string): Promise<TranslationRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSLATIONS_STORE, 'readonly');
    const request = tx.objectStore(TRANSLATIONS_STORE).get(videoId);
    let result: TranslationRecord | null = null;
    request.onsuccess = () => {
      result = (request.result as TranslationRecord | undefined) ?? null;
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
  });
}

// Merges a translated batch into the stored record's `segments`, matched by
// `index`. Idempotent: re-applying the same (batchIdx, segs) pair overlays
// the same translatedText values and `completedBatches` stays at
// `max(existing, batchIdx + 1)`, so a second call is a no-op on both
// fields. Only segments present in `segs` are touched — other batches'
// segments pass through unchanged.
//
// Read-modify-write happens inside a single readwrite transaction (get then
// put, no intervening await) so concurrent upsertBatch calls for the same
// videoId can't race each other with a stale read.
//
// Absent-record decision: the pipeline (Task 6) always writes a skeleton via
// putTranslation before batching starts, so an absent record here means
// that contract was violated. Rather than silently fabricate a partial
// record (which would be missing untranslated segments, glossary, etc.),
// this aborts the transaction and rejects with a clear error.
export async function upsertBatch(
  videoId: string,
  batchIdx: number,
  segs: TranscriptSegment[]
): Promise<void> {
  const db = await openDb();
  const notFoundError = () =>
    new Error(`upsertBatch: no translation record found for videoId "${videoId}"`);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSLATIONS_STORE, 'readwrite');
    const store = tx.objectStore(TRANSLATIONS_STORE);
    const getRequest = store.get(videoId);

    getRequest.onsuccess = () => {
      const existing = getRequest.result as TranslationRecord | undefined;
      if (!existing) {
        tx.abort();
        return;
      }

      const incomingByIndex = new Map(segs.map((seg) => [seg.index, seg]));
      const mergedSegments = existing.segments.map((seg) => {
        const incoming = incomingByIndex.get(seg.index);
        return incoming ? { ...seg, translatedText: incoming.translatedText } : seg;
      });

      const updated: TranslationRecord = {
        ...existing,
        segments: mergedSegments,
        completedBatches: Math.max(existing.completedBatches, batchIdx + 1),
        updatedAt: new Date().toISOString(),
      };
      store.put(updated);
    };
    getRequest.onerror = () => {
      db.close();
      reject(getRequest.error);
    };

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? notFoundError());
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? notFoundError());
    };
  });
}
