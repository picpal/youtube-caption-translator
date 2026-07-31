import { useEffect, useRef } from 'react';
import { isAutoScrollSuspended, isUserScroll } from '~/lib/playback-sync';
import { formatTimestamp } from '~/lib/transcript-parse';
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
export function TranscriptList({ segments, displayMode = 'both', activeIndex = null, onSeekRow }: TranscriptListProps) {
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastUserScrollAtRef = useRef<number | null>(null);
  const programmaticUntilRef = useRef<number | null>(null);

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
        return (
          <div
            key={segment.segmentId}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
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
            className={`flex gap-3 px-4 py-3 ${
              active ? 'bg-neutral-100 dark:bg-neutral-800/60' : ''
            } ${interactive ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900' : ''}`}
          >
            <span className="w-12 flex-none text-right font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(segment.startSec)}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              {texts.kind === 'dual' ? (
                <>
                  <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {texts.secondaryText}
                  </span>
                  <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                    {texts.primaryText}
                  </span>
                </>
              ) : texts.kind === 'secondary-only' ? (
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {texts.text}
                </span>
              ) : (
                <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                  {texts.text}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
