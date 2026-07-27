import type { VideoMeta } from '~/types/video';

// Hand-rolled IndexedDB wrapper instead of the `idb` package: the surface is
// two operations (put/get one object store), and MV3 service workers can
// call the native `indexedDB` global directly. Promisifying `IDBRequest`
// and `IDBTransaction` is a handful of lines; pulling in a dependency for
// that is not justified yet. If M2's transcript caching needs cursors,
// indexes, or multiple stores with more complex transactions, `idb` is
// worth revisiting then — YAGNI applies to a v1 schema.

export const DB_NAME = 'youtube-play-assistant';
export const DB_VERSION = 1;
export const STORE_NAME = 'videos';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
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
