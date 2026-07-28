import { useEffect, useRef, useState } from 'react';
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
   * resumed, so no Port message will ever arrive for it). Also set to
   * `'failed'` directly by `start()` itself when `START_TRANSLATION` answers
   * `{ ok: false }` (fix round 1, Important #2) — that outcome has no
   * `TranslationRecord` behind it at all, so it cannot come from a
   * `GET_TRANSLATION` refetch the way every other `'failed'` transition
   * does. */
  status: TranslationStatus | 'idle';
  /** Live batch-level progress from the Port stream. `null` until the first
   * progress event for this `videoId` arrives — which, for an auto-resumed
   * or freshly-`start()`ed job, happens almost immediately (the pipeline
   * emits its first `onProgress` before doing any async work). Does NOT
   * carry `videoId`/`status` — see `status` above for the latter. */
  progress: TranslationProgressState | null;
  /** The persisted `TranslationRecord` (segments + glossary + status), from
   * `GET_TRANSLATION`. Loaded once on mount/`videoId` change, then
   * re-fetched whenever a progress event reports a TERMINAL status
   * (`done`/`failed`), and (fix round 1, Critical #1) an extra two times
   * around a user-initiated `start()`: once right before it sends
   * `START_TRANSLATION` (only if the Port needed reconnecting — see
   * `reconnectPortIfNeeded` below), and once more if the safety window
   * elapses with no live Port message at all, so the panel converges on
   * persisted truth even if the progress stream itself never arrives. A
   * record that is still in-progress may therefore show a `segments` array
   * with some `translatedText: null` entries even while `progress` reports
   * further along; consumers wanting live translated text should wait for
   * `status === 'done'`. */
  record: TranslationRecord | null;
  /** Kicks off (or safely re-attaches to) the pipeline for the current
   * `videoId`/`tabId` via `START_TRANSLATION`. A no-op if either is `null`.
   * Background's in-flight job registry (entrypoints/background.ts) dedups
   * this against an already-running job, so calling it when one is already
   * in flight for this video is harmless. */
  start: () => void;
  /** The most recently observed failure reason. Usually `record.error?.reason`
   * after a terminal `failed` refetch, but (fix round 1, Important #2) can
   * also be `START_TRANSLATION`'s own `{ ok: false }` response's `error`
   * string when the pipeline couldn't even be started (e.g. no API key) —
   * that case has no backing `TranslationRecord`. Only meaningful while
   * `status === 'failed'` — a later successful retry does not proactively
   * clear this field, it is simply superseded once `status` moves on. */
  error: string | null;
  /** Task R7 (Fix 2A) — real-user test found a click on 시작/재시도 for a
   * video with no transcript panel produced NO visible change at all: the
   * pipeline fails in well under a second, so by the time this hook's next
   * render happens `status` has already gone `failed -> failed` (or
   * `idle -> failed`), which LOOKS identical to the click having done
   * nothing. `pending` is `true` from the moment a USER-INITIATED `start()`
   * call fires (never the `shouldResume` auto-resume path below — that one
   * calls `sendMessage` directly, bypassing `start()`) until the first of:
   * (a) a live Port message for this job, (b) `START_TRANSLATION` settling
   * (either the send itself rejecting, or it resolving `{ ok: false }` —
   * fix round 1, Important #2), or (c) a ~5s safety timeout — so a dead
   * background can never leave this stuck `true` forever. It also never
   * resolves any EARLIER than `PENDING_MIN_VISIBLE_MS` after the click, so
   * the "요청 중…" affordance is always visible long enough to register as
   * feedback even when the real outcome arrives almost instantly. Reset to
   * `false` whenever `videoId`/`tabId` changes, same as every other field
   * here. */
  pending: boolean;
}

/** Task R7 (Fix 2A) — how much longer (ms, never negative) a pending cycle
 * that began `elapsedMs` ago must still wait before it's allowed to resolve,
 * so it never visually flashes for less than `minVisibleMs` even when the
 * real signal (a Port message, or a `start()` rejection) arrives almost
 * immediately. Pure and separately unit-tested — see
 * `useTranslation.test.ts` — because it is the one piece of the pending
 * lifecycle below that doesn't need a timer/chrome mock to verify.
 */
export function pendingResolveDelayMs(elapsedMs: number, minVisibleMs: number): number {
  return Math.max(0, minVisibleMs - elapsedMs);
}

/** Minimum time `pending` stays visibly `true` once a user click starts a
 * cycle (brief 2A: "최소 ~600ms"). */
export const PENDING_MIN_VISIBLE_MS = 600;

/** Hard upper bound on `pending`, independent of whether either real signal
 * ever arrives (brief 2A path (c): a dead background service worker means no
 * Port message and no settled `START_TRANSLATION` response — this is the one
 * leg of the race that fires unconditionally). Fix round 1 (Critical #1):
 * reaching this timeout is also what triggers the convergence-fallback
 * record re-pull — see `start()`'s own comment on it. */
export const PENDING_SAFETY_TIMEOUT_MS = 5_000;

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

/**
 * Task R7 fix round 1 (Critical #1) — the subset of the per-`[videoId,
 * tabId]` effect's internals that `start()` needs to reach into. `start()`
 * is declared outside that effect (re-created every render, like this
 * codebase's other hooks — see its own comment below), so it cannot close
 * over the effect's local `port`/`sawLiveStatus`/`recordRequestSeq`
 * variables directly; this ref is the bridge. `null` whenever there is no
 * active session (videoId/tabId not yet resolved, or between one session's
 * cleanup and the next's setup — both momentary, `start()` cannot actually
 * be invoked during either since it requires a user click on a button the
 * panel only enables once a session exists).
 */
interface TranslationSession {
  /** Reconnects the Port if (and only if) `onDisconnect` has already fired
   * for it — never eagerly; see the effect's own comment on `attachPort` for
   * why an eager reconnect would be actively harmful. Returns whether a
   * reconnect actually happened, so `start()` knows whether a record re-pull
   * is warranted alongside it. */
  reconnectPortIfNeeded: () => boolean;
  /** Re-pulls `GET_TRANSLATION`, applied through the same seq-guarded,
   * `sawLiveStatus`-aware path the initial load and terminal-status refetch
   * already use (`applyRecordResponse` below) — never a bespoke one-off. */
  refetchRecord: () => void;
}

export function useTranslation({ videoId, tabId }: UseTranslationParams): UseTranslationResult {
  const [status, setStatus] = useState<TranslationStatus | 'idle'>('idle');
  const [progress, setProgress] = useState<TranslationProgressState | null>(null);
  const [record, setRecord] = useState<TranslationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const sessionRef = useRef<TranslationSession | null>(null);

  // Task R7 (Fix 2A) — plumbing for the `pending` lifecycle. Refs, not
  // state: nothing here needs its OWN render, only `pending` itself does.
  // `pendingGenerationRef` is bumped on every new cycle (a fresh `start()`
  // call, or the videoId/tabId reset below) so a stale timer/rejection from
  // an EARLIER cycle can never resolve (or re-arm) a NEWER one — the same
  // "is this response still the most recent" discipline `recordRequestSeq`
  // already uses for `GET_TRANSLATION` below, just for this separate concern.
  const pendingGenerationRef = useRef(0);
  const pendingActivatedAtRef = useRef<number | null>(null);
  const pendingMinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearPendingTimers(): void {
    if (pendingMinTimerRef.current !== null) {
      clearTimeout(pendingMinTimerRef.current);
      pendingMinTimerRef.current = null;
    }
    if (pendingSafetyTimerRef.current !== null) {
      clearTimeout(pendingSafetyTimerRef.current);
      pendingSafetyTimerRef.current = null;
    }
  }

  // Ends the pending cycle identified by `generation` — a no-op if a newer
  // cycle (another `start()`, or a videoId/tabId reset) has already
  // superseded it, so a straggling timer/rejection callback can never clear
  // (or re-show) the WRONG cycle's pending state.
  function resolvePending(generation: number): void {
    if (pendingGenerationRef.current !== generation) return;
    clearPendingTimers();
    pendingActivatedAtRef.current = null;
    setPending(false);
  }

  // Called from whichever of the two REAL signals (a Port message, or
  // `start()`'s own rejection) happens first — schedules the actual
  // `resolvePending` no sooner than `PENDING_MIN_VISIBLE_MS` after the cycle
  // began. The independent safety timer (below, in `start()`) races this on
  // its own separate path (c) and is unaffected by whichever of (a)/(b) (if
  // either) also fires.
  function requestPendingResolve(generation: number): void {
    if (pendingGenerationRef.current !== generation || pendingActivatedAtRef.current === null) return;
    const elapsed = Date.now() - pendingActivatedAtRef.current;
    const delay = pendingResolveDelayMs(elapsed, PENDING_MIN_VISIBLE_MS);
    if (pendingMinTimerRef.current !== null) clearTimeout(pendingMinTimerRef.current);
    if (delay <= 0) {
      resolvePending(generation);
    } else {
      pendingMinTimerRef.current = setTimeout(() => resolvePending(generation), delay);
    }
  }

  // Re-created every render, closing over the CURRENT `videoId`/`tabId`
  // props directly — no memoization, matching this codebase's existing
  // hooks (`useCurrentVideo` exposes no functions at all). Fire-and-forget:
  // `START_TRANSLATION` acks "accepted", not "finished"; actual progress
  // arrives over the Port this hook is already subscribed to below.
  //
  // Task R7 (Fix 2A): this is the ONLY path that turns `pending` on — the
  // `shouldResume` auto-resume call inside the effect below calls
  // `sendMessage` directly and deliberately does NOT go through `start()`,
  // per the brief ("자동 재개 경로에는 pending을 켜지 말 것"). It also runs
  // right after the effect connects a fresh Port, so it never needs the
  // reconnect dance below either.
  function start(): void {
    if (videoId === null || tabId === null) return;
    const generation = ++pendingGenerationRef.current;
    clearPendingTimers();
    pendingActivatedAtRef.current = Date.now();
    setPending(true);

    // Fix round 1 (Critical #1) — heal a dead Port BEFORE this click can
    // possibly reach a background instance whose `progressPorts` (background.ts)
    // has no entry for this panel at all. MV3 can silently evict the service
    // worker this hook's Port was connected to; `onDisconnect` (registered on
    // the effect's own Port, below) is the only signal of that, and it fires
    // well before any click — reconnecting only HERE, lazily, is deliberate:
    // an eager reconnect on every disconnect would just keep re-waking the
    // service worker forever, defeating the whole point of idle eviction.
    // Only when a reconnect actually happened is there anything meaningfully
    // stale to re-sync before dispatching a fresh pipeline run.
    if (sessionRef.current?.reconnectPortIfNeeded()) {
      sessionRef.current.refetchRecord();
    }

    // Path (c) / convergence fallback (fix round 1, Critical #1): reaching
    // this callback at all means neither a live Port message (a) nor a
    // settled `START_TRANSLATION` response (b, below) resolved pending
    // earlier — exactly the "the pipeline ran but its broadcasts went
    // nowhere" scenario the reconnect above is a best-effort mitigation for,
    // not a guarantee (nothing prevents the reconnected Port's registration
    // on the background side from losing a race with the pipeline's very
    // first broadcast). One more re-pull here converges the panel on
    // whatever IS persisted regardless, and `resolvePending` unconditionally
    // ends the cycle either way so the button is never stuck.
    pendingSafetyTimerRef.current = setTimeout(() => {
      sessionRef.current?.refetchRecord();
      resolvePending(generation);
    }, PENDING_SAFETY_TIMEOUT_MS);

    void sendMessage({ type: 'START_TRANSLATION', payload: { videoId, tabId } })
      .then((res) => {
        if (res.ok) return;
        // Fix round 1 (Important #2) — `START_TRANSLATION`'s `{ ok: false }`
        // response (message.ts documents it as caller-visible: no API key,
        // or background's own catch-all) was previously read by no one,
        // leaving `pending` to run out the full safety window into silence.
        // There is no `TranslationRecord` behind this outcome at all (the
        // pipeline never even started), so it is surfaced directly rather
        // than via a refetch. Generation-guarded so a stale response from a
        // superseded cycle can't clobber a newer one's state.
        if (pendingGenerationRef.current !== generation) return;
        setStatus('failed');
        setError(res.error);
        resolvePending(generation);
      })
      .catch(() => {
        // Path (b): background unreachable (the send itself rejected).
        // Still no retry loop here, matching useCurrentVideo's same choice
        // for the analogous "not woken up yet" case — but pending must still
        // resolve rather than wait out the full safety timeout for something
        // already known to have failed.
        requestPendingResolve(generation);
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
    // Task R7 (Fix 2A): `pending` is a click-scoped UI affordance for THIS
    // video/tab — bump the generation first so any in-flight timer/rejection
    // from the PREVIOUS videoId/tabId can never resolve (or re-arm) this
    // fresh one, then clear it outright.
    pendingGenerationRef.current += 1;
    clearPendingTimers();
    pendingActivatedAtRef.current = null;
    setPending(false);
    sessionRef.current = null;

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
    // pull below, each terminal-triggered `refetchRecord`, and — fix round 1
    // (Critical #1) — the two new `start()`-driven re-pulls) is tagged with
    // an increasing sequence number. A response is only applied if it is
    // still the most RECENTLY ISSUED request by the time it resolves —
    // otherwise a request issued after it exists, and this one lost the
    // race regardless of which response actually arrives first over
    // chrome.runtime messaging (unordered). Without this, the exact same
    // "reopen attaches to an already-running job" scenario above could have
    // a terminal progress event's `refetchRecord()` response arrive first,
    // only for the STILL-IN-FLIGHT initial fetch to land afterward and
    // clobber the fresher, final record with a stale in-progress one.
    let recordRequestSeq = 0;

    const applyRecordResponse = (seq: number, rec: TranslationRecord | null) => {
      if (cancelled || seq !== recordRequestSeq) return;
      setRecord(rec);
      setError(rec?.error?.reason ?? null);
      // Same "only if nothing live has spoken yet" guard the initial pull
      // used to inline here directly — now shared by every refetch call
      // site (terminal-status, and fix round 1's two `start()`-driven ones)
      // so a record re-pull that happens to resolve before any Port message
      // has arrived for this session still gets the panel off `'idle'`.
      if (!sawLiveStatus) setStatus(rec?.status ?? 'idle');
    };

    // Re-pulls the persisted record — used for the initial load, whenever a
    // progress event reports a terminal status, and (fix round 1) around a
    // user-initiated `start()` (see `TranslationSession` above). See the
    // `record` doc comment for why "on terminal event" and not "on every
    // batch".
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
      // Path (a): any live progress message for this job is proof the click
      // (if there was one) was received — resolves the CURRENT pending
      // cycle, if one is active (a no-op otherwise, e.g. an auto-resumed
      // job's own progress stream, which never set `pending` in the first
      // place).
      requestPendingResolve(pendingGenerationRef.current);
      setStatus(message.status);
      setProgress({
        step: message.step,
        phase: message.phase,
        chunkIndex: message.chunkIndex,
        totalChunks: message.totalChunks,
      });
      if (TERMINAL_STATUSES.includes(message.status)) refetchRecord();
    };

    // Fix round 1 (Critical #1) — `port`/`portDisconnected` are plain `let`s,
    // not refs: everything that needs to read/replace them (`attachPort`,
    // `reconnectPortIfNeeded`, and this effect's own cleanup) is itself
    // defined inside this SAME effect invocation, so an ordinary closure
    // over a mutable local already gives every one of them the current value
    // — no extra ref indirection needed for that part. `sessionRef` (outside
    // this effect) is only for bridging into `start()`, which is NOT defined
    // in here.
    let port = chrome.runtime.connect({ name: TRANSLATION_PROGRESS_PORT });
    let portDisconnected = false;

    const attachPort = (p: chrome.runtime.Port) => {
      p.onMessage.addListener(handlePortMessage);
      // MV3 can evict the service worker this Port is connected to at any
      // time — its `progressPorts` (background.ts) is in-memory and dies
      // with it, silently disconnecting every Port it held with no error
      // event on either side beyond this one. Just flag it; reconnecting
      // eagerly here (rather than lazily in `start()`) would mean every
      // idle-eviction gets immediately undone by this listener re-waking the
      // service worker on its own, which defeats the eviction entirely.
      p.onDisconnect.addListener(() => {
        if (p === port) portDisconnected = true;
      });
    };
    attachPort(port);

    const reconnectPortIfNeeded = (): boolean => {
      if (!portDisconnected) return false;
      port = chrome.runtime.connect({ name: TRANSLATION_PROGRESS_PORT });
      portDisconnected = false;
      attachPort(port);
      return true;
    };

    sessionRef.current = { reconnectPortIfNeeded, refetchRecord };

    // Initial pull: whatever was already persisted before this hook mounted
    // (a prior session's finished/failed/in-progress translation).
    const initialSeq = ++recordRequestSeq;
    sendMessage({ type: 'GET_TRANSLATION', payload: { videoId } })
      .then((rec) => {
        if (cancelled) return;
        applyRecordResponse(initialSeq, rec);

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
      sessionRef.current = null;
      port.onMessage.removeListener(handlePortMessage);
      port.disconnect();
      // A genuine unmount (as opposed to a videoId/tabId dep change, which
      // re-runs the reset block above instead) has no further effect
      // invocation to clear these in — do it here too so a dangling timer
      // never fires against a destroyed hook instance.
      clearPendingTimers();
    };
  }, [videoId, tabId]);

  return { status, progress, record, start, error, pending };
}
