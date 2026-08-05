import { Button } from '~/components/Button';
import { SegmentTexts, visibleTexts, type DisplayMode } from '~/components/TranscriptList';
import { formatTimestamp } from '~/lib/transcript-parse';
import type { Bookmark } from '~/types/bookmark';

/**
 * 기억한 문장 목록 (spec 2026-08-02 §3.4). 이 컴포넌트는 판단을 하지 않는다 —
 * 정렬은 `useBookmarks`가 이미 `sortBookmarks`로 끝냈고, 한 행이 무엇을 보여줄지는
 * `visibleTexts`가 정한다. `LibraryView`가 세운 것과 같은 규율이다.
 */
export function NotesPanel({
  bookmarks,
  displayMode,
  loadFailed,
  onSeek,
  onRemove,
  onRetry,
}: {
  bookmarks: Bookmark[];
  displayMode: DisplayMode;
  loadFailed: boolean;
  onSeek: (startSec: number) => void;
  onRemove: (bookmarkId: string) => void;
  onRetry: () => void;
}) {
  if (loadFailed) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 pt-10 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          기억한 문장을 불러오지 못했어요
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          다시 시도
        </Button>
      </div>
    );
  }

  if (bookmarks.length === 0) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 pt-10 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          아직 기억한 문장이 없어요
        </p>
        <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          Transcript에서 문장을 우클릭하거나 ☆를 눌러 저장하세요
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {bookmarks.map((bookmark) => (
        <li key={bookmark.bookmarkId} className="group flex items-start gap-1 pr-2">
          <button
            type="button"
            onClick={() => onSeek(bookmark.startSec)}
            className="flex min-w-0 flex-1 gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
          >
            <span className="body-sm w-[4.4em] flex-none text-right font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(bookmark.startSec)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <BookmarkTexts bookmark={bookmark} displayMode={displayMode} />
            </span>
          </button>
          <button
            type="button"
            onClick={() => onRemove(bookmark.bookmarkId)}
            aria-label="기억 해제"
            // 확인 단계를 두지 않는다 — 라이브러리 삭제(재생성에 5~8분과 Gemini
            // 재과금)와 달리 되돌리기 비용이 사실상 0이다.
            className="mt-3 shrink-0 rounded p-1 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-100 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <TrashIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

function BookmarkTexts({ bookmark, displayMode }: { bookmark: Bookmark; displayMode: DisplayMode }) {
  if (bookmark.kind === 'excerpt') {
    return (
      <span className="body-xl border-l-2 border-neutral-300 pl-2 leading-relaxed text-neutral-900 dark:border-neutral-700 dark:text-neutral-100">
        {bookmark.excerpt}
      </span>
    );
  }

  // Transcript의 행과 똑같은 규칙으로 displayMode를 존중한다 — 판단(visibleTexts)도
  // 마크업(SegmentTexts)도 같은 것을 쓰므로 두 화면이 어긋날 수 없다.
  return <SegmentTexts texts={visibleTexts(bookmark, displayMode)} />;
}

/** `LibraryView`의 것과 같은 인라인 SVG. */
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}
