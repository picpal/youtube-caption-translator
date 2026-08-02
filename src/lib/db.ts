import type { VideoMeta } from '~/types/video';
import type { TranscriptSegment, TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import { DEFAULT_TARGET_LANG } from '~/lib/target-lang';
import type { TranslationDigest } from '~/types/library';
import type { Bookmark, BookmarkRecord } from '~/types/bookmark';

// Hand-rolled IndexedDB wrapper instead of the `idb` package: the surface is
// a handful of put/get operations on two object stores, and MV3 service
// workers can call the native `indexedDB` global directly. Promisifying
// `IDBRequest` and `IDBTransaction` is a handful of lines; pulling in a
// dependency for that is not justified yet. If a future schema needs
// cursors, indexes, or more complex multi-store transactions, `idb` is
// worth revisiting then — YAGNI applies.

// Storage key, not a display name — changing it starts a fresh empty
// database (existing rows under the old name are orphaned, not migrated).
export const DB_NAME = 'youtube-caption-translator';
export const DB_VERSION = 4;
export const STORE_NAME = 'videos';
// M2: one record per video, keyed the same way as `videos` so it can be
// looked up alongside VideoMeta with the same id.
export const TRANSLATIONS_STORE = 'translations';
// M3: one Korean summary per video, generated on demand from a `done`
// translation record (spec 2026-07-30 §2). Keyed like the other stores so
// regeneration is a plain overwrite of the same key.
export const SUMMARIES_STORE = 'summaries';
// M3: 사용자가 고른 문장(spec 2026-08-02 §4.2). 영상당 레코드 하나에 배열로
// 담는다 — 북마크마다 레코드를 만들면 `videoId` 인덱스가 필요해지는데, 이 파일
// 서두의 판단("인덱스가 필요해지면 idb 패키지를 재검토")이 걸리는 선이다. 배열이면
// 인덱스가 필요 없고 나머지 세 스토어와 키 규칙도 같아진다.
export const BOOKMARKS_STORE = 'bookmarks';

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
      if (!db.objectStoreNames.contains(SUMMARIES_STORE)) {
        db.createObjectStore(SUMMARIES_STORE, { keyPath: 'videoId' });
      }
      if (!db.objectStoreNames.contains(BOOKMARKS_STORE)) {
        db.createObjectStore(BOOKMARKS_STORE, { keyPath: 'videoId' });
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

export async function putSummary(summary: VideoSummary): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARIES_STORE, 'readwrite');
    tx.objectStore(SUMMARIES_STORE).put(summary);
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

export async function getSummary(videoId: string): Promise<VideoSummary | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARIES_STORE, 'readonly');
    const request = tx.objectStore(SUMMARIES_STORE).get(videoId);
    let result: VideoSummary | null = null;
    request.onsuccess = () => {
      result = (request.result as VideoSummary | undefined) ?? null;
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

// 라이브러리 목록용 조회 (spec 2026-08-01 §4.3). `getAll` 대신 커서를 쓰는 이유는
// 읽기 속도가 아니다 — 실측으로 커서가 오히려 조금 느리다(4편 339 KB 기준
// getAll 1.6 ms vs 커서 2.6 ms, 레코드마다 왕복이 생겨서). 이유는 결과 크기다:
// 같은 입력에서 getAll은 339 KB를, 이 투영은 0.3 KB를 낸다. 그 차이가 그대로
// sendMessage의 구조화 복제 비용이 된다.
export async function listTranslationDigests(): Promise<TranslationDigest[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSLATIONS_STORE, 'readonly');
    const request = tx.objectStore(TRANSLATIONS_STORE).openCursor();
    const digests: TranslationDigest[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      const record = cursor.value as TranslationRecord;
      digests.push({
        videoId: record.videoId,
        status: record.status,
        segmentCount: record.segments.length,
        targetLang: record.targetLang ?? DEFAULT_TARGET_LANG,
        updatedAt: record.updatedAt,
      });
      cursor.continue();
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(digests);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    // Fix round, Minor #3 — an abort with no preceding request error (e.g. a
    // spontaneous abort) would otherwise leave this promise pending forever,
    // and GET_LIBRARY's Promise.all along with it. Matches deleteVideoData's
    // existing onerror/onabort shape below.
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getAllVideos(): Promise<VideoMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    let result: VideoMeta[] = [];
    request.onsuccess = () => {
      result = (request.result as VideoMeta[] | undefined) ?? [];
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    // Fix round, Minor #3 — see listTranslationDigests' onabort comment: with
    // neither handler, a transaction that aborts without a preceding request
    // error left this promise (and GET_LIBRARY's Promise.all) pending
    // forever.
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getAllSummaries(): Promise<VideoSummary[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARIES_STORE, 'readonly');
    const request = tx.objectStore(SUMMARIES_STORE).getAll();
    let result: VideoSummary[] = [];
    request.onsuccess = () => {
      result = (request.result as VideoSummary[] | undefined) ?? [];
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    // Fix round, Minor #3 — see getAllVideos' onabort comment above; the same
    // hang applies here and GET_LIBRARY reads both in the same Promise.all.
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getBookmarks(videoId: string): Promise<Bookmark[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKMARKS_STORE, 'readonly');
    const request = tx.objectStore(BOOKMARKS_STORE).get(videoId);
    let result: Bookmark[] = [];
    request.onsuccess = () => {
      // 레코드 부재는 정상이다(그 영상에서 아직 아무것도 저장하지 않음) — 빈
      // 배열로 접는다. `null`을 돌려주면 모든 호출부가 같은 폴백을 반복해야 한다.
      result = (request.result as BookmarkRecord | undefined)?.bookmarks ?? [];
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// 추가와 삭제가 공유하는 read-modify-write. get -> put이 사이에 `await` 없이 한
// readwrite 트랜잭션 안에서 끝나므로, 같은 videoId에 대한 동시 호출이 stale read로
// 서로를 덮어쓸 수 없다 — `upsertBatch`가 세운 같은 관용이다.
async function mutateBookmarks(
  videoId: string,
  mutate: (current: Bookmark[]) => Bookmark[],
): Promise<Bookmark[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKMARKS_STORE, 'readwrite');
    const store = tx.objectStore(BOOKMARKS_STORE);
    const getRequest = store.get(videoId);
    let next: Bookmark[] = [];

    getRequest.onsuccess = () => {
      const existing = getRequest.result as BookmarkRecord | undefined;
      next = mutate(existing?.bookmarks ?? []);
      const updated: BookmarkRecord = { videoId, bookmarks: next };
      store.put(updated);
    };
    getRequest.onerror = () => {
      db.close();
      reject(getRequest.error);
    };

    tx.oncomplete = () => {
      db.close();
      resolve(next);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// 같은 bookmarkId를 두 번 넣지 않는다 — 메시지가 재전달돼도 목록이 불어나지
// 않게 하는 멱등성이다.
export function addBookmark(videoId: string, bookmark: Bookmark): Promise<Bookmark[]> {
  return mutateBookmarks(videoId, (current) =>
    current.some((existing) => existing.bookmarkId === bookmark.bookmarkId)
      ? current
      : [...current, bookmark],
  );
}

export function deleteBookmark(videoId: string, bookmarkId: string): Promise<Bookmark[]> {
  return mutateBookmarks(videoId, (current) =>
    current.filter((existing) => existing.bookmarkId !== bookmarkId),
  );
}

// 번역·요약·북마크를 한 트랜잭션으로 지운다. 원자성이 필요한 이유: 셋이 갈라지면
// 목록에서 사라진 영상의 요약이나 북마크가 영원히 고아로 남는다(목록의 기준
// 스토어가 `translations`이므로 다시 보이지 않는다).
//
// `videos`의 메타는 일부러 남긴다 — 제목·썸네일 캐시일 뿐이고 그 영상을 다시
// 방문하면 어차피 덮어써진다 (spec §7.1).
//
// 없는 키를 지우는 것은 IndexedDB에서 성공하는 no-op이므로 이 함수는 멱등이다.
export async function deleteVideoData(videoId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRANSLATIONS_STORE, SUMMARIES_STORE, BOOKMARKS_STORE], 'readwrite');
    tx.objectStore(TRANSLATIONS_STORE).delete(videoId);
    tx.objectStore(SUMMARIES_STORE).delete(videoId);
    tx.objectStore(BOOKMARKS_STORE).delete(videoId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
