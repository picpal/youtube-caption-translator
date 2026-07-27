import type { VideoMeta } from '~/types/video';
import { parseVideoId } from '~/lib/youtube';

/**
 * What `extractVideoMeta` can determine from a `Document` alone.
 *
 * `captionAvailability` needs the caption signals (Task 6) and `fetchedAt` is
 * stamped by whoever caches the record (Task 8), so neither is produced here.
 */
export type ExtractedVideoMeta = Omit<VideoMeta, 'captionAvailability' | 'fetchedAt'>;

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
  };
}
