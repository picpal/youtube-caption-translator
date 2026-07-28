import { defineContentScript } from 'wxt/sandbox';
import { classifyYoutubeUrl, parseVideoId } from '~/lib/youtube';
import {
  extractVideoMeta,
  isDurationAdBlocked,
  type ExtractedVideoMeta,
} from '~/lib/video-meta';
import { dedupeRows } from '~/lib/transcript-parse';
import { sendMessage } from '~/lib/messaging';
import type {
  ReemitVideoMessage,
  RequestTranscriptMessage,
  RequestTranscriptResponse,
  RawTranscriptRow,
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
 */
function findShowTranscriptButton(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, tp-yt-paper-button, yt-button-shape button',
  );
  for (const el of Array.from(candidates)) {
    const label = el.getAttribute('aria-label') ?? el.textContent ?? '';
    if (/transcript|스크립트|대본/i.test(label)) return el;
  }
  return null;
}

/**
 * Triggers the panel open. Prefers a real click on the chip button (§1's
 * recommended method); falls back to forcing the searchable-transcript
 * engagement panel's `visibility` attribute directly when no button is found
 * (§1: this also works to open the panel on a fresh load).
 */
function triggerShowTranscript(): void {
  const button = findShowTranscriptButton();
  if (button) {
    button.click();
    return;
  }
  document
    .querySelector(TRANSCRIPT_ENGAGEMENT_PANEL)
    ?.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
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
 * is true or the schedule is exhausted.
 */
async function waitForTranscriptRows(): Promise<boolean> {
  let elapsed = 0;
  for (const checkpoint of TRANSCRIPT_OPEN_POLL_MS) {
    await sleep(checkpoint - elapsed);
    elapsed = checkpoint;
    if (transcriptRowsPopulated()) return true;
  }
  return false;
}

/**
 * Opens the transcript panel and waits for it to populate.
 *
 * Resolves `false` when the video has no transcript panel at all (§5), or
 * when the open was triggered but rows never populated within
 * `TRANSCRIPT_OPEN_POLL_MS` (the unresolved SPA-reopen case, §6b) —
 * `handleRequestTranscript` below maps either outcome to
 * `{ unavailable: true }`.
 *
 * Deliberately does NOT scroll: §4a measured all rows already present in the
 * DOM the moment the panel finishes expanding (stable across a 5s no-scroll
 * window and an explicit scroll-to-bottom), so a scroll-and-wait loop would
 * do nothing useful.
 */
export async function openTranscriptPanel(): Promise<boolean> {
  if (!transcriptPanelPresent()) return false;

  triggerShowTranscript();
  return waitForTranscriptRows();
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
 * "no transcript" rather than retried indefinitely.
 */
async function handleRequestTranscript(expectedVideoId: string): Promise<RequestTranscriptResponse> {
  const opened = await openTranscriptPanel();
  if (!opened) return { unavailable: true };

  if (currentVideoId() !== expectedVideoId) {
    const reopened = await openTranscriptPanel();
    if (!reopened || currentVideoId() !== expectedVideoId) return { unavailable: true };
  }

  const rows = scrapeRows();
  return rows.length > 0 ? rows : { unavailable: true };
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
  },
});
