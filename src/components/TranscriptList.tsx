import { formatTimestamp } from '~/lib/transcript-parse';
import type { TranscriptSegment } from '~/types/transcript';

export interface TranscriptListProps {
  segments: TranscriptSegment[];
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
 * `translatedText === null` — the `failed` case where translation stopped
 * partway through (pipeline.ts leaves untranslated segments' `translatedText`
 * as the `null` rowsToSegments sets it to) — renders the English source only,
 * satisfying the brief's "실패 → 원문(영어)만이라도 표시".
 */
export function TranscriptList({ segments }: TranscriptListProps) {
  return (
    <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {segments.map((segment) => (
        <div key={segment.segmentId} className="flex gap-2.5 px-4 py-3">
          <span className="w-10 flex-none font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
            {formatTimestamp(segment.startSec)}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              {segment.sourceText}
            </span>
            {segment.translatedText !== null && (
              <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                {segment.translatedText}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
