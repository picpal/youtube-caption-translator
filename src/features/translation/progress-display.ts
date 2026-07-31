import type { TranslatePhase } from '~/types/transcript';

// M2 refactor (single large request + stage progress) — Korean labels for
// step 3's request/response sub-phases (요청 전송 → 응답 수신 → 파싱·정합성),
// replacing the dropped per-segment "N / total" counter.
const TRANSLATE_PHASE_LABELS: Record<TranslatePhase, string> = {
  sending: '요청 전송',
  receiving: '응답 수신',
  parsing: '파싱·정합성',
};

/** `undefined`/`null` (no phase — outside step 3, or step 3's own
 * "entering this step"/"chunk just completed" events) renders as no label
 * at all, letting callers omit the phase clause entirely rather than show a
 * placeholder. */
export function translatePhaseLabel(phase: TranslatePhase | undefined): string | null {
  return phase ? TRANSLATE_PHASE_LABELS[phase] : null;
}

/**
 * Task R2 (progress UX polish) — formats a panel-side elapsed-seconds
 * counter as Korean copy: `"12초 경과"` under a minute, `"1분 05초 경과"` at
 * or above it (a single in-flight chunk is ~15s now, but the WHOLE
 * translating phase can still run past a minute across several chunks or a
 * rate-limit wait, so the counter needs to read sensibly past 59s too).
 * Pure formatting only — the ticking itself is a `setInterval` owned by the
 * panel component (`App.tsx`'s `useElapsedSeconds`), never threaded through
 * the background Port.
 */
export function formatElapsedTime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  if (safeSeconds < 60) return `${safeSeconds}초 경과`;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}분 ${String(seconds).padStart(2, '0')}초 경과`;
}
