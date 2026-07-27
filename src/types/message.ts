import type { ExtractedVideoMeta } from '~/lib/video-meta';

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
  | { type: 'CURRENT_VIDEO_UPDATED'; payload: { tabId: number; video: CurrentVideoState } };

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
};

export type AppResponse<T extends AppMessage['type']> = AppResponseMap[T];
