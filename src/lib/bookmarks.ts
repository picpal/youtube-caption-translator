import type { Bookmark } from '~/types/bookmark';
import type { TranscriptSegment } from '~/types/transcript';
import type { TargetLang } from '~/lib/target-lang';

/**
 * 북마크에 대한 모든 판단은 여기 모인다 — 이 저장소에는 컴포넌트 렌더 테스트
 * 하니스가 없으므로(`library.ts`/`export-doc.ts`와 같은 규율), 컴포넌트는 이
 * 함수들을 호출만 하고 스스로 결정하지 않는다.
 *
 * 시계와 난수를 읽지 않는다 — `bookmarkId`와 `now`는 호출부가 만들어 넘긴다.
 */

/**
 * 영상 흐름 순(저장 순이 아니라). 복습은 시간축을 따라가는 것이 자연스럽고, 한
 * 행에서 조각을 여러 개 저장하면 저장 순은 오히려 뒤섞인다. 같은 `startSec`이
 * 여럿이면(같은 행의 조각들) `createdAt`으로 가른다.
 */
export function sortBookmarks(bookmarks: readonly Bookmark[]): Bookmark[] {
  return [...bookmarks].sort((a, b) =>
    a.startSec !== b.startSec ? a.startSec - b.startSec : a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * Transcript에서 ★로 채워질 행들. `kind === 'excerpt'`는 포함하지 않는다 —
 * 조각만 저장한 행은 "통째로는 아직 저장하지 않은" 상태가 정확하다.
 */
export function bookmarkedSegmentIds(bookmarks: readonly Bookmark[]): Set<string> {
  const ids = new Set<string>();
  for (const bookmark of bookmarks) {
    if (bookmark.kind === 'row') ids.add(bookmark.segmentId);
  }
  return ids;
}

/** 토글의 해제 쪽이 지울 대상. 조각은 중복 판정을 하지 않으므로 걸리지 않는다. */
export function findRowBookmark(
  bookmarks: readonly Bookmark[],
  segmentId: string,
): Bookmark | null {
  return bookmarks.find((b) => b.kind === 'row' && b.segmentId === segmentId) ?? null;
}

export function createRowBookmark(
  segment: TranscriptSegment,
  bookmarkId: string,
  now: Date,
  // finding M1 — 저장 순간에만 알 수 있는 값이라 호출부(useBookmarks)가 넘긴다.
  // 이 함수는 여전히 시계·난수·storage를 읽지 않는다.
  targetLang?: TargetLang,
): Bookmark {
  return {
    bookmarkId,
    segmentId: segment.segmentId,
    // 초 단위로 자른다 — 시크와 내보내기의 `?t=` 링크가 같은 값을 쓰게 한 곳에서만
    // 자르는 것이 두 곳에서 각자 Math.floor하는 것보다 어긋날 여지가 없다.
    startSec: Math.floor(segment.startSec),
    createdAt: now.toISOString(),
    kind: 'row',
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    targetLang,
  };
}

export function createExcerptBookmark(
  segment: TranscriptSegment,
  text: string,
  bookmarkId: string,
  now: Date,
  targetLang?: TargetLang,
): Bookmark {
  return {
    bookmarkId,
    segmentId: segment.segmentId,
    startSec: Math.floor(segment.startSec),
    createdAt: now.toISOString(),
    kind: 'excerpt',
    excerpt: text.trim(),
    targetLang,
  };
}

/**
 * 행을 그냥 클릭하기만 해도 브라우저는 빈 Selection을 남긴다 — 공백뿐인 선택을
 * 조각으로 취급하면 우클릭 메뉴에 쓸모없는 항목이 계속 뜬다.
 */
export function normalizeSelection(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export type RowMenuAction = 'save-row' | 'remove-row' | 'save-excerpt';

export interface RowMenuItem {
  action: RowMenuAction;
  label: string;
}

export function rowMenuItems({
  saved,
  selectionText,
}: {
  saved: boolean;
  selectionText: string | null;
}): RowMenuItem[] {
  const items: RowMenuItem[] = [
    saved
      ? { action: 'remove-row', label: '기억 해제' }
      : { action: 'save-row', label: '이 문장 기억하기' },
  ];
  if (selectionText !== null) {
    items.push({ action: 'save-excerpt', label: '선택한 부분만 기억하기' });
  }
  return items;
}
