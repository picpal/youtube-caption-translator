import { defineContentScript } from 'wxt/sandbox';
import { classifyYoutubeUrl, parseVideoId } from '~/lib/youtube';
import {
  extractVideoMeta,
  isDurationAdBlocked,
  type ExtractedVideoMeta,
} from '~/lib/video-meta';
import { dedupeRows } from '~/lib/transcript-parse';
import { chooseTranscriptButton } from '~/lib/transcript-panel';
import { sendMessage } from '~/lib/messaging';
import { shouldEmitTick } from '~/lib/playback-sync';
import {
  PLAYBACK_PORT,
  type ReemitVideoMessage,
  type RequestTranscriptMessage,
  type RequestTranscriptResponse,
  type RawTranscriptRow,
  type PlaybackPanelMessage,
  type PlaybackTick,
} from '~/types/message';

// ISOLATED world (the default — no `world` option needed), and Task 4's ruling
// stands, but not for the reason it gave. Task 4 assumed MAIN world would be
// required to distinguish manual captions from auto-generated ones, since
// `ytInitialPlayerResponse` is a page-context global. Task 6 measured that the
// ISOLATED world can recover the same object on a full load by reading the
// inline <script> element's TEXT — script text is ordinary DOM content — so
// all four CaptionAvailability values are reachable from here. See
// `resolveCaptionAvailability` in src/lib/video-meta.ts and task-6-report.md.

/**
 * How confident the content script is that a report will not be improved by
 * waiting longer.
 *
 * - `'provisional'` — readable now, but the document was still changing. A
 *   better report for the SAME navigation is still coming. Safe to display,
 *   never safe to cache.
 * - `'settled'`     — two consecutive reads produced an identical record and
 *   that record carries a caption verdict. Final for this navigation.
 * - `'unsettled'`   — the settle schedule ran out while the document was still
 *   changing (or still unreadable). Best effort; treat like `'provisional'`
 *   except that nothing further is coming.
 *
 * "Final for this navigation" is the exact promise — a LATER navigation event
 * can still supersede a settled report for the same video. That happens
 * routinely on a full load: the script-load cycle can settle before `#owner`
 * hydrates (`channelName: null`), and the `yt-page-data-updated` cycle that
 * follows then settles again with the channel filled in. Consumers should
 * always take the most recent report rather than latching the first settled
 * one.
 */
type ReportStatus = 'provisional' | 'settled' | 'unsettled';

/**
 * What Task 8 will forward and Task 9 will render. Deliberately a plain value
 * with no subscription machinery: one function produces it, one function
 * consumes it.
 *
 * `meta: null` means either "this page is not a video page" (paired with
 * `'settled'` — there is genuinely nothing to show) or "nothing readable yet"
 * (paired with `'provisional'`).
 */
interface VideoMetaReport {
  status: ReportStatus;
  meta: ExtractedVideoMeta | null;
  /** What started the settle cycle this report belongs to. */
  trigger: string;
  /** Index into `SETTLE_SCHEDULE_MS` that produced it — for logs only. */
  attempt: number;
}

/**
 * Milliseconds after the trigger at which the document is re-read.
 *
 * Task 6 made extraction refuse to answer rather than lie: while the previous
 * video's description panel is still mounted next to the new one, the
 * containers disagree and `captionAvailability` comes back `null`, meaning
 * "ask again later". A single read at `yt-page-data-updated` therefore has to
 * be expected to fail, and the only correct response is to re-read.
 *
 * The schedule is measured, not guessed. Sampling the container/transcript
 * shape on EVERY animation frame across in-page transitions (scratchpad
 * `t7a-settle.log`, `t7c-openq.log`, `t7d-identity.log`) the stale panel was
 * torn down at:
 *
 *     +94ms, +132ms, +149ms, +150ms, +158ms   (5 transitions with a transient)
 *     +0ms                                    (4 transitions with none at all)
 *
 * so the 100ms and 250ms reads cover the common case.
 *
 * The tail is not padding. Task 6 measured an outlier
 * (`r3-container-agreement.log`) still ambiguous at +2500ms, and Task 7
 * reproduced it against the real extension (`t7g-verify-trap.log`, arriving at
 * the caption-free `8TDcGYmEgyM` from a captioned document): the read at
 * +4000ms still refused and the read at +7000ms was the first to answer. A
 * four-second horizon would have given up on a video the loop can answer
 * correctly, so the 6000/8000/11000/15000 reads are load bearing and the band
 * where the outlier lives is deliberately the densest part of the tail.
 *
 * The bound itself is the point of the array. 15s is a little over twice the
 * worst transient ever measured, and nothing in any sample across
 * `t7a`/`t7c`/`t7d`/`t7e`/`t7f`/`t7g` changed after it. Past that, an
 * unbounded retry loop on a tab left open for an hour is a battery and CPU
 * cost with no measured payoff — every read re-parses the inline player
 * response, which is 34KB-671KB of JSON.
 *
 * Eleven reads is the worst case, not the normal one: the loop stops the
 * moment two consecutive reads agree, which on every measured transition
 * except the outlier was the second read.
 */
const SETTLE_SCHEDULE_MS = [0, 100, 250, 500, 1000, 2000, 4000, 6000, 8000, 11000, 15000];

/** Page kinds that can carry a video record at all. */
function isVideoPage(url: string): boolean {
  const kind = classifyYoutubeUrl(url);
  return kind === 'watch' || kind === 'shorts' || kind === 'live';
}

// ---------------------------------------------------------------------------
// M2 Task 4 — transcript-panel scraper. Everything below reads the rendered
// transcript engagement panel (docs/youtube-transcript-findings.md), never
// `timedtext` (dead on this build — see that doc's opening paragraph). All
// selectors/signals are the MEASURED ones from that document, cited inline.

// §5: locale-independent panel-absent signal. Either one present means the
// video has a transcript engagement panel at all; both absent means it does
// not (measured together, all four signals, on a no-caption fixture).
const TRANSCRIPT_ENGAGEMENT_PANEL =
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
const TRANSCRIPT_SECTION_SIGNAL = 'ytd-video-description-transcript-section-renderer';

// §2: row selectors, measured stable across ASR and manual tracks.
const TRANSCRIPT_ROW = 'ytd-transcript-segment-renderer';
const TRANSCRIPT_TIMESTAMP = '.segment-timestamp';
const TRANSCRIPT_TEXT = '.segment-text';

/**
 * Milliseconds after the open-trigger at which `openTranscriptPanel` re-checks
 * for populated rows.
 *
 * A first, fresh panel open was measured settling within 2-3s (§1/§4c) — the
 * early checkpoints cover that. The long tail exists for the SPA-reopen case,
 * which §6b found genuinely unresolved: one clean run left the panel stuck on
 * YouTube's own `ghost-cards` placeholder for 8+ seconds across several
 * retrigger strategies, and the doc's own recommendation is "poll with a
 * longer timeout ... before giving up" rather than assuming a 2-3s open
 * always works post-navigation. 30s total is that longer timeout; nothing in
 * §6b's measurements suggested a specific bound past "more than 8s", so this
 * is a defensive budget, not a measured one.
 */
const TRANSCRIPT_OPEN_POLL_MS = [300, 800, 1500, 2500, 4000, 6000, 9000, 13000, 18000, 24000, 30000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** §5: whether the current video has a transcript engagement panel at all. */
function transcriptPanelPresent(): boolean {
  return (
    document.querySelector(TRANSCRIPT_ENGAGEMENT_PANEL) !== null ||
    document.querySelector(TRANSCRIPT_SECTION_SIGNAL) !== null
  );
}

/**
 * The Show-transcript chip button, found the same way §1 measured it: any
 * button-like element whose `aria-label` or text matches "transcript" in
 * English, Korean, or the Korean synonym "대본" — `aria-label` values are
 * locale-dependent (§1, and the M1 doc's locale trap), so this can only ever
 * be a best-effort match, not an exhaustive one.
 *
 * The regex-only match used to return here directly (whichever matching
 * element came first in document order). The live field bug this fixes
 * (task-brief.md, 2026-07-29) measured that first match being, on a real
 * captioned video, the panel's OWN "닫기" (close) chip or a Show-transcript
 * chip already left `aria-selected="true"` by a prior SPA navigation —
 * clicking either does the wrong thing (closes an open panel, or no-ops a
 * toggle-off). This is now just the DOM adapter: it computes each match's
 * visibility (`getBoundingClientRect`) and `aria-selected` state and hands
 * them to the pure, unit-tested `chooseTranscriptButton`
 * (src/lib/transcript-panel.ts), which owns the actual exclusion/ranking
 * logic.
 */
function findShowTranscriptButton(): HTMLElement | null {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>('button, tp-yt-paper-button, yt-button-shape button'),
  ).filter((el) => /transcript|스크립트|대본/i.test(el.getAttribute('aria-label') ?? el.textContent ?? ''));

  const candidates = elements.map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label') ?? el.textContent ?? '',
      visible: rect.width > 0 && rect.height > 0,
      ariaSelected: el.getAttribute('aria-selected') === 'true',
    };
  });

  const chosenIndex = chooseTranscriptButton(candidates);
  return chosenIndex === null ? null : elements[chosenIndex];
}

/**
 * Whether the panel has ACTUALLY populated with rows — checked via a real
 * `ytd-transcript-renderer` containing at least one row, not merely the outer
 * panel's `visibility` attribute. §6b found the attribute can read
 * `EXPANDED` while the panel's content is still YouTube's own `ghost-cards`
 * loading placeholder, so the attribute alone would be a false positive.
 */
function transcriptRowsPopulated(): boolean {
  const renderer = document.querySelector('ytd-transcript-renderer');
  return renderer !== null && renderer.querySelector(TRANSCRIPT_ROW) !== null;
}

/**
 * Polls, on `TRANSCRIPT_OPEN_POLL_MS`'s schedule, until `transcriptRowsPopulated`
 * is true or the schedule is exhausted. `onCheckpoint`, if given, fires after
 * each miss (schedule elapsed-ms as its argument) — `openTranscriptPanel`
 * below uses it to escalate to the next ladder strategy from INSIDE this same
 * poll walk, so escalating never adds extra wall-clock time on top of the
 * existing budget.
 */
async function waitForTranscriptRows(onCheckpoint?: (elapsedMs: number) => void): Promise<boolean> {
  let elapsed = 0;
  for (const checkpoint of TRANSCRIPT_OPEN_POLL_MS) {
    await sleep(checkpoint - elapsed);
    elapsed = checkpoint;
    if (transcriptRowsPopulated()) return true;
    onCheckpoint?.(elapsed);
  }
  return false;
}

/**
 * Checkpoint (ms, one of `TRANSCRIPT_OPEN_POLL_MS`'s own entries) at/after
 * which the ladder below falls through to the button-click strategy if the
 * visibility-force strategy hasn't populated rows yet. Not itself a
 * measurement — chosen from the schedule's own front portion to give the
 * force-EXPANDED attempt a few checks (brief: "~5초 내 2-3회 체크") before
 * trying the next strategy, same spirit as `MERGE_TARGET_CHARS` in
 * transcript-parse.ts (a reasoned default, not a measured constant).
 */
const STRATEGY_3_ESCALATE_AT_MS = 2500;

/**
 * Opens the transcript panel and waits for it to populate, via a strategy
 * ladder (task-brief.md, 2026-07-29 fix round) rather than a single
 * click-and-poll — the live field bug this fixes is exactly a single click
 * landing on the wrong element (see `findShowTranscriptButton`'s doc
 * comment) with nothing else tried before the 30s budget ran out:
 *
 * 1. Already populated -> succeed immediately. Deliberately does NOT click
 *    or toggle anything in this case — an already-open panel must never be
 *    re-clicked (that is precisely how a stale `aria-selected="true"` chip
 *    or the panel's own close button can undo an already-successful open).
 * 2. Force the engagement panel's `visibility` attribute to
 *    `ENGAGEMENT_PANEL_VISIBILITY_EXPANDED` directly — locale-independent,
 *    and promoted to run FIRST (ahead of any click) because this fix's own
 *    live diagnosis measured it populating a stuck, SPA-nav-leftover panel
 *    in ~1s on exactly the state the button click no-op'd on.
 * 3. If rows still haven't populated by `STRATEGY_3_ESCALATE_AT_MS`, click
 *    the best candidate button via the hardened `findShowTranscriptButton`.
 * 4. Whatever budget remains: keep polling `TRANSCRIPT_OPEN_POLL_MS` to its
 *    end, same as before this fix (the unresolved SPA-reopen case, §6b).
 *
 * All of this runs inside the SAME `TRANSCRIPT_OPEN_POLL_MS` schedule/30s
 * budget as before — steps 3/4 are escalations reached via
 * `waitForTranscriptRows`'s `onCheckpoint` callback, not additional waits
 * stacked on top, so the total budget is unchanged (task-brief.md's own
 * constraint: "전체 예산은 기존 30초 유지 — 늘리지 말 것").
 *
 * Resolves `'no-panel'` when the video has no transcript panel at all (§5,
 * checked before any strategy runs), `'open-failed'` when a panel/signal
 * exists but every strategy above was exhausted without rows ever
 * populating, or `'opened'` on success. `handleRequestTranscript` below maps
 * `'no-panel'`/`'open-failed'` to `{ unavailable: true, reason }`.
 *
 * Deliberately does NOT scroll: §4a measured all rows already present in the
 * DOM the moment the panel finishes expanding (stable across a 5s no-scroll
 * window and an explicit scroll-to-bottom), so a scroll-and-wait loop would
 * do nothing useful.
 */
export type TranscriptOpenResult = 'opened' | 'no-panel' | 'open-failed';

export async function openTranscriptPanel(): Promise<TranscriptOpenResult> {
  if (!transcriptPanelPresent()) return 'no-panel';
  if (transcriptRowsPopulated()) return 'opened'; // strategy 1 — never click/toggle here

  // Strategy 2 — locale-independent, measured fastest+most-reliable trigger,
  // tried before any click.
  document
    .querySelector(TRANSCRIPT_ENGAGEMENT_PANEL)
    ?.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');

  let clickedFallback = false;
  const populated = await waitForTranscriptRows((elapsedMs) => {
    // Strategy 3 — fires exactly once, mid-poll, only if strategy 2 hasn't
    // populated rows by the escalation checkpoint.
    if (!clickedFallback && elapsedMs >= STRATEGY_3_ESCALATE_AT_MS) {
      clickedFallback = true;
      findShowTranscriptButton()?.click();
    }
  });
  // Strategy 4 (tail poll) is `waitForTranscriptRows` itself continuing
  // through the rest of the schedule above — no separate call needed.
  return populated ? 'opened' : 'open-failed';
}

/**
 * Reads every transcript row currently in the DOM and de-dupes the
 * double-mount (§4b: the panel mounts the ENTIRE transcript TWICE, so an
 * unscoped `querySelectorAll` returns every row twice). Reuses the pure,
 * unit-tested `dedupeRows` (src/lib/transcript-parse.ts) rather than
 * re-implementing the same `(tsText, text)` key here.
 *
 * No rolling-overlap dedup is applied (§7 measured 0 word overlap across
 * every consecutive row pair in the panel DOM — that pattern belongs to the
 * raw `timedtext` cue stream this project cannot use, not to this DOM).
 */
export function scrapeRows(): RawTranscriptRow[] {
  const rows = Array.from(document.querySelectorAll(TRANSCRIPT_ROW));
  const raw = rows.map((row) => ({
    tsText: row.querySelector(TRANSCRIPT_TIMESTAMP)?.textContent?.trim() ?? '',
    text: row.querySelector(TRANSCRIPT_TEXT)?.textContent?.trim() ?? '',
  }));
  return dedupeRows(raw);
}

/** `ytd-watch-flexy[video-id]` — the SPA-safe id source (video-meta.ts). */
function currentVideoId(): string | null {
  return document.querySelector('ytd-watch-flexy')?.getAttribute('video-id') ?? null;
}

/**
 * Full open+scrape for a `REQUEST_TRANSCRIPT` message, gated on the scraped
 * rows actually belonging to `expectedVideoId`.
 *
 * The gate matters because of §6a: after an SPA navigation the transcript
 * panel goes HIDDEN while STALE rows from the PREVIOUS video survive
 * underneath it — reading rows without checking video-id agreement first
 * would silently return the wrong video's transcript. On a mismatch this
 * makes ONE further attempt (re-open, re-check) before giving up; §6b found
 * reopening after an SPA transition unreliable in testing, so this is
 * best-effort, not a guarantee, and a second failure is reported the same as
 * "no transcript" rather than retried indefinitely. The retry calls
 * `openTranscriptPanel` again, so it automatically runs the same strategy
 * ladder as the first attempt — no separate wiring needed here.
 */
async function handleRequestTranscript(expectedVideoId: string): Promise<RequestTranscriptResponse> {
  const opened = await openTranscriptPanel();
  if (opened !== 'opened') return { unavailable: true, reason: opened };

  if (currentVideoId() !== expectedVideoId) {
    const reopened = await openTranscriptPanel();
    if (reopened !== 'opened' || currentVideoId() !== expectedVideoId) {
      // A reopen that SUCCEEDS but still doesn't match `expectedVideoId` is
      // reported the same as an open failure ('open-failed') — from the
      // caller's side there is nothing more specific to say than "the right
      // panel never became available."
      return { unavailable: true, reason: reopened === 'opened' ? 'open-failed' : reopened };
    }
  }

  const rows = scrapeRows();
  // Rows were populated a moment ago (openTranscriptPanel's own check) yet
  // scrapeRows found none — an edge case, not a "genuinely no transcript"
  // verdict, but there is no dedicated third reason for it; 'no-panel' keeps
  // this branch's message identical to what it was before this fix round
  // rather than inventing a new one.
  return rows.length > 0 ? rows : { unavailable: true, reason: 'no-panel' };
}

// ---------------------------------------------------------------------------
// Playback sync port (spec §3.1). The panel connects directly (no SW hop —
// see PLAYBACK_PORT's doc comment in types/message.ts) and must send
// { type: 'init', videoId } first; ticks only start after the init gate
// passes. The <video> element survives SPA navigations with new content, so
// every emit re-checks the page's video-id and self-disconnects on mismatch
// (same staleness reasoning as handleRequestTranscript's §6a gate).

function findVideoElement(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('#movie_player video') ??
    document.querySelector<HTMLVideoElement>('video')
  );
}

function attachPlaybackPort(port: chrome.runtime.Port): void {
  let video: HTMLVideoElement | null = null;
  let expectedVideoId: string | null = null;
  let lastEmitAtMs: number | null = null;
  let detach: (() => void) | null = null;

  const cleanup = () => {
    detach?.();
    detach = null;
    video = null;
  };

  // Self-initiated disconnects do NOT fire our own onDisconnect listener —
  // cleanup must run explicitly on this path.
  const bail = () => {
    cleanup();
    port.disconnect();
  };

  const emitTick = (force: boolean) => {
    if (video === null) return;
    const now = Date.now();
    if (!force && !shouldEmitTick(lastEmitAtMs, now)) return;
    if (currentVideoId() !== expectedVideoId) {
      bail();
      return;
    }
    lastEmitAtMs = now;
    const tick: PlaybackTick = { t: video.currentTime, paused: video.paused };
    port.postMessage(tick);
  };

  const handleTimeupdate = () => emitTick(false);
  const handleImmediate = () => emitTick(true);

  port.onMessage.addListener((msg: PlaybackPanelMessage) => {
    if (msg.type === 'init') {
      expectedVideoId = msg.videoId;
      if (currentVideoId() !== msg.videoId) {
        bail();
        return;
      }
      video = findVideoElement();
      if (video === null) {
        bail();
        return;
      }
      const el = video;
      el.addEventListener('timeupdate', handleTimeupdate);
      el.addEventListener('seeked', handleImmediate);
      el.addEventListener('play', handleImmediate);
      el.addEventListener('pause', handleImmediate);
      detach = () => {
        el.removeEventListener('timeupdate', handleTimeupdate);
        el.removeEventListener('seeked', handleImmediate);
        el.removeEventListener('play', handleImmediate);
        el.removeEventListener('pause', handleImmediate);
      };
      // Immediate first tick so the panel highlights without waiting for the
      // next natural timeupdate (which never comes while paused).
      emitTick(true);
      return;
    }
    // msg.type === 'seek' — spec §2: currentTime only, play state untouched.
    if (video !== null && currentVideoId() === expectedVideoId) {
      video.currentTime = msg.seconds;
    }
  });

  port.onDisconnect.addListener(cleanup);
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  main() {
    // Serialised form of the last emitted report, for idempotency. Comparing
    // CONTENT rather than just the video id is what lets a genuine navigation
    // back to a previously-seen video report again (A -> B -> A: when A comes
    // back, the last emitted report describes B, so it differs and is
    // emitted), while still collapsing the duplicate that a full load
    // produces (the script-load cycle and the `yt-page-data-updated` cycle
    // reading the same document).
    let lastEmitted: string | undefined;

    // Cancels the in-flight settle cycle. Bumping the generation is what stops
    // an already-queued callback that `clearTimeout` cannot reach.
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;

    const emit = (report: VideoMetaReport): void => {
      const key = JSON.stringify([report.status, report.meta]);
      if (key === lastEmitted) return;
      lastEmitted = key;

      console.log(
        `[ypa] ${report.status} (${report.trigger}#${report.attempt}) kind:`,
        classifyYoutubeUrl(location.href),
        'captions:',
        // Distinguished on purpose: `null` is a real value meaning "nothing
        // readable yet, ask again", and `??` would hide it behind the
        // no-record case.
        report.meta ? (report.meta.captionAvailability ?? 'null (ask again later)') : '(no meta)',
        'meta:',
        report.meta,
      );

      // Forward to the background service worker. `trigger`/`attempt` are
      // deliberately dropped here — they exist to explain settle-loop
      // behaviour in logs, not to inform the panel — while `status` DOES
      // cross the wire: it is what lets the background tell a
      // still-improving record apart from a final one (see the caching
      // decision in entrypoints/background.ts).
      //
      // Fire-and-forget: nothing here awaits or retries a failed send.
      // Every future `emit()` call carries a fresher (or equally fresh)
      // report than the one before it, so a dropped message is superseded
      // by the next settle-loop tick rather than needing its own retry.
      sendMessage({
        type: 'VIDEO_DETECTED',
        payload: { status: report.status, meta: report.meta },
      }).catch((err) => {
        // Expected when the service worker has not woken up yet, or right
        // after an extension reload orphans this content script ("Extension
        // context invalidated") — never fatal to the settle loop itself.
        console.warn('[ypa] VIDEO_DETECTED send failed', err);
      });
    };

    const startCycle = (trigger: string): void => {
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      pendingTimer = undefined;
      generation += 1;
      const cycle = generation;

      // A feed, a search-results page, a channel page. Note this gate is load
      // bearing rather than cosmetic: an in-page navigation to
      // `/results?search_query=...` leaves the previous video's entire watch
      // DOM mounted (measured in `t7a-settle.log` leg 4 — `ytd-watch-flexy`
      // still carried the old video id 5s in), so extraction would happily
      // return the previous video's record for a page that shows no video.
      if (!isVideoPage(location.href)) {
        emit({ status: 'settled', meta: null, trigger, attempt: 0 });
        return;
      }

      // Pins the cycle to one video. If the URL moves on without the event
      // firing, this abandons the cycle rather than settling on a document
      // that has already left.
      const cycleVideoId = parseVideoId(location.href);
      let previous: string | undefined;

      const read = (index: number): void => {
        if (cycle !== generation) return;
        if (!isVideoPage(location.href) || parseVideoId(location.href) !== cycleVideoId) {
          startCycle('url-changed');
          return;
        }

        const meta = extractVideoMeta(document, location.href);
        const serialised = JSON.stringify(meta);

        // A record with no caption verdict is not settled, by definition:
        // `null` means the document refused to answer and asked to be asked
        // again. `'unknown'` is the opposite — a real verdict, terminal for
        // this document — so it must NOT be retried, or every post-SPA
        // captioned video would spin through the whole schedule.
        const captionReadable = meta !== null && meta.captionAvailability !== null;
        // The same "ask again later" idea for duration, but only for the ONE
        // null that a wait can fix: a pre-roll ad poisoning the player clock on
        // the SPA path. Measured live (`t7j-before.log`): read #0 caught the
        // real 1519s, read #1 with the ad up read `null`, read #2 matched it,
        // and the loop settled `durationSeconds: null` at +250ms — stamped
        // `settled`, i.e. cacheable — while the real length was seconds away.
        // `isDurationAdBlocked` reuses the pure function's own ad/live
        // predicates so it cannot drift, and it excludes live: a live stream's
        // `null` is permanent, and retrying it would spin the whole schedule
        // every navigation. See `isDurationAdBlocked` in src/lib/video-meta.ts.
        const durationPending =
          meta !== null && meta.durationSeconds === null && isDurationAdBlocked(document);
        // Title/channel/captions are ad-independent, so they still go out as
        // `provisional` on the very first read (below); `durationPending` only
        // withholds the `settled` STATUS, it never withholds the record.
        const readable = captionReadable && !durationPending;
        // Stability, not just readability. The caption refusal covers the
        // description-panel transient, but nothing covers the other measured
        // ones: `channelName` is `null` until `#owner` hydrates, and Task 5
        // recorded a player clock reading "0:46" ~2.5s into a transition on a
        // 7:57 video with `adShowing` uncaptured. Requiring two consecutive
        // identical reads is one general guard instead of a special case per
        // field, and costs one extra read.
        const settled = readable && serialised === previous;
        previous = serialised;

        const isLastRead = index === SETTLE_SCHEDULE_MS.length - 1;
        if (settled) {
          emit({ status: 'settled', meta, trigger, attempt: index });
          return;
        }
        emit({
          status: isLastRead ? 'unsettled' : 'provisional',
          meta,
          trigger,
          attempt: index,
        });
        if (isLastRead) return;

        pendingTimer = setTimeout(
          () => read(index + 1),
          SETTLE_SCHEDULE_MS[index + 1] - SETTLE_SCHEDULE_MS[index],
        );
      };

      read(0);
    };

    // A settle cycle rather than a single read, because the content script can
    // lose the race with `yt-page-data-updated`: measured in `t7a-settle.log`,
    // that event fires on a full load BEFORE `document.readyState` reaches
    // `'complete'`, and a listener installed at that point never saw it. When
    // the listener below does miss the event, this cycle is the only thing
    // that reports the page at all.
    startCycle('load');

    // The one trigger. Task 1 measured `yt-page-data-updated` as the earliest
    // point at which `ytd-watch-flexy[video-id]` and `document.title` already
    // hold the NEW video's values, on a full load and on an in-page
    // navigation alike; `t7a-settle.log` re-confirmed the flexy id was already
    // fresh in the handler on every leg.
    //
    // Two alternatives were measured and rejected rather than left untried:
    //
    // - `yt-navigate-finish` fires 50-95ms EARLIER (19010/19075, 36320/36415,
    //   62055/62127, 78972/79022 in `t7a-settle.log`) and `popstate` on a
    //   `history.back()` fired a full 887ms earlier — but at those moments the
    //   URL has already changed while the DOM still describes the previous
    //   video, so a read there would pair the new id with the old title. The
    //   stability rule would not catch it either: the document is *stably*
    //   wrong for hundreds of milliseconds.
    // - A `MutationObserver` backstop is not here on purpose.
    //   `yt-page-data-updated` fired on all 31 in-page navigations measured
    //   across `t7a`/`t7b`/`t7c`/`t7d` (5 + 9 + 13 + 4) — rail clicks,
    //   `history.back()`, `history.forward()`, search-results routes, and
    //   cross-channel hops — so a backstop would be covering a failure never
    //   observed. It also cannot be cheap: Task 1
    //   found `attributeFilter: ['video-id']` may never fire because
    //   `ytd-watch-flexy` is replaced rather than mutated, which forces a
    //   `childList` + `subtree` observer over a page that mutates constantly.
    //   The `url-changed` check inside the cycle is the cheap half of that
    //   safety net and is kept.
    document.addEventListener('yt-page-data-updated', () => startCycle('yt-page-data-updated'));

    // Answers `REQUEST_VIDEO_REEMIT` (panel -> background -> here, see
    // entrypoints/background.ts). Needed because this script otherwise only
    // ever emits on its own triggers (load, `yt-page-data-updated`) — there is
    // no other way for a freshly-opened panel to recover the current video
    // after the service worker's in-memory cache has been evicted. Reuses
    // `startCycle` rather than re-emitting `lastEmitted` directly so the
    // response goes through the exact same read/settle/cache path as any
    // other trigger — an evicted worker also lost whatever it had cached, so
    // a fresh settle (not just a repeat of the last emission) is what is
    // actually needed here.
    //
    // No response is sent back: the result arrives through the normal
    // VIDEO_DETECTED broadcast this triggers, same as every other trigger.
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      if ((msg as Partial<ReemitVideoMessage>)?.type === 'REEMIT_VIDEO') {
        startCycle('reemit');
      }
      return false;
    });

    // Answers `REQUEST_TRANSCRIPT` (bg -> content, Task 4/6). A SEPARATE
    // listener from the `REEMIT_VIDEO` one above rather than folded into it:
    // that one is fire-and-forget and always returns `false` (sync, no
    // response); this one is async and must return `true` to keep the
    // message channel open until `handleRequestTranscript` resolves. Mixing
    // the two into one listener would force every `REEMIT_VIDEO` delivery to
    // also return `true`, leaking an open channel that never gets a response.
    chrome.runtime.onMessage.addListener(
      (msg: unknown, _sender, sendResponse: (response: RequestTranscriptResponse) => void) => {
        const request = msg as Partial<RequestTranscriptMessage>;
        if (request?.type !== 'REQUEST_TRANSCRIPT') return false;

        handleRequestTranscript(request.videoId ?? '')
          .then(sendResponse)
          .catch((err) => {
            console.warn('[ypa] REQUEST_TRANSCRIPT failed', err);
            sendResponse({ unavailable: true });
          });
        return true; // keep the channel open for the async response
      },
    );

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === PLAYBACK_PORT) attachPlaybackPort(port);
    });
  },
});
