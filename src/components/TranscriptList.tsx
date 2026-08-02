import { useEffect, useRef, useState } from 'react';
import { normalizeSelection, rowMenuItems } from '~/lib/bookmarks';
import { isAutoScrollSuspended, isUserScroll } from '~/lib/playback-sync';
import { formatTimestamp } from '~/lib/transcript-parse';
import { RowContextMenu } from '~/components/RowContextMenu';
import type { TranscriptSegment } from '~/types/transcript';

/**
 * Task R7 (Fix 1) — the panel's 자막 표시 selector. `'both'` is the pre-R7
 * default look (source muted + KO primary); `'ko'` shows the translation
 * alone. The `'en'` (source-only) mode was removed 2026-07-31 — YouTube's
 * own player already shows the source captions, and `'both'` covers
 * checking the source in the panel. Persisted to chrome.storage.local via
 * `~/lib/panel-prefs` and restored on panel mount (M3).
 */
export type DisplayMode = 'both' | 'ko';

export interface TranscriptListProps {
  segments: TranscriptSegment[];
  displayMode?: DisplayMode;
  /** Index of the row matching current playback, or null (no highlight). */
  activeIndex?: number | null;
  /** Row click -> seek. Rows render as plain text when omitted. */
  onSeekRow?: (segment: TranscriptSegment) => void;
  /** 통째로 저장된 행의 segmentId 집합 (spec 2026-08-02 §6.2 — 조각은 포함되지 않는다). */
  savedSegmentIds?: ReadonlySet<string>;
  /** 행 통째 저장/해제. **이 prop이 없으면 ☆도 우클릭도 렌더하지 않는다** —
   * `failed` 영상 분기가 그 경로를 쓴다(spec §8). */
  onToggleRow?: (segment: TranscriptSegment) => void;
  /** 행 안에서 드래그한 텍스트를 조각으로 저장. Task 5에서 배선된다. */
  onSaveExcerpt?: (segment: TranscriptSegment, text: string) => void;
}

/**
 * What a single row actually renders, decided purely from a segment + the
 * selected `DisplayMode` — extracted out of the JSX so this decision is
 * unit-testable without mounting a component (this repo has no
 * component-render test setup; see `TranscriptList.test.ts`).
 *
 * Three shapes, not just "one or two strings", because the TWO single-line
 * cases render with DIFFERENT text styles and that distinction matters:
 * - `'dual'` — both lines shown (the original, unchanged `'both'`-mode
 *   look): `secondaryText` (EN, muted/small) above `primaryText` (KO,
 *   dark/larger).
 * - `'secondary-only'` — `'both'` mode's OWN pre-existing fallback for a
 *   still-`null` translation: EN alone, in the muted style (never promoted
 *   to primary — changing that would alter `'both'`'s existing look, which
 *   the brief requires stay exactly as-is).
 * - `'primary-only'` — `'ko'` mode (real KO, or its own source-text
 *   fallback when `translatedText` is still `null`): a SINGLE line, but
 *   rendered in the primary style — the brief is explicit that a single
 *   visible line must never be left looking like an orphaned
 *   secondary/muted line.
 */
export type VisibleTexts =
  | { kind: 'dual'; secondaryText: string; primaryText: string }
  | { kind: 'secondary-only'; text: string }
  | { kind: 'primary-only'; text: string };

export function visibleTexts(segment: TranscriptSegment, mode: DisplayMode): VisibleTexts {
  if (mode === 'both') {
    return segment.translatedText !== null
      ? { kind: 'dual', secondaryText: segment.sourceText, primaryText: segment.translatedText }
      : { kind: 'secondary-only', text: segment.sourceText };
  }
  // mode === 'ko' — "빈 행 금지": a still-untranslated row falls back to
  // the source text rather than rendering nothing.
  return { kind: 'primary-only', text: segment.translatedText ?? segment.sourceText };
}

/**
 * M2 Task 9 — the finished-translation transcript list: one row per
 * `TranscriptSegment`, timestamp + English source + Korean translation.
 * Design source: docs/design/side-panel.dc.html (the "완료"/"오류 및 재시도"
 * blocks' row markup) — timestamp in a right-aligned fixed-width tabular-nums
 * column (`w-12` for `h:mm:ss`), then a stacked English (muted, smaller) /
 * Korean (primary, larger) pair. (Fix: 긴 `1:06:13` 표기가 `w-10`을 넘쳐 갭을 먹던 문제.)
 *
 * `displayMode` (Task R7, Fix 1) defaults to `'both'` — the original,
 * only-mode-that-ever-existed look — so any caller that doesn't yet thread
 * the selector through (there are none left after R7, but this keeps the
 * prop optional rather than a breaking API change) renders unchanged.
 *
 * Task 4 (playback sync) — `activeIndex`/`onSeekRow` are both optional so a
 * caller that doesn't pass them gets the exact pre-Task-4 render (no
 * highlight, no click/keyboard handlers, no auto-scroll effect since
 * `activeIndex` stays `null`).
 */
export function TranscriptList({
  segments,
  displayMode = 'both',
  activeIndex = null,
  onSeekRow,
  savedSegmentIds,
  onToggleRow,
  onSaveExcerpt,
}: TranscriptListProps) {
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastUserScrollAtRef = useRef<number | null>(null);
  const programmaticUntilRef = useRef<number | null>(null);

  // 열려 있는 우클릭 메뉴. 한 번에 하나만 뜬다 — 다른 행을 우클릭하면 이전 것이
  // 교체된다. 선택 텍스트는 우클릭 순간에 얼어붙힌다: 메뉴 항목을 클릭하는
  // 시점에는 브라우저가 Selection을 이미 지웠을 수 있다.
  const [menu, setMenu] = useState<{
    segment: TranscriptSegment;
    x: number;
    y: number;
    selectionText: string | null;
  } | null>(null);

  // Capture-phase document listener: the actual scroll container is the
  // panel's outer overflow div (App.tsx), not this component, and capture
  // catches it regardless of which ancestor scrolls. Scroll events fired by
  // our own scrollIntoView (below) are excluded via the programmatic window
  // (isUserScroll) so auto-scroll doesn't suspend itself.
  useEffect(() => {
    const handleScroll = () => {
      const now = Date.now();
      if (isUserScroll(now, programmaticUntilRef.current)) {
        lastUserScrollAtRef.current = now;
      }
    };
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', handleScroll, { capture: true });
  }, []);

  // Follow the active row (spec §3.3): nearest-block scroll, suspended for
  // AUTO_SCROLL_SUSPEND_MS after a genuine user scroll.
  useEffect(() => {
    if (activeIndex === null) return;
    const row = rowRefs.current[activeIndex];
    if (row === null || row === undefined) return;
    const now = Date.now();
    if (isAutoScrollSuspended(lastUserScrollAtRef.current, now)) return;
    programmaticUntilRef.current = now + 300;
    row.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {segments.map((segment, i) => {
        const texts = visibleTexts(segment, displayMode);
        const active = i === activeIndex;
        const interactive = onSeekRow !== undefined;
        const bookmarkable = onToggleRow !== undefined;
        const saved = savedSegmentIds?.has(segment.segmentId) ?? false;
        return (
          <div
            key={segment.segmentId}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            // fix round 1, Finding 2 — `pr-2` only when a star actually sits
            // in that gutter; without it, a `bookmarkable={false}` row (the
            // `failed`-video branch) must be pixel-identical to the
            // pre-Task-4 single-div row. Hover moved here (was on the inner
            // seek div) so it paints the SAME box as the active-row
            // background below — otherwise the two highlights disagree on
            // width whenever a star is present.
            className={`group flex items-start gap-1 ${bookmarkable ? 'pr-2' : ''} ${
              active ? 'bg-neutral-100 dark:bg-neutral-800/60' : ''
            } ${interactive ? 'hover:bg-neutral-50 dark:hover:bg-neutral-900' : ''}`}
            {...(bookmarkable
              ? {
                  onContextMenu: (e: React.MouseEvent) => {
                    e.preventDefault();
                    const selection = window.getSelection();
                    // 선택이 이 행 안에 있을 때만 조각 후보로 본다 — 다른 행에서
                    // 드래그해 둔 선택이 이 행의 메뉴에 딸려 오면 안 된다.
                    const node = selection?.anchorNode ?? null;
                    const withinRow =
                      node !== null && rowRefs.current[i]?.contains(node) === true;
                    setMenu({
                      segment,
                      x: e.clientX,
                      y: e.clientY,
                      selectionText: withinRow
                        ? normalizeSelection(selection?.toString())
                        : null,
                    });
                  },
                }
              : {})}
          >
            <div
              {...(interactive
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: () => onSeekRow(segment),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSeekRow(segment);
                      }
                    },
                  }
                : {})}
              className={`flex min-w-0 flex-1 gap-3 px-4 py-3 ${interactive ? 'cursor-pointer' : ''}`}
            >
              <span className="w-12 flex-none text-right font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
                {formatTimestamp(segment.startSec)}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <SegmentTexts texts={texts} />
              </div>
            </div>

            {bookmarkable && (
              <button
                type="button"
                onClick={(e) => {
                  // 이 클릭이 위로 새면 행의 시크가 함께 발동한다.
                  e.stopPropagation();
                  onToggleRow(segment);
                }}
                aria-label={saved ? '기억 해제' : '이 문장 기억하기'}
                aria-pressed={saved}
                // 저장된 행은 호버와 무관하게 계속 보인다 — 어느 행을 이미
                // 저장했는지가 Transcript에서 바로 읽혀야 한다. focus-visible을
                // 함께 거는 이유는 키보드 탐색으로도 닿을 수 있어야 해서다.
                className={`mt-3 shrink-0 rounded p-1 transition-opacity hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  saved
                    ? 'text-neutral-800 opacity-100 dark:text-neutral-200'
                    : 'text-neutral-400 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 dark:text-neutral-500'
                }`}
              >
                <StarIcon filled={saved} />
              </button>
            )}
          </div>
        );
      })}

      {menu !== null && onToggleRow !== undefined && (
        <RowContextMenu
          x={menu.x}
          y={menu.y}
          items={rowMenuItems({
            saved: savedSegmentIds?.has(menu.segment.segmentId) ?? false,
            selectionText: menu.selectionText,
          })}
          onSelect={(item) => {
            if (item.action === 'save-excerpt') {
              if (menu.selectionText !== null) onSaveExcerpt?.(menu.segment, menu.selectionText);
            } else {
              // save-row와 remove-row는 같은 토글이다 — 어느 쪽 라벨이 떴는지는
              // rowMenuItems가 이미 saved로 결정했고, toggleRow가 같은 판정을
              // 다시 한다(findRowBookmark).
              onToggleRow(menu.segment);
            }
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * `visibleTexts`의 세 결과를 그리는 유일한 자리. Transcript 행과 Notes 행이 이
 * 컴포넌트를 공유하므로 두 화면의 타이포그래피는 구조적으로 갈라질 수 없다.
 */
export function SegmentTexts({ texts }: { texts: VisibleTexts }) {
  if (texts.kind === 'dual') {
    return (
      <>
        <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {texts.secondaryText}
        </span>
        <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
          {texts.primaryText}
        </span>
      </>
    );
  }
  if (texts.kind === 'secondary-only') {
    return (
      <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        {texts.text}
      </span>
    );
  }
  return (
    <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
      {texts.text}
    </span>
  );
}

/** `LibraryView`의 `TrashIcon`과 같은 방식의 인라인 SVG — 아이콘 라이브러리를 추가하지 않는다. */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z" />
    </svg>
  );
}
