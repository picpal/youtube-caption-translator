// Whether the video has captions, and if so, which kind.
//
// The manual-vs-auto distinction is real and measurable (see
// docs/youtube-dom-findings.md, "Caption availability"): a manual track has
// no `kind` property and a `vssId` starting with ".", an auto-generated
// track has `kind === "asr"` and a `vssId` starting with "a.". But that data
// lives only in `ytInitialPlayerResponse.captions` / `getPlayerResponse()`,
// which are MAIN-world only. An ISOLATED-world content script can determine
// *whether* captions exist but not *which kind* they are without a world
// decision made elsewhere (Task 4/6).
//
// - 'unknown'   — captions are known to exist, but the kind could not be
//                 determined (e.g. extracted from ISOLATED world only).
// - 'available' — manual (human-authored) captions are present.
// - 'auto-only' — only auto-generated (ASR) captions are present.
// - 'none'      — the `captions` key is absent from the player response
//                 entirely; the video has no captions at all.
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
  captionAvailability: CaptionAvailability;
  // ISO 8601 timestamp of when this metadata was extracted/cached.
  fetchedAt: string;
}
