import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  bookmarkedSegmentIds,
  createExcerptBookmark,
  createRowBookmark,
  findRowBookmark,
  sortBookmarks,
} from '~/lib/bookmarks';
import { sendMessage } from '~/lib/messaging';
import type { Bookmark } from '~/types/bookmark';
import type { TranscriptSegment } from '~/types/transcript';

export interface BookmarksState {
  /** 항상 `startSec` 오름차순. 소비자가 다시 정렬하지 않는다. */
  bookmarks: Bookmark[];
  /** 조회 자체가 실패했다 — "아직 없음"(빈 배열)과 구분해야 재시도를 보여줄 수 있다. */
  loadFailed: boolean;
  savedSegmentIds: Set<string>;
  toggleRow: (segment: TranscriptSegment) => void;
  saveExcerpt: (segment: TranscriptSegment, text: string) => void;
  remove: (bookmarkId: string) => void;
  reload: () => void;
}

/**
 * 한 영상의 북마크를 들고 있는 단일 소스. Transcript의 ★ 표시, Notes 탭 목록,
 * 탭 뱃지 숫자가 전부 이 배열에서 파생된다 — 세 곳이 각자 조회하면 저장 직후
 * 서로 다른 개수를 보여줄 수 있다.
 *
 * 쓰기는 응답이 돌려주는 전체 목록으로 상태를 갈아끼운다(낙관적 업데이트 없음).
 * 사용자가 체감하는 지연은 확장 내부 메시지 왕복 한 번이고, 그 대가로 롤백해야
 * 하는 중간 상태가 아예 생기지 않는다.
 */
export function useBookmarks(videoId: string | null): BookmarksState {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (videoId === null) {
      setBookmarks([]);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setLoadFailed(false);
    void sendMessage({ type: 'GET_BOOKMARKS', payload: { videoId } })
      .then((res) => {
        if (cancelled) return;
        // 영상을 바꾸는 중 늦게 도착한 응답이 새 영상의 목록을 덮지 않도록
        // cancelled 플래그로 버린다.
        if (res.ok) setBookmarks(sortBookmarks(res.bookmarks));
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, reloadToken]);

  const applyWrite = useCallback(
    (send: () => Promise<{ ok: true; bookmarks: Bookmark[] } | { ok: false; error: string }>) => {
      void send()
        .then((res) => {
          if (res.ok) setBookmarks(sortBookmarks(res.bookmarks));
        })
        // 확장 컨텍스트 무효화 등으로 거부되면 목록을 그대로 둔다 — ★가 켜지지
        // 않는 것이 사용자에게 보이는 실패 신호다.
        .catch(() => {});
    },
    [],
  );

  const toggleRow = useCallback(
    (segment: TranscriptSegment) => {
      if (videoId === null) return;
      const existing = findRowBookmark(bookmarks, segment.segmentId);
      if (existing) {
        applyWrite(() =>
          sendMessage({
            type: 'DELETE_BOOKMARK',
            payload: { videoId, bookmarkId: existing.bookmarkId },
          }),
        );
        return;
      }
      const bookmark = createRowBookmark(segment, crypto.randomUUID(), new Date());
      applyWrite(() => sendMessage({ type: 'ADD_BOOKMARK', payload: { videoId, bookmark } }));
    },
    [applyWrite, bookmarks, videoId],
  );

  const saveExcerpt = useCallback(
    (segment: TranscriptSegment, text: string) => {
      if (videoId === null) return;
      const bookmark = createExcerptBookmark(segment, text, crypto.randomUUID(), new Date());
      applyWrite(() => sendMessage({ type: 'ADD_BOOKMARK', payload: { videoId, bookmark } }));
    },
    [applyWrite, videoId],
  );

  const remove = useCallback(
    (bookmarkId: string) => {
      if (videoId === null) return;
      applyWrite(() => sendMessage({ type: 'DELETE_BOOKMARK', payload: { videoId, bookmarkId } }));
    },
    [applyWrite, videoId],
  );

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const savedSegmentIds = useMemo(() => bookmarkedSegmentIds(bookmarks), [bookmarks]);

  return { bookmarks, loadFailed, savedSegmentIds, toggleRow, saveExcerpt, remove, reload };
}
