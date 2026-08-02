import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { TargetLang } from '~/lib/target-lang';

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
// finding M1 — `targetLang`은 ReadyBody가 이미 들고 있는 상태이고, 이 훅은 그
// 값을 저장 순간의 스냅샷으로만 쓴다(구독하지 않는다). 훅 시그니처에 넣는 이유는
// `createRowBookmark`/`createExcerptBookmark`가 순수 함수로 남아야 해서다 —
// panel-prefs나 storage를 직접 읽게 하면 그 순수성이 깨진다.
export function useBookmarks(videoId: string | null, targetLang: TargetLang): BookmarksState {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // `cancelled` (아래 effect 안) 은 그 effect 자신의 in-flight 조회만 막는다.
  // 쓰기(`applyWrite`)는 effect 밖에서 살아 움직이는 별도의 요청이라 그걸로
  // 못 막는다 — videoId가 바뀐 뒤에도 이전 영상의 쓰기 응답이 새 목록을
  // 덮어쓸 수 있다(fix round 1, Finding 1). generation을 videoId가 바뀔
  // 때마다(null로 가는 경우 포함) 올리고, 응답이 돌아왔을 때 이미 값이
  // 달라졌으면 버린다.
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
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
      const generation = generationRef.current;
      void send()
        .then((res) => {
          // 요청을 보낸 뒤 영상이 바뀌었다 — 이전 영상의 목록으로 지금
          // 화면(다른 영상)을 덮지 않는다.
          if (generation !== generationRef.current) return;
          if (res.ok) {
            setBookmarks(sortBookmarks(res.bookmarks));
            // finding M4 — 조회가 실패해 Notes가 "불러오지 못했어요"를 그리고
            // 있어도, 쓰기가 성공했다면 그 실패는 더 이상 사실이 아니다. 지우지
            // 않으면 ☆로 저장은 되는데 Notes는 계속 실패 화면을 보여주는
            // 상태가 남는다.
            setLoadFailed(false);
          }
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
      const bookmark = createRowBookmark(segment, crypto.randomUUID(), new Date(), targetLang);
      applyWrite(() => sendMessage({ type: 'ADD_BOOKMARK', payload: { videoId, bookmark } }));
    },
    [applyWrite, bookmarks, videoId, targetLang],
  );

  const saveExcerpt = useCallback(
    (segment: TranscriptSegment, text: string) => {
      if (videoId === null) return;
      const bookmark = createExcerptBookmark(segment, text, crypto.randomUUID(), new Date(), targetLang);
      applyWrite(() => sendMessage({ type: 'ADD_BOOKMARK', payload: { videoId, bookmark } }));
    },
    [applyWrite, videoId, targetLang],
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
