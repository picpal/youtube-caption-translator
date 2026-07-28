import { useEffect, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import { TRANSLATION_PROGRESS_PORT } from '~/types/message';
import type { TranslatePhase, TranslationProgress, TranslationRecord, TranslationStatus } from '~/types/transcript';

// M2 Task 7 — the panel-side hook that drives/resumes a video's translation
// job. Mirrors `useCurrentVideo`'s discipline (useEffect + `sendMessage`
// pull + subscribe + cleanup on unmount/dep change), but the subscription
// here is a long-lived `chrome.runtime.connect` Port instead of
// `chrome.runtime.onMessage` — this is the first use of a Port in this
// project, because unlike `CURRENT_VIDEO_UPDATED` (one broadcast per event,
// fine as a fire-and-forget `sendMessage`), translation progress is a
// STREAM tied to a single job's lifetime, and a Port is also what keeps the
// background service worker alive for the duration of that stream (see
// entrypoints/background.ts's onConnect handler for the other end).

export interface UseTranslationParams {
  videoId: string | null;
  tabId: number | null;
}

/** The subset of `TranslationProgress` this hook re-exposes as `progress` —
 * `videoId`/`status` are consumed internally (filtering, and folded into the
 * top-level `status` below) rather than repeated here. */
export interface TranslationProgressState {
  step: 1 | 2 | 3 | 4;
  /** Only set while `step === 3` and a specific chunk request is actively
   * in flight — see `TranslationProgress.phase`'s own doc comment. */
  phase?: TranslatePhase;
  chunkIndex: number;
  totalChunks: number;
}

export interface UseTranslationResult {
  /** `'idle'` until either a persisted record or a live progress event has
   * been observed for this `videoId` — otherwise the record's/progress's own
   * `TranslationStatus`. Sourced from the live Port stream once any message
   * has arrived (most current), falling back to the last-loaded record's
   * `status` before that (e.g. a `done`/`failed` video that is not being
   * resumed, so no Port message will ever arrive for it). */
  status: TranslationStatus | 'idle';
  /** Live batch-level progress from the Port stream. `null` until the first
   * progress event for this `videoId` arrives — which, for an auto-resumed
   * or freshly-`start()`ed job, happens almost immediately (the pipeline
   * emits its first `onProgress` before doing any async work). Does NOT
   * carry `videoId`/`status` — see `status` above for the latter. */
  progress: TranslationProgressState | null;
  /** The persisted `TranslationRecord` (segments + glossary + status), from
   * `GET_TRANSLATION`. Loaded once on mount/`videoId` change, then
   * re-fetched only when a progress event reports a TERMINAL status
   * (`done`/`failed`) — the Port stream itself never carries segments, only
   * counts, so this is the one point the full, final record is worth
   * re-pulling. A record that is still in-progress may therefore show a
   * `segments` array with some `translatedText: null` entries even while
   * `progress` reports further along; consumers wanting live translated
   * text should wait for `status === 'done'`. */
  record: TranslationRecord | null;
  /** Kicks off (or safely re-attaches to) the pipeline for the current
   * `videoId`/`tabId` via `START_TRANSLATION`. A no-op if either is `null`.
   * Background's in-flight job registry (entrypoints/background.ts) dedups
   * this against an already-running job, so calling it when one is already
   * in flight for this video is harmless. */
  start: () => void;
  /** The most recently observed failure reason, from `record.error?.reason`
   * after a terminal `failed` refetch. Only meaningful while
   * `status === 'failed'` — a later successful retry does not proactively
   * clear this field, it is simply superseded once `status` moves on. */
  error: string | null;
}

/**
 * Pure decision: does a previously-persisted record represent a job that is
 * still in progress and therefore safe (and worth) auto-resuming on panel
 * open? Only `'analyzing'`/`'translating'` qualify:
 * - `null` (no record at all) — nothing to resume.
 * - `'done'` — already finished, nothing left to do.
 * - `'failed'` — a TERMINAL outcome; M2 has no auto-retry, the user
 *   re-triggers via `start()` if they want another attempt.
 * - `'idle'`/`'extracting'` — never actually persisted by the pipeline
 *   (`pipeline.ts` writes its first skeleton with `status: 'analyzing'`),
 *   but the type permits them; treated as "nothing known to resume" rather
 *   than guessed at.
 *
 * Extracted standalone (not inlined in the effect below) so it is
 * unit-testable without any chrome.* mock — see useTranslation.test.ts.
 */
export function shouldResume(record: TranslationRecord | null): boolean {
  if (record === null) return false;
  return record.status === 'analyzing' || record.status === 'translating';
}

const TERMINAL_STATUSES: readonly TranslationStatus[] = ['done', 'failed'];

export function useTranslation({ videoId, tabId }: UseTranslationParams): UseTranslationResult {
  const [status, setStatus] = useState<TranslationStatus | 'idle'>('idle');
  const [progress, setProgress] = useState<TranslationProgressState | null>(null);
  const [record, setRecord] = useState<TranslationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-created every render, closing over the CURRENT `videoId`/`tabId`
  // props directly — no memoization, matching this codebase's existing
  // hooks (`useCurrentVideo` exposes no functions at all). Fire-and-forget:
  // `START_TRANSLATION` acks "accepted", not "finished"; actual progress
  // arrives over the Port this hook is already subscribed to below.
  function start(): void {
    if (videoId === null || tabId === null) return;
    void sendMessage({ type: 'START_TRANSLATION', payload: { videoId, tabId } }).catch(() => {
      // Background unreachable — nothing further to do; there is no retry
      // loop here, matching useCurrentVideo's same choice for the
      // analogous "not woken up yet" case.
    });
  }

  useEffect(() => {
    // Reset immediately so a previous video's progress/record never lingers
    // on screen while the new video's state loads (mirrors useCurrentVideo's
    // per-tab reset discipline).
    setStatus('idle');
    setProgress(null);
    setRecord(null);
    setError(null);

    if (videoId === null || tabId === null) return;

    let cancelled = false;
    // Fix round 1: once a live Port message has been observed for this job,
    // the initial GET_TRANSLATION fetch below — which can still be in
    // flight, e.g. this panel opened while a job was ALREADY RUNNING and
    // the background's first progress broadcast reaches the freshly
    // connected port before that fetch's own round trip completes — must
    // not overwrite `status` with its now-stale snapshot. Once true, only
    // Port messages drive `status`; this is what the `status` doc comment
    // above promises ("Sourced from the live Port stream once any message
    // has arrived") and the pre-fix code did not actually enforce.
    let sawLiveStatus = false;
    // Fix round 1: every GET_TRANSLATION issued for `record` (the initial
    // pull below, and each terminal-triggered `refetchRecord`) is tagged
    // with an increasing sequence number. A response is only applied if it
    // is still the most RECENTLY ISSUED request by the time it resolves —
    // otherwise a request issued after it exists, and this one lost the
    // race regardless of which response actually arrives first over
    // chrome.runtime messaging (unordered). Without this, the exact same
    // "reopen attaches to an already-running job" scenario above could have
    // a terminal progress event's `refetchRecord()` response arrive first,
    // only for the STILL-IN-FLIGHT initial fetch to land afterward and
    // clobber the fresher, final record with a stale in-progress one.
    let recordRequestSeq = 0;

    const port = chrome.runtime.connect({ name: TRANSLATION_PROGRESS_PORT });

    const applyRecordResponse = (seq: number, rec: TranslationRecord | null) => {
      if (cancelled || seq !== recordRequestSeq) return;
      setRecord(rec);
      setError(rec?.error?.reason ?? null);
    };

    // Re-pulls the persisted record — used both for the initial load and,
    // below, whenever a progress event reports a terminal status. See the
    // `record` doc comment above for why "on terminal event" and not "on
    // every batch".
    const refetchRecord = () => {
      const seq = ++recordRequestSeq;
      sendMessage({ type: 'GET_TRANSLATION', payload: { videoId } })
        .then((rec) => applyRecordResponse(seq, rec))
        .catch(() => {
          // Background unreachable — leave whatever record state is already
          // held; the next reconnect/message will refresh it.
        });
    };

    const handlePortMessage = (message: TranslationProgress) => {
      if (cancelled) return;
      if (message.videoId !== videoId) return;
      sawLiveStatus = true;
      setStatus(message.status);
      setProgress({
        step: message.step,
        phase: message.phase,
        chunkIndex: message.chunkIndex,
        totalChunks: message.totalChunks,
      });
      if (TERMINAL_STATUSES.includes(message.status)) refetchRecord();
    };
    port.onMessage.addListener(handlePortMessage);

    // Initial pull: whatever was already persisted before this hook mounted
    // (a prior session's finished/failed/in-progress translation).
    const initialSeq = ++recordRequestSeq;
    sendMessage({ type: 'GET_TRANSLATION', payload: { videoId } })
      .then((rec) => {
        if (cancelled) return;
        applyRecordResponse(initialSeq, rec);
        if (!sawLiveStatus) setStatus(rec?.status ?? 'idle');

        // Auto-resume (DoD #4): background's in-flight job registry dedups
        // this against a job that is either already running (this panel
        // merely re-attaches, via the Port connected above, to its next
        // progress event) or was evicted mid-run (this restarts it, and the
        // pipeline's own resume-from-persisted-batches logic, Task 6, picks
        // up from the last completed batch) — never a duplicate
        // translation. Decided from THIS response regardless of whether it
        // won the `applyRecordResponse` race above — a superseded snapshot
        // is still the right basis for "was this video in progress when
        // the panel opened".
        if (shouldResume(rec)) {
          void sendMessage({ type: 'START_TRANSLATION', payload: { videoId, tabId } }).catch(() => {});
        }
      })
      .catch(() => {
        // Background unreachable — nothing to resume until this hook's own
        // effect re-runs (e.g. a videoId change); no retry loop by design,
        // same choice as useCurrentVideo makes for the analogous case.
      });

    return () => {
      cancelled = true;
      port.onMessage.removeListener(handlePortMessage);
      port.disconnect();
    };
  }, [videoId, tabId]);

  return { status, progress, record, start, error };
}
