import type { CaptionAvailability, VideoMeta } from '~/types/video';
import { parseVideoId } from '~/lib/youtube';

/**
 * What `extractVideoMeta` can determine from a `Document` alone.
 *
 * `fetchedAt` is stamped by whoever caches the record (Task 8), so it is not
 * produced here.
 */
export type ExtractedVideoMeta = Omit<VideoMeta, 'fetchedAt'>;

const YOUTUBE_TITLE_SUFFIX = ' - YouTube';

/**
 * Collapsed, trimmed `textContent`, or `null` when the element is missing or
 * blank. YouTube's markup indents the real text inside `<yt-formatted-string>`
 * wrappers, so raw `textContent` arrives padded and multi-line.
 */
function elementText(element: Element | null | undefined): string | null {
  const text = element?.textContent?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

function attr(doc: Document, selector: string, name: string): string | null {
  const value = doc.querySelector(selector)?.getAttribute(name)?.trim();
  return value ? value : null;
}

/**
 * Seconds from an ISO-8601 duration such as `"PT59M48S"` (the shape
 * `meta[itemprop="duration"]` carries). Returns `null` for anything
 * unparseable, and also for a zero duration, since rendering `0:00` would be
 * a lie rather than an absence.
 *
 * (An earlier version of this comment claimed YouTube emits `"PT0S"` for live
 * streams. That was inference and it is wrong — on a measured live stream the
 * `duration` meta is absent entirely. The zero guard is kept as ordinary
 * defensiveness, not as live handling.)
 */
export function parseIsoDuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);

  return total > 0 ? Math.round(total) : null;
}

/**
 * Seconds from a player clock string. `.ytp-time-duration` was measured
 * rendering `M:SS` (`"59:47"`), `H:MM:SS`, and — on a live DVR window —
 * `D:HH:MM:SS` (`"137:04:51:37"`).
 *
 * Only the leading field may exceed two digits or 59; every following field is
 * a real clock field and is range-checked, so a malformed string is rejected
 * rather than silently producing a plausible-looking number.
 */
export function parseClockDuration(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const parts = clock.trim().split(':');
  if (parts.length < 2 || parts.length > 4) return null;

  const [leading, ...rest] = parts;
  if (!/^\d{1,5}$/.test(leading)) return null;
  if (!rest.every((part) => /^\d{1,2}$/.test(part))) return null;

  // Units for the fields as they appear, e.g. D:HH:MM:SS -> [86400,3600,60,1].
  // The matching upper bounds range-check every field except the leading one,
  // which is unbounded (a 137-day DVR window, a 90-minute "137:04" clock).
  const ALL_UNITS = [86400, 3600, 60, 1];
  const ALL_LIMITS = [Infinity, 23, 59, 59];
  const offset = ALL_UNITS.length - parts.length;
  const units = ALL_UNITS.slice(offset);
  const limits = ALL_LIMITS.slice(offset);

  let total = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const value = Number(parts[i]);
    if (i > 0 && value > limits[i]) return null;
    total += value * units[i];
  }
  return total > 0 ? total : null;
}

/**
 * Video id, using only sources measured to survive an in-page (SPA)
 * navigation, in the order of the chain in docs/youtube-dom-findings.md.
 *
 * `link[rel="canonical"]` is last on purpose: Task 5 measured it going STALE
 * after an SPA transition (it still pointed at the previous video), which
 * contradicts Task 1's table. It is kept only as a last resort for the
 * `/live/<id>` and `/@handle/live` URL shapes, where it is the documented way
 * to recover a `/watch?v=` form and where the page was a full load anyway.
 */
function resolveVideoId(doc: Document, url: string): string | null {
  const fromUrl = parseVideoId(url);
  if (fromUrl) return fromUrl;

  const fromFlexy = attr(doc, 'ytd-watch-flexy', 'video-id');
  if (fromFlexy) return fromFlexy;

  return parseVideoId(attr(doc, 'link[rel="canonical"]', 'href') ?? undefined);
}

/**
 * Title from the live DOM, falling back to `document.title`.
 *
 * Deliberately never reads `og:title`, `meta[name="title"]`,
 * `meta[itemprop="name"]` or JSON-LD: all four were measured still holding the
 * PREVIOUS video's title after an in-page navigation, and this function cannot
 * tell a post-SPA document from a freshly loaded one.
 *
 * Note `#title` is not unique on a watch page (17 elements carried that id in
 * the measured document, the first being a comments-panel header). `#title h1`
 * is what disambiguates — only the `ytd-watch-metadata` host has an `h1`.
 */
function resolveTitle(doc: Document): string | null {
  const fromDom = elementText(doc.querySelector('#title h1'));
  if (fromDom) return fromDom;

  const docTitle = doc.title?.replace(/\s+/g, ' ').trim();
  if (docTitle?.endsWith(YOUTUBE_TITLE_SUFFIX)) {
    const stripped = docTitle.slice(0, -YOUTUBE_TITLE_SUFFIX.length).trim();
    if (stripped) return stripped;
  }
  // A bare "YouTube" is the pre-hydration document title, not a video title.
  return null;
}

/** True while a pre-roll/mid-roll ad is playing, which poisons the clock. */
function isAdShowing(doc: Document): boolean {
  return doc.querySelector('#movie_player')?.classList.contains('ad-showing') ?? false;
}

/**
 * True when the player is showing a live broadcast, for which no duration is
 * meaningful — both `.ytp-time-duration` and `video.duration` report the DVR
 * window instead (measured: `"1:00:00"` / 3600 on a stream that had been
 * running far longer, and `"137:04:51:37"` on another).
 *
 * `.ytp-time-display` gains the class `ytp-live`; measured present on a live
 * full load, absent on a VOD, and — unlike Task 1's `.ytp-live-badge`
 * visibility candidate — this is a plain class check, so it needs no
 * `getComputedStyle` and stays pure over the `Document`.
 *
 * Measured to clear correctly across a live -> VOD in-page navigation, which
 * is the direction that matters: a stale `ytp-live` would suppress a
 * legitimate VOD duration. The VOD -> live direction is untested (no live
 * video appeared in a related rail).
 *
 * Note this reads `false` while a pre-roll ad plays on a live stream — the
 * player drops `ytp-live` for the ad. That case is caught by `isAdShowing`
 * and by the fresh-microdata-without-a-duration check instead.
 */
function isLivePlayback(doc: Document): boolean {
  return doc.querySelector('.ytp-time-display')?.classList.contains('ytp-live') ?? false;
}

/**
 * Duration in seconds, or `null` when it genuinely cannot be determined.
 *
 * No single measured source is simultaneously reachable from an ISOLATED
 * content script, correct after an SPA transition, AND immune to a pre-roll ad:
 *
 * - `meta[itemprop="duration"]` is ad-immune but goes stale after an in-page
 *   navigation (it keeps describing the previous video).
 * - the media element (`video.duration`) and `.ytp-time-duration` stay fresh
 *   across navigations but both report the AD's length while one is playing
 *   (measured: `"0:59"` on a video whose real duration was `PT12M58S`).
 *
 * The media element is preferred over the clock: it was read in every probe
 * and matched ground truth every time (3587.701 / 600.461 / 477.467 /
 * 7543.121 / 12683.321), needs no string parsing, and has no locale or
 * format ambiguity. The clock remains behind it as a text fallback for when
 * the media element has not loaded (`duration` is `NaN` until then).
 *
 * So instead of picking one and hoping, staleness is *detected*. The same
 * server-rendered `div#watch7-content` microdata block that carries the
 * duration also carries `meta[itemprop="identifier"]` — the video id it was
 * rendered for. Comparing that against the id resolved from the SPA-safe chain
 * says whether the block describes the current video:
 *
 * - identifier === videoId  -> the block is fresh, use the ad-immune ISO value.
 * - identifier !== videoId  -> the block is stale, fall back to the live DOM,
 *   but only when neither an ad nor a live broadcast is poisoning it.
 * - neither usable          -> return null. A fabricated `0` would render as
 *   "0:00" in the panel, which is a confident lie; absent is honest.
 *
 * Measured on Chrome 150 across three independent cross-channel SPA
 * transitions: the sentinel correctly reported "stale" in every one, while
 * the id matched on every full load.
 *
 * A fresh block that carries NO duration is itself a signal: every measured
 * VOD and Short had one, and the measured live stream did not. That is why
 * step 1 returns `null` instead of falling through — the fall-through would
 * hand back the DVR window.
 */
function resolveDurationSeconds(doc: Document, videoId: string): number | null {
  const microdataId = attr(doc, 'meta[itemprop="identifier"]', 'content');
  if (microdataId === videoId) {
    // The block describes this video, so its duration (or its absence) is
    // authoritative and ad-immune.
    return parseIsoDuration(attr(doc, 'meta[itemprop="duration"]', 'content'));
  }

  // From here the block is stale or missing, so only live DOM is usable.
  if (isLivePlayback(doc) || isAdShowing(doc)) return null;

  // `video.duration` is NaN before the media loads and — measured on YouTube —
  // a finite DVR length rather than Infinity on a live stream, so guard for
  // finiteness rather than treating Infinity as the live marker.
  const mediaDuration = (doc.querySelector('video') as HTMLVideoElement | null)?.duration;
  if (typeof mediaDuration === 'number' && Number.isFinite(mediaDuration) && mediaDuration > 0) {
    return Math.round(mediaDuration);
  }

  return parseClockDuration(doc.querySelector('.ytp-time-duration')?.textContent);
}

const PLAYER_RESPONSE_ASSIGNMENT = 'var ytInitialPlayerResponse = ';

/**
 * The `{...}` immediately following `startIndex`, found by counting braces
 * while respecting JSON string literals and their escapes.
 *
 * This deliberately replaces the `/var ytInitialPlayerResponse = (\{[\s\S]*?\});/`
 * regex that Task 1 measured. The regex stops at the first `};` in the script,
 * which happens to be the right one today (the six real scripts measured on
 * Chrome 150 ranged 34KB-671KB and contained exactly one `};` each) — but a
 * player response embeds free text (`shortDescription`, caption track names),
 * and the day one of those contains `};` the regex silently truncates and the
 * caption data is lost. Counting braces cannot be fooled that way.
 */
function sliceBalancedObject(text: string, startIndex: number): string | null {
  if (text[startIndex] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  // The object never closed — a truncated or mid-stream script.
  return null;
}

/**
 * `ytInitialPlayerResponse` recovered from the ISOLATED world, or `null`.
 *
 * Task 4 registered a single ISOLATED-world content script on the grounds that
 * the manual-vs-auto caption split needs MAIN world. It does not: on a full
 * document load YouTube server-renders the whole player response into an
 * inline `<script>` in `<body>`, and a script element's *text* is ordinary DOM
 * content. Task 1 verified the parsed result byte-identical in both worlds.
 * Reading it is DOM reading, not code execution — nothing here evaluates the
 * script, and nothing here should ever start.
 *
 * Everything that can go wrong (no script, no assignment, an unterminated
 * object, malformed JSON, a non-object payload) yields `null` so the caller
 * falls back to the DOM rather than taking the whole extraction down with it.
 */
function parseInlinePlayerResponse(doc: Document): Record<string, unknown> | null {
  try {
    for (const script of Array.from(doc.querySelectorAll('script'))) {
      const text = script.textContent;
      if (!text) continue;

      const assignment = text.indexOf(PLAYER_RESPONSE_ASSIGNMENT);
      if (assignment === -1) continue;

      const json = sliceBalancedObject(text, assignment + PLAYER_RESPONSE_ASSIGNMENT.length);
      if (!json) continue;

      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Malformed payload. Absent is honest; a throw here would lose the title,
    // channel and duration too.
  }
  return null;
}

/**
 * The caption verdict a player response supports, given that it has already
 * been confirmed to describe the current video.
 *
 * Measured on Chrome 150 across three videos:
 * - no captions at all -> the `captions` key is ABSENT from the response
 *   entirely, not an empty object and not an empty array. Hence `in` rather
 *   than a reach into `playerCaptionsTracklistRenderer.captionTracks.length`,
 *   which would throw.
 * - a human-authored track has NO `kind` property and a `vssId` beginning
 *   `"."` (`.en`, `.gu`, …).
 * - an auto-generated track has `kind === "asr"` and `vssId` beginning `"a."`.
 *
 * `kind` alone is enough, and is used alone: `t.kind !== 'asr'` is true both
 * for a manual track (`undefined`) and for any future non-asr kind, which is
 * the safe direction — a track YouTube does not label `asr` is not something
 * this code may claim was machine-generated.
 *
 * An empty `captionTracks` array is treated as `'none'`: Task 1 measured
 * exactly that shape on a live stream with no captions.
 */
function captionsFromPlayerResponse(response: Record<string, unknown>): CaptionAvailability {
  if (!('captions' in response)) return 'none';

  const captions = response.captions as
    | { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } }
    | null
    | undefined;
  const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return 'none';

  const hasHumanAuthored = tracks.some(
    (track) => (track as { kind?: unknown } | null)?.kind !== 'asr',
  );
  return hasHumanAuthored ? 'available' : 'auto-only';
}

// Present exactly when the video offers a transcript, i.e. when captions
// exist. Locale-independent, unlike `data-tooltip-title`.
const TRANSCRIPT_SECTION = 'ytd-video-description-transcript-section-renderer';
// The transcript section's own parent. Its presence means the description
// subtree has finished mounting, which is what makes the transcript section's
// ABSENCE meaningful rather than merely early.
const DESCRIPTION_CONTAINER = 'ytd-structured-description-content-renderer';

/**
 * Caption availability from DOM signals alone — everything the ISOLATED world
 * can still say once the inline script is stale or absent, which is the
 * situation after every in-page (SPA) navigation.
 *
 * Chosen signal: the presence of `ytd-video-description-transcript-section-renderer`.
 * It is locale-independent and it was the only candidate that survived
 * measurement on Chrome 150. The rejected ones, with the measurement that
 * rejected each:
 *
 * - `aria-label` on the CC button reads "자막 사용 불가" ("subtitles
 *   unavailable") on all three test videos, including the two that have
 *   captions. It never discriminated at all.
 * - `aria-pressed` follows the user's CC toggle. Clicking the button on the
 *   manual-caption video flipped it `true` -> `false`, and the preference
 *   persisted into a *different* captioned video on a later load, making that
 *   video indistinguishable from the caption-free one. (Task 1 suspected this
 *   but never ran the experiment and left the row open; the experiment now
 *   confirms its suspicion.)
 * - the `disabled` attribute was absent on all three videos — Task 1 had only
 *   ever measured it on one. It does not discriminate either.
 * - `data-tooltip-title` does discriminate once settled, but it is written in
 *   the UI language, and it is also transiently wrong: on the manual-caption
 *   video it read "자막 사용 불가" 947ms after load and "자막(c)" at 1372ms.
 * - `class`, computed `display` and `offsetWidth` were identical regardless.
 *
 * The transcript section is itself lazily rendered, so its absence alone would
 * be a false 'none' during the mount window. `DESCRIPTION_CONTAINER` closes
 * that: sampled at 150ms resolution on all three videos, the container and the
 * transcript section appeared in the SAME sample, so a mounted container with
 * no transcript section inside it is a genuine absence.
 *
 * ## Why the containers are compared instead of queried once
 *
 * During an in-page navigation YouTube mounts the NEW video's description
 * panel before unmounting the PREVIOUS one, so for a while the document
 * describes two videos at once. A single `querySelector` finds whichever comes
 * first in document order, which is the stale one — measured live, that made
 * the content script report captions on a caption-free video.
 *
 * Measured settled shape (4 full loads incl. a Short, plus SPA arrivals):
 * every description container holds exactly 0 or 1 transcript section and they
 * always AGREE — 2 containers / 2 transcript sections on a captioned video,
 * 2 / 0 on a caption-free one, 1 / 0 on a Short. Measured transient shape
 * (captioned -> caption-free, sampled synchronously in a `yt-page-data-updated`
 * handler and still true 2.5s later): 3 containers, the fresh one holding 0 and
 * the two stale ones holding 1 each — they DISAGREE.
 *
 * So disagreement is a measured ambiguity detector, and the honest response to
 * it is to refuse: return `null`, "ask again later". This is not an ownership
 * heuristic — it never guesses which panel is current, only whether the
 * document is self-consistent.
 *
 * Two other candidates were measured and rejected, recorded so nobody
 * re-derives them:
 * - Duplicated `ytd-engagement-panel-section-list-renderer[target-id=
 *   "engagement-panel-structured-description"]`. It does duplicate sometimes,
 *   but sampled at the same instant across 6 consecutive SPA transitions the
 *   count was 1 every time, including transitions the container comparison
 *   correctly flagged. As a detector it is all false negatives.
 * - A raw container COUNT (settled 2, transient 3). It works, but only by
 *   hardcoding the settled count, which any YouTube layout experiment
 *   invalidates silently. The comparison needs no magic number.
 *
 * What this cannot do: tell 'available' from 'auto-only'. That distinction
 * exists nowhere in the DOM, so captions-that-exist collapse to 'unknown'.
 */
function captionsFromDom(doc: Document): CaptionAvailability | null {
  const containers = Array.from(doc.querySelectorAll(DESCRIPTION_CONTAINER));
  // Nothing has mounted (pre-hydration, or a page with no description at all).
  // 'none' would assert an absence that was never observed.
  if (containers.length === 0) return null;

  const withTranscript = containers.filter(
    (container) => container.querySelector(TRANSCRIPT_SECTION) !== null,
  );
  if (withTranscript.length === 0) return 'none';
  if (withTranscript.length === containers.length) return 'unknown';

  // The containers disagree, so at least one belongs to another video.
  return null;
}

/**
 * Caption availability, using the inline player response when it can be proved
 * to describe the current video and DOM signals when it cannot.
 *
 * The sentinel is the same shape as the duration one: the inline script is
 * server-rendered for the initially loaded video and Task 1 measured that it
 * is NEVER replaced on an in-page navigation (after navigating away it still
 * parsed to the previous video's id, and after a transition into Shorts there
 * was no such script at all). So its `videoDetails.videoId` is compared with
 * the id resolved from the SPA-safe chain:
 *
 * - match    -> the script describes this video. Trust it completely,
 *               including the manual/auto split: 'available' | 'auto-only' |
 *               'none'.
 * - mismatch
 *   or absent-> stale. Fall back to the DOM, which can only answer has/hasn't:
 *               'unknown' | 'none' | `null`.
 *
 * `null` is not one of the four verdicts — it means nothing about captions
 * could be read, and the caller should ask again after the next event. See
 * the `captionAvailability` field in src/types/video.ts.
 */
function resolveCaptionAvailability(doc: Document, videoId: string): CaptionAvailability | null {
  const response = parseInlinePlayerResponse(doc);
  const scriptVideoId = (response?.videoDetails as { videoId?: unknown } | undefined)?.videoId;

  if (response && scriptVideoId === videoId) {
    return captionsFromPlayerResponse(response);
  }
  return captionsFromDom(doc);
}

/**
 * Extracts everything about a video that can be read from a `Document`.
 *
 * Pure over `doc` and `url` — it holds no reference to the live page, reads no
 * globals, and so is testable against captured fixture HTML in jsdom. That
 * purity is also why it cannot know whether it is looking at a freshly loaded
 * document or one left over from an in-page navigation, which is exactly why
 * every source it reads has to be SPA-safe (or staleness-checked).
 *
 * A video id and a title are both required — without either, the record could
 * not be keyed or displayed, so the whole thing is discarded and `null` is
 * returned (a feed page, or a watch page that has not hydrated yet). Every
 * other field is optional: a missing channel or duration yields `null` for
 * that field rather than discarding the record.
 *
 * Note this does NOT return `null` for a Shorts page — the id comes from the
 * `/shorts/<id>` URL and the title from `document.title`, producing a usable
 * record whose `url` is the equivalent `/watch?v=` form. That behaviour is
 * deliberate and pinned by test.
 */
export function extractVideoMeta(doc: Document, url: string): ExtractedVideoMeta | null {
  const videoId = resolveVideoId(doc, url);
  if (!videoId) return null;

  const title = resolveTitle(doc);
  if (!title) return null;

  return {
    videoId,
    // Normalised to the canonical watch URL rather than echoing `url` back:
    // the incoming href carries `&t=`/`&pp=` tracking params, and this record
    // is keyed by video id.
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    // `null` means "not determined", never a guess or an empty string: once
    // Task 8 caches these records, `''` would be indistinguishable from a
    // genuinely blank channel and the record would never be re-read. The only
    // ISOLATED-reachable, SPA-safe channel source is this anchor; its
    // `/@handle` href is available too, but there is no `UC…` channelId that
    // survives an SPA transition.
    channelName: elementText(doc.querySelector('#owner #channel-name a')),
    // Derived from the video id — the only thumbnail source that is both
    // ISOLATED-reachable and SPA-safe. NOTE: that `hqdefault.jpg` always
    // resolves is general knowledge, NOT measured; no HTTP request has ever
    // been issued against it by this project. Consumers should tolerate a 404.
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: resolveDurationSeconds(doc, videoId),
    captionAvailability: resolveCaptionAvailability(doc, videoId),
  };
}
