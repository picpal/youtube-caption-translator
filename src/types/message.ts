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
  | { type: 'REQUEST_VIDEO_REEMIT'; payload: { tabId: number } };

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
