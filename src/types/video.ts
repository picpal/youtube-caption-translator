// Whether the video has captions, and if so, which kind.
//
// The manual-vs-auto distinction is real and measurable (see
// docs/youtube-dom-findings.md, "Caption availability"): a manual track has
// no `kind` property and a `vssId` starting with ".", an auto-generated
// track has `kind === "asr"` and a `vssId` starting with "a.".
//
// That data lives in `ytInitialPlayerResponse.captions`, which is a
// MAIN-world global — but an ISOLATED-world content script can still recover
// it on a FULL DOCUMENT LOAD by reading the inline `<script>` element's text
// and parsing it, because script text is ordinary DOM content. So on a full
// load all three positive values are reachable from ISOLATED.
//
// After an in-page (SPA) navigation that script is never replaced, so it is
// stale and must be rejected. What remains is the DOM, which can only say
// has/hasn't — hence 'unknown'. (An earlier version of this comment claimed
// the split needed MAIN world outright; Task 6 measured otherwise.)
//
// - 'available' — at least one human-authored (non-`asr`) track is present.
// - 'auto-only' — tracks are present and every one is `kind: "asr"`.
// - 'none'      — the video has no captions. Either a player response proved
//                 to describe THIS video had no `captions` key (the measured
//                 shape: absent entirely, not an empty object or array) or an
//                 empty `captionTracks`, or the description subtree is
//                 mounted and carries no transcript section.
// - 'unknown'   — captions exist, but the kind is unrecoverable. This is the
//                 post-SPA case: the DOM says has/hasn't and nothing more.
//                 Terminal for that document — no further DOM reading
//                 recovers the kind, only a full load will.
export type CaptionAvailability = 'unknown' | 'available' | 'auto-only' | 'none';

export interface VideoMeta {
  videoId: string;
  url: string;
  title: string;
  // `null` when the channel could not be resolved (e.g. a Shorts page, or a
  // watch page read before `#owner` hydrated — the content script genuinely
  // observes this on its first pass). Deliberately not `''`: once records are
  // cached, an empty string is indistinguishable from a genuinely blank
  // channel and the record would never be re-read.
  channelName: string | null;
  thumbnailUrl: string;
  // `null` when the duration genuinely could not be determined. Task 5
  // measured that no source is simultaneously ISOLATED-reachable, correct
  // after an in-page (SPA) navigation, and immune to a pre-roll ad — when the
  // staleness sentinel says the microdata is stale AND an ad is poisoning the
  // player clock, there is no honest value. `0` is not an acceptable stand-in:
  // it renders as "0:00", which is a confident lie rather than an absence.
  // See `resolveDurationSeconds` in src/lib/video-meta.ts.
  durationSeconds: number | null;
  // `null` when NOTHING about captions could be read: no player response
  // describing this video AND no mounted description subtree. Measured cases:
  // a watch page read before hydration, a Short reached by an in-page
  // navigation, and the window during an in-page navigation where the
  // previous video's description panel is still mounted next to the new one
  // (the panels disagree, so the document is ambiguous and nothing is
  // claimed). Callers must read this as "ask again later", NEVER as a
  // negative — `'none'` is the negative.
  //
  // Deliberately distinct from `'unknown'`, which is a real answer: captions
  // exist and the kind is unrecoverable for this document. `'unknown'` is
  // terminal and cacheable; `null` means re-read on the next event. Same
  // convention as `channelName` and `durationSeconds` above.
  captionAvailability: CaptionAvailability | null;
  // ISO 8601 timestamp of when this metadata was extracted/cached.
  fetchedAt: string;
}

/**
 * Why the panel is showing `UnsupportedBanner` instead of a video card, for
 * a tab that is otherwise eligible (API key present).
 *
 * - `'shorts'`      — out of scope by design (PRD §7.1), not a failure. The
 *   tool is for talks/lectures; reliably detected from the URL alone via
 *   `classifyYoutubeUrl` (`/shorts/<id>`).
 * - `'live'`        — out of scope by design (PRD §7.1), not a failure.
 *   Reliably detected from the URL alone ONLY for the unambiguous
 *   `/live/<id>` and `/@handle/live` shapes. A live stream opened on a plain
 *   `/watch?v=` URL classifies as `'watch'` instead (Task 1 measured no
 *   URL-level difference from a VOD there) — that case is NOT routed to this
 *   reason; it falls through to the ready video card with a null duration.
 * - `'restricted'`  — a genuine failure (age/region-restricted video).
 *   Defined here to document intent for M2, but deliberately UNPOPULATED in
 *   M1: no ISOLATED-world signal for restriction has been measured (Task 1
 *   did not characterize this case), so nothing in this milestone sets this
 *   reason. May offer a retry once implemented.
 * - `'no-metadata'` — a genuine failure: a watch-page tab where the
 *   extraction pipeline settled (see `CurrentVideoState.status`) and still
 *   produced no video record. May offer a retry.
 */
export type UnsupportedReason = 'shorts' | 'live' | 'restricted' | 'no-metadata';
