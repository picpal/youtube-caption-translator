import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import type { VideoSummary } from '~/types/summary';

export type SummaryStatus = 'idle' | 'loading' | 'generating' | 'done' | 'failed';

// Spec §5 — panel-side safety net. If the GENERATE_SUMMARY response never
// arrives (SW evicted / channel dropped mid-call), refetch the cache once
// after this long and converge: cache hit -> done, still nothing -> failed.
// Longer than bg's common path (one 120s-capped fetch + one immediate
// bad_json retry); a user retry after this joins bg's in-flight job via the
// single-flight map, so no double billing.
export const SUMMARY_SAFETY_TIMEOUT_MS = 180_000;

interface UseSummaryParams {
  videoId: string | null;
  enabled: boolean;
}

export interface UseSummaryResult {
  summary: VideoSummary | null;
  status: SummaryStatus;
  error: string | null;
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

  const generate = useCallback(() => {
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
            setError('Summary generation timed out');
          }
        },
        () => {
          if (cycleRef.current !== cycle) return;
          setStatus('failed');
          setError('Summary generation timed out');
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

  return { summary, status, error, generate };
}
