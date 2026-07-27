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
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number;
  captionAvailability: CaptionAvailability;
  // ISO 8601 timestamp of when this metadata was extracted/cached.
  fetchedAt: string;
}
