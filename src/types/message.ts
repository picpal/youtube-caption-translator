import type { ExtractedVideoMeta } from '~/lib/video-meta';
import type { TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from './summary';

export type ApiKeyStatus =
  | { present: false }
  | { present: true; maskedKey: string; savedAt: string };

export type GeminiTestResult =
  | { ok: true; latencyMs: number; model: string }
  | { ok: false; reason: 'unauthorized' | 'rate_limit' | 'network' | 'unknown'; message: string };

/**
 * What the content script's settle loop (Tasks 6-7) knows about the current
 * navigation, minus the log-only `trigger`/`attempt` fields — see
 * `entrypoints/content.ts`'s `VideoMetaReport` for the full doc comment on
 * `status`'s three values. This is the one shape shared by the content ->
 * background push (`VIDEO_DETECTED`), the panel's pull (`GET_CURRENT_VIDEO`),
 * and the background -> panel push (`CURRENT_VIDEO_UPDATED`): all three are
 * different views of the same "what does this tab's video look like right
 * now" fact, so they carry the same payload shape rather than three
 * ad-hoc ones.
 */
export interface CurrentVideoState {
  status: 'provisional' | 'settled' | 'unsettled';
  meta: ExtractedVideoMeta | null;
}

export type AppMessage =
  | { type: 'SAVE_API_KEY'; payload: { key: string } }
  | { type: 'GET_API_KEY_STATUS' }
  | { type: 'DELETE_API_KEY' }
  | { type: 'TEST_API_KEY' }
  // content script -> background, on every settle-loop emission.
  | { type: 'VIDEO_DETECTED'; payload: CurrentVideoState }
  // panel -> background, to read the current state of a specific tab
  // (deliberately tab-scoped rather than "the active tab" — the panel
  // already knows which tab it cares about via its own chrome.tabs query,
  // and background has no "tabs" permission to look it up itself).
  | { type: 'GET_CURRENT_VIDEO'; payload: { tabId: number } }
  // background -> panel, broadcast whenever a tab's stored state changes.
  // Included in this union (rather than sent out-of-band) so background's
  // own `handle()` switch — which sees every `chrome.runtime.onMessage`
  // delivery, including this broadcast if it is ever redelivered to the
  // sender — stays exhaustive instead of throwing on an unrecognised type.
  | { type: 'CURRENT_VIDEO_UPDATED'; payload: { tabId: number; video: CurrentVideoState } }
  // panel -> background: "ask the content script on this tab to push its
  // current report again". Exists because `latestByTab` (background.ts) is
  // an in-memory `Map` that an MV3 service-worker eviction wipes clean — a
  // panel opened after eviction would otherwise see `GET_CURRENT_VIDEO`
  // answer `null` forever, since nothing re-triggers the content script's
  // settle loop on its own. Tab-scoped for the same reason `GET_CURRENT_VIDEO`
  // is: background has no "tabs" permission to resolve "the active tab"
  // itself, so the caller (which already knows via its own `chrome.tabs`
  // query) supplies it.
  | { type: 'REQUEST_VIDEO_REEMIT'; payload: { tabId: number } }
  // panel -> background: kick off the M2 extraction+translation pipeline
  // (Tasks 4-7) for a video. `tabId`-scoped for the same reason
  // `GET_CURRENT_VIDEO`/`REQUEST_VIDEO_REEMIT` are: background has no "tabs"
  // permission to resolve a target tab itself, and the pipeline needs one to
  // reach the content script via `REQUEST_TRANSCRIPT` (see below). This is a
  // fire-and-forget kickoff, not a completion signal — actual progress is
  // streamed separately over the `TRANSLATION_PROGRESS_PORT` Port (Task 7);
  // the response here only says whether the pipeline could be started.
  | { type: 'START_TRANSLATION'; payload: { videoId: string; tabId: number } }
  // panel -> background: read the cached translation for a video, e.g. on
  // panel open/revisit, before deciding whether to call `START_TRANSLATION`
  // at all. Mirrors `GET_CURRENT_VIDEO`'s null-means-"nothing cached yet"
  // convention.
  | { type: 'GET_TRANSLATION'; payload: { videoId: string } }
  // panel -> background: read the cached summary for a video (summary spec
  // §3). `null` follows GET_TRANSLATION's convention — nothing cached yet.
  | { type: 'GET_SUMMARY'; payload: { videoId: string } }
  // panel -> background: generate (or regenerate — same-key overwrite) the
  // Korean summary for an already-`done` translation. Resolves once the
  // summary is persisted or generation failed; a lost response (SW evicted)
  // is covered by the panel's safety-timeout GET_SUMMARY refetch (spec §5).
  | { type: 'GENERATE_SUMMARY'; payload: { videoId: string } }
  // background -> panel, broadcast once the 다시 생성 cascade (spec
  // 2026-07-31-regen-cascade §2/§3) finishes REPLACING an already-existing
  // summary for `videoId`. Included in this union (rather than sent
  // out-of-band) for the same reason `CURRENT_VIDEO_UPDATED` is: background's
  // own `handle()` switch sees every `chrome.runtime.onMessage` delivery,
  // including this broadcast if it is ever redelivered to the sender, and
  // must stay exhaustive rather than throw on an unrecognised type.
  // `useSummary` is the one listener — an already-open Summary tab has no
  // other way to learn the cascade replaced its summary (the original
  // design's "tab re-entry re-fetches" premise didn't hold, since
  // `useSummary` loads once per `[videoId, enabled]`, not per tab switch;
  // see the design doc's final-review correction), so it refetches
  // `GET_SUMMARY` on receipt for a matching videoId. No listener (panel
  // closed, or open on a different video) is the common case, not an error.
  | { type: 'SUMMARY_REFRESHED'; payload: { videoId: string } };

export type AppResponseMap = {
  SAVE_API_KEY: { ok: true; status: ApiKeyStatus } | { ok: false; error: string };
  GET_API_KEY_STATUS: ApiKeyStatus;
  DELETE_API_KEY: { ok: true };
  TEST_API_KEY: GeminiTestResult;
  VIDEO_DETECTED: { ok: true };
  // `null` means "no report has been received for this tab yet" — distinct
  // from `{ status: 'settled', meta: null }`, which means "confirmed not a
  // video page". Callers must not conflate the two.
  GET_CURRENT_VIDEO: CurrentVideoState | null;
  CURRENT_VIDEO_UPDATED: { ok: true };
  // Always `{ ok: true }`, even when the tab has no content script to
  // reach (non-YouTube tab, or the tab closed) — that is an expected,
  // silently-swallowed outcome (see the handler in entrypoints/background.ts),
  // not a caller-visible failure.
  REQUEST_VIDEO_REEMIT: { ok: true };
  // Unlike `REQUEST_VIDEO_REEMIT`, an unreachable content script (or any
  // other failure to start) IS caller-visible here: `START_TRANSLATION`
  // means the panel is actively waiting to scrape a transcript, not
  // best-effort re-announcing state nothing depends on, so the panel needs
  // to know if that can't happen at all (e.g. render "no transcript
  // panel"/error rather than spin forever).
  START_TRANSLATION: { ok: true } | { ok: false; error: string };
  // `null` means "no cached translation for this video" — same convention
  // as `GET_CURRENT_VIDEO`'s null. A non-null record may still be mid-
  // pipeline (`status` other than 'done'/'failed'); callers resume progress
  // via the Port rather than polling this.
  GET_TRANSLATION: TranslationRecord | null;
  GET_SUMMARY: VideoSummary | null;
  // `error` is the raw English reason message; the panel maps it to Korean
  // via translationErrorDisplay. A missing key is exactly 'API key not set'.
  GENERATE_SUMMARY: { ok: true; summary: VideoSummary } | { ok: false; error: string };
  SUMMARY_REFRESHED: { ok: true };
};

export type AppResponse<T extends AppMessage['type']> = AppResponseMap[T];

/**
 * background -> content only, delivered via `chrome.tabs.sendMessage`
 * (never `chrome.runtime.sendMessage`, which a service worker cannot use to
 * reach a content script). Deliberately NOT part of `AppMessage`: that union
 * is exactly the shapes `entrypoints/background.ts`'s `handle()` dispatches
 * on, and this message is dispatched TO the content script, not through
 * `handle()`. The content script's own `chrome.runtime.onMessage` listener
 * (entrypoints/content.ts) is the only consumer, and it needs no response —
 * the result comes back through the normal `VIDEO_DETECTED` broadcast.
 */
export interface ReemitVideoMessage {
  type: 'REEMIT_VIDEO';
}

/**
 * One row scraped from the YouTube transcript engagement panel, PRE-parse
 * (the raw `.segment-timestamp` + `.segment-text` pair — see
 * docs/youtube-transcript-findings.md). Deliberately NOT a
 * `TranscriptSegment`: that shape (numeric start/end seconds, sentence-
 * joined text) is produced later, by Task 4's parser (`rowsToSegments`/
 * `reconstructSentences` in src/lib/transcript-parse.ts) running on an array
 * of these. The content-script scraper de-duplicates the panel's
 * double-mounted rows (Task 1 finding) before returning, so every row here
 * is already unique.
 */
export interface RawTranscriptRow {
  tsText: string;
  text: string;
}

/**
 * background -> content only, delivered via `chrome.tabs.sendMessage` (same
 * reasoning as `ReemitVideoMessage` above). Deliberately NOT part of
 * `AppMessage` for the same reason `ReemitVideoMessage` isn't: this is
 * dispatched TO the content script, not through background's `handle()`.
 * Unlike `ReemitVideoMessage`, this one carries a real response instead of a
 * separate broadcast — see `RequestTranscriptResponse` below — because the
 * pipeline (background) needs the scraped rows back synchronously to keep
 * going, not as a fire-and-forget re-announcement.
 */
export interface RequestTranscriptMessage {
  type: 'REQUEST_TRANSCRIPT';
  // The video the caller expects rows for. The content script (Task 4)
  // compares this against `ytd-watch-flexy[video-id]` before trusting any
  // scraped rows — docs/youtube-transcript-findings.md §6a measured that
  // after an SPA navigation the transcript panel goes HIDDEN while STALE rows
  // from the previous video survive underneath it, so a scraper that reads
  // rows without this check would silently return the wrong video's
  // transcript. Background wiring (passing the real videoId when it sends
  // this message) is Task 6; this field just needs to exist for the gate to
  // be implementable now.
  videoId: string;
}

/**
 * Response to `RequestTranscriptMessage`, returned by the content script's
 * `chrome.runtime.onMessage` listener (entrypoints/content.ts, Task 4).
 * `{ unavailable: true }` means the caller could not get scraped rows back —
 * kept distinct from an empty array so "unavailable" is never silently
 * conflated with "panel present but scraped nothing".
 *
 * `reason` (fix round, 2026-07-29 task-brief.md "transcript 열기 로직
 * SPA-상태 견고화") distinguishes WHY, so the pipeline/UI can stop reporting
 * a genuinely-captioned video as "this video has no transcript" (the field
 * bug this fixes — https://www.youtube.com/watch?v=t3YJ5hKiMQ0 has an `en`
 * track and a 550-row panel, but was misreported this way):
 * - `'no-panel'` — §5's locale-independent panel-absent signals were BOTH
 *   absent (`transcriptPanelPresent()` in content.ts) — the video genuinely
 *   has no transcript at all.
 * - `'open-failed'` — the panel/signal exists, but `openTranscriptPanel`'s
 *   strategy ladder (populated-check -> force-EXPANDED -> button click ->
 *   tail poll, all within the existing 30s budget) exhausted without rows
 *   ever populating.
 *
 * `reason` is OPTIONAL, not required, on purpose: it is a refinement added
 * on top of the original shape, and every existing/future caller that only
 * checks `'unavailable' in response` must keep working unchanged whether or
 * not a reason is present.
 */
export type RequestTranscriptResponse =
  | RawTranscriptRow[]
  | { unavailable: true; reason?: 'no-panel' | 'open-failed' };

/**
 * Channel name for the background -> panel translation-progress Port
 * (`chrome.runtime.connect({ name: TRANSLATION_PROGRESS_PORT })`, Task 7).
 * Named constant rather than a string literal at each call site so
 * background and the panel can't drift on it independently. A Port's
 * messages don't flow through background's `handle()` switch (there is no
 * request/response pair, just a stream), so — unlike `AppMessage` — there is
 * no discriminated union to extend here; the payload contract is simply
 * documented: every message sent on this channel is a `TranslationProgress`
 * (src/types/transcript.ts).
 */
export const TRANSLATION_PROGRESS_PORT = 'translation-progress';

/**
 * Playback sync (spec: docs/superpowers/specs/2026-07-29-playback-sync-design.md).
 * The ONE deliberate exception to "panel talks only to background": the panel
 * connects DIRECTLY to the content script via `chrome.tabs.connect(tabId,
 * { name: PLAYBACK_PORT })`, because a periodic playback stream routed
 * through the SW would keep it awake for the whole watch session — the exact
 * cost M2 confined keepalive to pipeline runs to avoid. Pipeline
 * trigger/query messaging stays background-routed, unchanged.
 */
export const PLAYBACK_PORT = 'playback';

/** Panel -> content script, over PLAYBACK_PORT. First message MUST be init. */
export type PlaybackPanelMessage =
  | { type: 'init'; videoId: string }
  | { type: 'seek'; seconds: number };

/** Content script -> panel, over PLAYBACK_PORT: throttled playback ticks. */
export interface PlaybackTick {
  t: number;
  paused: boolean;
}
