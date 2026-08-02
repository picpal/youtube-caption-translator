import { useEffect, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import { parseVideoId } from '~/lib/youtube';
import type { TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import type { VideoMeta } from '~/types/video';
import type { Bookmark } from '~/types/bookmark';

export type ExportDataState =
  | { status: 'loading' }
  | { status: 'unavailable'; reason: 'no-video' | 'not-done' }
  | {
      status: 'ready';
      video: VideoMeta;
      record: TranslationRecord;
      summary: VideoSummary | null;
      bookmarks: Bookmark[];
    };

/**
 * 내보내기에 필요한 세 레코드를 한 번에 읽는다. 패널의 메뉴와 `export.html`이
 * 같은 함수를 쓴다 — 두 소비자가 서로 다른 경로로 읽으면 같은 영상에 대해 다른
 * 문서가 나올 수 있다.
 *
 * 실패(수신자 없음, 컨텍스트 무효화 등)는 `no-video`로 접는다. 이 화면에서
 * 사용자가 할 수 있는 행동은 어느 실패든 동일하기 때문에 사유를 더 쪼개지 않는다.
 */
export async function fetchExportData(videoId: string): Promise<ExportDataState> {
  try {
    const [video, record, summary, bookmarksRes] = await Promise.all([
      sendMessage({ type: 'GET_VIDEO_META', payload: { videoId } }),
      sendMessage({ type: 'GET_TRANSLATION', payload: { videoId } }),
      sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }),
      sendMessage({ type: 'GET_BOOKMARKS', payload: { videoId } }),
    ]);

    if (!video) return { status: 'unavailable', reason: 'no-video' };
    if (!record || record.status !== 'done') return { status: 'unavailable', reason: 'not-done' };
    // Export only ever cares about a summary that's actually persisted — an
    // in-flight one (summary.generating) has nothing to embed yet, so this
    // deliberately drops that flag rather than threading a fourth "still
    // generating" export state through export.html.
    return {
      status: 'ready',
      video,
      record,
      summary: summary.summary,
      // 북마크 조회 실패가 스크립트/요약 내보내기까지 막지는 않는다 — 그 두
      // 항목은 이 값 없이도 완결된다. 대신 기억한 문장 항목이 0개로 비활성화된다.
      bookmarks: bookmarksRes.ok ? bookmarksRes.bookmarks : [],
    };
  } catch {
    return { status: 'unavailable', reason: 'no-video' };
  }
}

/**
 * `enabled`가 true로 바뀔 때(=메뉴가 열릴 때) 1회 조회한다. 상시 구독하지 않는 이유:
 * 헤더는 패널 본문(ReadyBody)의 번역 상태에 접근할 수 없고, 이 정보가 필요한
 * 순간은 메뉴가 열려 있는 동안뿐이다. 닫았다 열면 다시 읽는다 — 그사이 번역이
 * 끝났을 수 있다.
 */
export function useExportData(enabled: boolean): ExportDataState {
  const [state, setState] = useState<ExportDataState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'loading' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const videoId = parseVideoId(tab?.url);
        if (cancelled) return;
        if (!videoId) {
          setState({ status: 'unavailable', reason: 'no-video' });
          return;
        }
        const next = await fetchExportData(videoId);
        if (!cancelled) setState(next);
      } catch {
        // 확장 리로드/업데이트 중 chrome.tabs.query가 "Extension context
        // invalidated"로 거부될 수 있다 — fetchExportData 내부의 try/catch로는
        // 잡히지 않는 실패라 여기서도 감싼다. 다른 실패와 동일하게 no-video로
        // 접어 메뉴가 "확인 중…"에 영원히 머물지 않게 한다.
        if (!cancelled) setState({ status: 'unavailable', reason: 'no-video' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
