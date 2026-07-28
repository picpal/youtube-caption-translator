import type { TranslatePhase, TranslationStatus } from '~/types/transcript';

// M2 Task 8 — pure, framework-agnostic helpers for the panel's live
// `AI 자막 생성` button + 처리 단계 stepper (entrypoints/sidepanel/App.tsx).
// Extracted rather than inlined so the divide-by-zero guard and the
// status->step mapping are unit-testable without mounting a component or
// mocking chrome.* — mirrors this codebase's existing pattern of pulling
// pure logic out of UI/chrome-API code (progress-broadcast.ts,
// `shouldResume` in useTranslation.ts).

/** `0` = no step is meaningfully active — either `'idle'` (nothing started
 * yet) or `'failed'` (a terminal status that, on its own, does not say
 * WHICH step it failed at; callers with a live `TranslationProgress.step`
 * or a persisted `record.error.step` should prefer that over this
 * fallback). */
export type ProcessingStep = 0 | 1 | 2 | 3 | 4;

/**
 * Maps a translation status to the 처리 단계 stepper's active step —
 * 1 Transcript 추출 / 2 용어 분석 / 3 한국어 번역 / 4 자막 적용 — mirroring
 * pipeline.ts's own `step` numbering on `TranslationProgress` exactly.
 */
export function stepForStatus(status: TranslationStatus | 'idle'): ProcessingStep {
  switch (status) {
    case 'extracting':
      return 1;
    case 'analyzing':
      return 2;
    case 'translating':
      return 3;
    case 'done':
      return 4;
    case 'idle':
    case 'failed':
      return 0;
  }
}

/**
 * Divide-by-zero-safe percent complete, rounded to the nearest integer,
 * 0-100. `total === 0` happens on the very first `onProgress` event of a
 * job (pipeline.ts emits `{ done: 0, total: 0, step: 1 }` before any
 * segment count is known) — guarded here so that moment renders `0`, never
 * `NaN`/`Infinity`.
 */
export function progressPercent(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

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
