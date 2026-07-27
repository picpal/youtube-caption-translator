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
 * unparseable, and also for a zero duration — YouTube reports `"PT0S"`-ish
 * values for live streams, and rendering that as `0:00` would be a lie.
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
 * Duration in seconds, or `null` when it genuinely cannot be determined.
 *
 * No single measured source is simultaneously reachable from an ISOLATED
 * content script, correct after an SPA transition, AND immune to a pre-roll ad:
 *
 * - `meta[itemprop="duration"]` is ad-immune but goes stale after an in-page
 *   navigation (it keeps describing the previous video).
 * - `.ytp-time-duration` stays fresh across navigations but reports the AD's
 *   length while one is playing (measured: `"0:59"` on a video whose real
 *   duration was `PT12M58S`).
 *
 * So instead of picking one and hoping, staleness is *detected*. The same
 * server-rendered `div#watch7-content` microdata block that carries the
 * duration also carries `meta[itemprop="identifier"]` — the video id it was
 * rendered for. Comparing that against the id resolved from the SPA-safe chain
 * says whether the block describes the current video:
 *
 * - identifier === videoId  -> the block is fresh, use the ad-immune ISO value.
 * - identifier !== videoId  -> the block is stale, fall back to the clock, but
 *   only when no ad is playing.
 * - neither usable          -> return null. A fabricated `0` would render as
 *   "0:00" in the panel, which is a confident lie; absent is honest.
 *
 * Measured on Chrome 150 across two independent cross-channel SPA transitions
 * (zjkBMFhNj_g -> qYNweeDHiyU and zjkBMFhNj_g -> RQWpF2Gb-gU): the sentinel
 * correctly reported "stale" in both, while the id matched on every full load.
 */
function resolveDurationSeconds(doc: Document, videoId: string): number | null {
  const microdataId = attr(doc, 'meta[itemprop="identifier"]', 'content');
  if (microdataId === videoId) {
    const fromMicrodata = parseIsoDuration(attr(doc, 'meta[itemprop="duration"]', 'content'));
    if (fromMicrodata !== null) return fromMicrodata;
  }

  if (isAdShowing(doc)) return null;
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
 * Returns `null` when the document yields neither a video id nor a title —
 * a Shorts page, a feed, or a watch page that has not hydrated yet. Partial
 * metadata is preferable to none, so a missing channel yields `''` and a
 * missing duration yields `null` rather than discarding the whole record.
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
    // '' means "not determined", never a guess. The only ISOLATED-reachable,
    // SPA-safe channel source is this anchor; its `/@handle` href is available
    // too, but there is no `UC…` channelId that survives an SPA transition.
    channelName: elementText(doc.querySelector('#owner #channel-name a')) ?? '',
    // Derived from the video id — the only thumbnail source that is both
    // ISOLATED-reachable and SPA-safe. NOTE: that `hqdefault.jpg` always
    // resolves is general knowledge, NOT measured; no HTTP request has ever
    // been issued against it by this project. Consumers should tolerate a 404.
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: resolveDurationSeconds(doc, videoId),
  };
}
