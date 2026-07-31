import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import { summaryStateFor } from '~/lib/summary';
import type { AppMessage } from '~/types/message';
import type { VideoSummary } from '~/types/summary';

export type SummaryStatus = 'idle' | 'loading' | 'generating' | 'done' | 'failed';

// Spec §5 — panel-side safety net. If the GENERATE_SUMMARY response never
// arrives (SW evicted / channel dropped mid-call), refetch the cache once
// after this long and converge: cache hit -> done, still nothing -> failed.
// Longer than bg's worst-case path (one `SUMMARY_FETCH_TIMEOUT_MS`-capped
// fetch, 300s, + one immediate bad_json retry) with headroom to spare, hence
// 360s. 2026-07-31 timeout fix, both rounds: this used to be 180s, sized
// against the GENERIC `GEMINI_FETCH_TIMEOUT_MS` (120s) — but a real-Chrome
// DoD measured the SAME whole-video summary call legitimately succeeding at
// 182,657ms (3m3s) as a raw fetch, then 225,129ms (3m45s) through the full
// real panel flow on a later run. The takeaway isn't "about 3 minutes," it's
// that this call's latency swings by roughly a quarter on unchanged input —
// so both this constant and `SUMMARY_FETCH_TIMEOUT_MS` are sized for the
// WORST run observed plus real margin, not the typical one; the first-round
// fix (240s/300s) left only 15s of headroom over the second measurement,
// thin enough that a third, slightly slower run could plausibly trip it
// again. No double billing either way a user retries after this: if bg's
// job is still running, the retry joins it via the single-flight map; if it
// already finished, `generate`'s own cache pre-check below (fix round,
// Important #4) finds the summary it left behind and never calls
// GENERATE_SUMMARY again at all.
export const SUMMARY_SAFETY_TIMEOUT_MS = 360_000;

// Panel-authored copy (not a bg-originated reason string), deliberately
// Korean since translationErrorDisplay passes unrecognized strings through
// verbatim — the two safety-timer branches below share this one message.
const SUMMARY_TIMEOUT_ERROR = '요약 생성 시간이 초과됐어요. 다시 시도해주세요.';

// summary-inflight fix (2026-07-31/08-01) — how often the initial-load
// convergence poll (below) re-sends GET_SUMMARY while a summary job it
// noticed but did not itself start is still `generating`. There is no
// promise to await here (unlike `startGenerate`'s GENERATE_SUMMARY call):
// nobody on the panel side kicked this job off, it was already running in
// the background when this hook's first GET_SUMMARY read caught it
// mid-flight (spec background: since `9197809` a summary starts
// automatically alongside translation). 5s is a plain "check back
// periodically" cadence, not derived from the job's own timing — that
// timing swings from ~35s to ~5 minutes on same-size input (see
// SUMMARY_SAFETY_TIMEOUT_MS's doc comment), so no fixed interval could be
// "tuned" to it anyway; this just needs to be short enough that the panel
// notices convergence promptly without hammering background every render.
const SUMMARY_POLL_INTERVAL_MS = 5_000;

// Poll-path failure copy — distinct from SUMMARY_TIMEOUT_ERROR above because
// this is a different convergence path with a different reason: the poll
// isn't racing a fixed timeout, it's watching `inFlightSummaries` (via
// `generating`) go from true to false with nothing cached at the end, i.e.
// the job the panel noticed already failed on background's side. Background
// never hands back WHY (GET_SUMMARY is a cache read, not a result channel),
// so — same as SUMMARY_TIMEOUT_ERROR — this is panel-authored, not a
// bg-originated reason string.
const SUMMARY_GENERATING_FAILED_ERROR = '요약 생성에 실패했어요. 다시 시도해주세요.';

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
  // Separate from `timerRef` on purpose: `timerRef` is `startGenerate`'s
  // one-shot safety timeout for the MANUAL generate path (a promise it is
  // actually awaiting). `pollTimerRef` below is the initial-load path's
  // repeating convergence poll for a job THIS hook never started — the two
  // timers have independent lifecycles (one fires once, the other
  // reschedules itself) and can be live at the same time in principle, so
  // they get their own ref/clear pair rather than sharing one.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearPoll = () => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    cycleRef.current += 1;
    const cycle = cycleRef.current;
    clearTimer();
    clearPoll();
    setSummary(null);
    setError(null);
    if (!enabled || videoId === null) {
      setStatus('idle');
      return () => {
        clearTimer();
        clearPoll();
      };
    }
    setStatus('loading');

    // summary-inflight fix — convergence poll for a summary job this hook
    // noticed via `generating: true` but did not itself start (the parallel
    // auto-trigger from `9197809` means one can already be running the
    // moment this hook's very first GET_SUMMARY read lands). There is no
    // GENERATE_SUMMARY promise to await here, so the only way to learn how
    // it ends is to keep asking. Re-sends GET_SUMMARY every
    // SUMMARY_POLL_INTERVAL_MS and folds the result through the SAME
    // `summaryStateFor` used for the first read, so both call sites agree on
    // what each response shape means:
    // - 'done'       -> show it, stop polling.
    // - 'idle'       -> the job that was running has since finished with
    //                   nothing cached, i.e. it failed; surface that as
    //                   `failed` (with panel-authored copy — background
    //                   doesn't hand back a reason on a cache read) so the
    //                   existing `failed` UI's 다시 시도 button becomes the
    //                   recovery path, and stop polling.
    // - 'generating' -> still running; schedule the next poll.
    const pollUntilSettled = () => {
      pollTimerRef.current = setTimeout(() => {
        void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
          (res) => {
            if (cycleRef.current !== cycle) return;
            const next = summaryStateFor(res);
            if (next === 'generating') {
              pollUntilSettled();
              return;
            }
            pollTimerRef.current = null;
            if (next === 'done') {
              setSummary(res.summary);
              setStatus('done');
            } else {
              setStatus('failed');
              setError(SUMMARY_GENERATING_FAILED_ERROR);
            }
          },
          () => {
            // Background unreachable this round — retry on the next tick
            // rather than giving up; same spirit as startGenerate's own
            // rejection handling below (a dropped channel isn't proof the
            // job itself failed).
            if (cycleRef.current !== cycle) return;
            pollUntilSettled();
          },
        );
      }, SUMMARY_POLL_INTERVAL_MS);
    };

    void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
      (res) => {
        if (cycleRef.current !== cycle) return;
        const next = summaryStateFor(res);
        setSummary(res.summary);
        setStatus(next);
        // Only the initial read can kick off polling — once `generate()`
        // takes over (status flips through 'loading'/'generating' there
        // instead) this effect's own cycle guard means these callbacks are
        // for a stale run anyway, so there is no risk of double-polling.
        if (next === 'generating') pollUntilSettled();
      },
      () => {
        if (cycleRef.current !== cycle) return;
        setStatus('idle');
      },
    );

    // Final-review fix (C1) — the 다시 생성 cascade's convergence signal.
    // Without this, an already-open Summary tab has no way to learn its
    // `videoId`'s summary was just replaced: this hook only loads
    // GET_SUMMARY once per `[videoId, enabled]` above, tab switches don't
    // change either dependency, and the done-state panel no longer has its
    // own regenerate button to force a reload. Registered alongside that
    // cache-load (same cycle guard, same videoId closure), torn down on
    // cleanup — same pattern as `useCurrentVideo.ts`'s `CURRENT_VIDEO_UPDATED`
    // listener.
    const handleSummaryRefreshed = (msg: AppMessage) => {
      if (msg.type !== 'SUMMARY_REFRESHED') return;
      if (msg.payload.videoId !== videoId) return;
      if (cycleRef.current !== cycle) return;
      void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
        (refreshed) => {
          if (cycleRef.current !== cycle) return;
          // Background only broadcasts this AFTER `putSummary` persisted the
          // new summary, so a `summary: null` refetch here would mean the
          // cache was cleared out from under us mid-flight — leave state
          // as-is rather than regress a shown summary back to empty.
          if (refreshed.summary) {
            // This can race the poll above (both noticed the same job, this
            // arrived first) — stop polling so a stray in-flight poll
            // doesn't overwrite the `done` state this just set.
            clearPoll();
            setSummary(refreshed.summary);
            setStatus('done');
          }
        },
        () => {
          // Background unreachable — nothing to converge on; leave state as-is.
        },
      );
    };
    chrome.runtime.onMessage.addListener(handleSummaryRefreshed);

    return () => {
      clearTimer();
      clearPoll();
      chrome.runtime.onMessage.removeListener(handleSummaryRefreshed);
    };
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
        (res) => {
          if (cycleRef.current !== cycle) return;
          if (res.summary) {
            setSummary(res.summary);
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

  // Fix round, Important #4 — a summary that lands AFTER the
  // SUMMARY_SAFETY_TIMEOUT_MS safety timeout already marked this attempt
  // `failed` is otherwise invisible to the panel: a plain retry click would
  // re-bill a fresh Gemini call and overwrite the good summary that already
  // landed. Check the cache first
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
      (res) => {
        if (cycleRef.current !== cycle) return;
        if (res.summary) {
          setSummary(res.summary);
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
