import { formatTimestamp } from '~/lib/transcript-parse';
import type { TranscriptSegment } from '~/types/transcript';

/**
 * Task R7 (Fix 1) — the panel's 자막 표시 selector, previously static markup
 * with no state behind it. `'both'` is the pre-R7 default look (EN muted +
 * KO primary); `'ko'`/`'en'` show a single line only. Session-local only —
 * this is NOT persisted (storage-backed display prefs are M3, per the R7
 * brief), so it lives as plain `useState` in `App.tsx`'s `ReadyBody`.
 */
export type DisplayMode = 'both' | 'ko' | 'en';

export interface TranscriptListProps {
  segments: TranscriptSegment[];
  displayMode?: DisplayMode;
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
 * - `'primary-only'` — `'ko'`/`'en'` modes (real KO, `'ko'`'s own EN
 *   fallback when `translatedText` is still `null`, or plain EN for `'en'`):
 *   a SINGLE line, but rendered in the primary style — the brief is explicit
 *   that a single visible line must never be left looking like an
 *   orphaned secondary/muted line.
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
  if (mode === 'ko') {
    // "빈 행 금지" — a still-untranslated row falls back to the English
    // source rather than rendering nothing.
    return { kind: 'primary-only', text: segment.translatedText ?? segment.sourceText };
  }
  // mode === 'en'
  return { kind: 'primary-only', text: segment.sourceText };
}

/**
 * M2 Task 9 — the finished-translation transcript list: one row per
 * `TranscriptSegment`, timestamp + English source + Korean translation.
 * Design source: docs/design/side-panel.dc.html (the "완료"/"오류 및 재시도"
 * blocks' row markup) — timestamp in a fixed-width tabular-nums column, then
 * a stacked English (muted, smaller) / Korean (primary, larger) pair.
 *
 * Deliberately a plain mapped list: no virtual scroll (react-window is M3,
 * per the brief) and no playback sync/auto-scroll/click-seek (also M3) — the
 * panel already scrolls the whole `ReadyBody` column (see App.tsx), which is
 * enough for the segment counts a single video's caption track produces.
 *
 * `displayMode` (Task R7, Fix 1) defaults to `'both'` — the original,
 * only-mode-that-ever-existed look — so any caller that doesn't yet thread
 * the selector through (there are none left after R7, but this keeps the
 * prop optional rather than a breaking API change) renders unchanged.
 */
export function TranscriptList({ segments, displayMode = 'both' }: TranscriptListProps) {
  return (
    <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {segments.map((segment) => {
        const visible = visibleTexts(segment, displayMode);
        return (
          <div key={segment.segmentId} className="flex gap-2.5 px-4 py-3">
            <span className="w-10 flex-none font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(segment.startSec)}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              {visible.kind === 'dual' && (
                <>
                  <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {visible.secondaryText}
                  </span>
                  <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                    {visible.primaryText}
                  </span>
                </>
              )}
              {visible.kind === 'secondary-only' && (
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {visible.text}
                </span>
              )}
              {visible.kind === 'primary-only' && (
                <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                  {visible.text}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
