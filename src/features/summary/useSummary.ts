import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import type { VideoSummary } from '~/types/summary';

export type SummaryStatus = 'idle' | 'loading' | 'generating' | 'done' | 'failed';

// Spec §5 — panel-side safety net. If the GENERATE_SUMMARY response never
// arrives (SW evicted / channel dropped mid-call), refetch the cache once
// after this long and converge: cache hit -> done, still nothing -> failed.
// Longer than bg's common path (one 120s-capped fetch + one immediate
// bad_json retry). No double billing either way a user retries after this:
// if bg's job is still running, the retry joins it via the single-flight
// map; if it already finished, `generate`'s own cache pre-check below
// (fix round, Important #4) finds the summary it left behind and never
// calls GENERATE_SUMMARY again at all.
export const SUMMARY_SAFETY_TIMEOUT_MS = 180_000;

// Panel-authored copy (not a bg-originated reason string), deliberately
// Korean since translationErrorDisplay passes unrecognized strings through
// verbatim — the two safety-timer branches below share this one message.
const SUMMARY_TIMEOUT_ERROR = '요약 생성 시간이 초과됐어요. 다시 시도해주세요.';

interface UseSummaryParams {
  videoId: string | null;
  enabled: boolean;
}

export interface UseSummaryResult {
  summary: VideoSummary | null;
  status: SummaryStatus;
  error: string | null;
  // Cache-aware (fix round, Important #4): checks GET_SUMMARY first and only
  // calls GENERATE_SUMMARY if nothing is cached yet. Used by the 빈 상태
  // "요약 생성" button and the failed-state "다시 시도" button. A done summary
  // no longer has its own regenerate affordance — it refreshes via the
  // transcript-side 다시 생성 cascade instead (spec 2026-07-31-regen-cascade
  // §2, background.ts's START_TRANSLATION handler).
  generate: () => void;
}

export function useSummary({ videoId, enabled }: UseSummaryParams): UseSummaryResult {
  const [summary, setSummary] = useState<VideoSummary | null>(null);
  const [status, setStatus] = useState<SummaryStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // Cycle counter: a response or timer from a previous videoId/enabled cycle
  // must not touch current state — same discipline as useTranslation's
  // generation guards and usePlaybackSync's cancelled flag.
  const cycleRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    cycleRef.current += 1;
    const cycle = cycleRef.current;
    clearTimer();
    setSummary(null);
    setError(null);
    if (!enabled || videoId === null) {
      setStatus('idle');
      return clearTimer;
    }
    setStatus('loading');
    void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
      (cached) => {
        if (cycleRef.current !== cycle) return;
        setSummary(cached);
        setStatus(cached ? 'done' : 'idle');
      },
      () => {
        if (cycleRef.current !== cycle) return;
        setStatus('idle');
      },
    );
    return clearTimer;
  }, [videoId, enabled]);

  // The actual billed call + safety timeout — `generate`'s fallback once its
  // own cache pre-check below comes back empty. (Previously also
  // `regenerate`'s whole body; that unconditional-overwrite path no longer
  // exists on the panel side — see the module doc comment above.)
  const startGenerate = useCallback(() => {
    if (videoId === null) return;
    const cycle = cycleRef.current;
    setStatus('generating');
    setError(null);
    clearTimer();
    timerRef.current = setTimeout(() => {
      void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
        (cached) => {
          if (cycleRef.current !== cycle) return;
          if (cached) {
            setSummary(cached);
            setStatus('done');
          } else {
            setStatus('failed');
            setError(SUMMARY_TIMEOUT_ERROR);
          }
        },
        () => {
          if (cycleRef.current !== cycle) return;
          setStatus('failed');
          setError(SUMMARY_TIMEOUT_ERROR);
        },
      );
    }, SUMMARY_SAFETY_TIMEOUT_MS);
    void sendMessage({ type: 'GENERATE_SUMMARY', payload: { videoId } }).then(
      (res) => {
        if (cycleRef.current !== cycle) return;
        clearTimer();
        if (res.ok) {
          setSummary(res.summary);
          setStatus('done');
        } else {
          setStatus('failed');
          setError(res.error);
        }
      },
      () => {
        // A rejected sendMessage usually means the SW dropped the channel,
        // not that generation failed — leave the safety timer to decide.
      },
    );
  }, [videoId]);

  // Fix round, Important #4 — a summary that lands AFTER the 180s safety
  // timeout already marked this attempt `failed` is otherwise invisible to
  // the panel: a plain retry click would re-bill a fresh Gemini call and
  // overwrite the good summary that already landed. Check the cache first
  // (cycle-guarded like every other async callback here); only fall through
  // to an actual GENERATE_SUMMARY call when nothing is there yet. A failed
  // pre-check (rejected sendMessage) falls through the same way — the
  // pre-check is an optimization, not a gate the retry path can get stuck
  // behind.
  const generate = useCallback(() => {
    if (videoId === null) return;
    const cycle = cycleRef.current;
    setStatus('loading');
    setError(null);
    void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
      (cached) => {
        if (cycleRef.current !== cycle) return;
        if (cached) {
          setSummary(cached);
          setStatus('done');
        } else {
          startGenerate();
        }
      },
      () => {
        if (cycleRef.current !== cycle) return;
        startGenerate();
      },
    );
  }, [videoId, startGenerate]);

  return { summary, status, error, generate };
}
