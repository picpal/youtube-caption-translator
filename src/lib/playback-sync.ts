import type { TranscriptSegment } from '~/types/transcript';

/** CS-side tick throttle interval (spec §2: timeupdate throttled to 500ms). */
export const PLAYBACK_TICK_INTERVAL_MS = 500;

/** Auto-scroll stays suspended this long after a genuine user scroll (spec §3.3). */
export const AUTO_SCROLL_SUSPEND_MS = 5000;

/**
 * The last index whose `startSec <= t`, or `null` when `t` is before the
 * first segment (or the list is empty). Binary search — segments are stored
 * in ascending `startSec` order (rowsToSegments preserves transcript order).
 */
export function activeSegmentIndex(
  segments: readonly Pick<TranscriptSegment, 'startSec'>[],
  t: number,
): number | null {
  if (segments.length === 0 || t < segments[0].startSec) return null;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].startSec <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Throttle decision for the CS tick stream: first tick always emits. */
export function shouldEmitTick(
  lastEmitAtMs: number | null,
  nowMs: number,
  intervalMs: number = PLAYBACK_TICK_INTERVAL_MS,
): boolean {
  return lastEmitAtMs === null || nowMs - lastEmitAtMs >= intervalMs;
}

/**
 * Whether auto-scroll is currently suspended because the user scrolled the
 * list themselves within the last `suspendMs` (spec §3.3 — no hijacking).
 */
export function isAutoScrollSuspended(
  lastUserScrollAtMs: number | null,
  nowMs: number,
  suspendMs: number = AUTO_SCROLL_SUSPEND_MS,
): boolean {
  return lastUserScrollAtMs !== null && nowMs - lastUserScrollAtMs < suspendMs;
}

/**
 * Distinguishes a genuine user scroll from the scroll event our own
 * `scrollIntoView` fires: events inside the programmatic window (set right
 * before calling scrollIntoView) do not count as user scrolls.
 */
export function isUserScroll(
  nowMs: number,
  programmaticScrollUntilMs: number | null,
): boolean {
  return programmaticScrollUntilMs === null || nowMs >= programmaticScrollUntilMs;
}
