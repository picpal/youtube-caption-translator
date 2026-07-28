import { useEffect, useState } from 'react';
import { classifyYoutubeUrl, type YoutubePageKind } from '~/lib/youtube';
import type { ExtractedVideoMeta } from '~/lib/video-meta';
import { sendMessage } from '~/lib/messaging';
import type { AppMessage, CurrentVideoState } from '~/types/message';

export interface UseCurrentVideoResult {
  /**
   * The active tab's video record, or `null` when there is none to show —
   * either no report has arrived yet, or the tab confirmed it is not a
   * video page. A `provisional` report's `meta` is exposed here too (not
   * withheld until `settled`): Tasks 6-7 measured title/channel/captions
   * arriving before duration does (e.g. a pre-roll ad withholds only
   * `durationSeconds`), and there is no reason to hide the fields that are
   * already correct just because one field is still pending. See `loading`
   * for how to tell the two states apart.
   */
  video: ExtractedVideoMeta | null;
  /** The active tab's page kind, from its URL alone (see `classifyYoutubeUrl`). */
  kind: YoutubePageKind;
  /**
   * True until a report for the active tab has reached a status other than
   * `'provisional'`. Note this is deliberately NOT "true until `video` is
   * non-null": a `provisional` report can already carry a `video`, and
   * `loading` stays true anyway because the record is known to still be
   * improving (most concretely: `durationSeconds: null` behind a pre-roll
   * ad). Consumers that want a spinner alongside the partial data should
   * check `loading`; consumers that just want whatever is currently known
   * should read `video` regardless of `loading`.
   */
  loading: boolean;
  /**
   * The active tab's id, or `null` before the tab-identity effect's first
   * `chrome.tabs.query` has resolved. Exposed (M2 Task 8) so callers that
   * need to identify "this tab" for a chrome API of their own (e.g.
   * `useTranslation`'s `START_TRANSLATION`, which runs content-script code
   * in a specific tab) don't have to duplicate this hook's own
   * `chrome.tabs.query({ active: true, currentWindow: true })` detection —
   * this was already being tracked internally, just not returned before.
   */
  tabId: number | null;
}

/**
 * Live view of "what video (if any) is the active tab currently on",
 * sourced from the background service worker's per-tab cache — never by
 * polling `chrome.tabs` for video data, only for identifying which tab is
 * active (see the two effects below for why both are needed and why they
 * don't race each other).
 */
export function useCurrentVideo(): UseCurrentVideoResult {
  const [tabId, setTabId] = useState<number | null>(null);
  const [kind, setKind] = useState<YoutubePageKind>('other');
  const [tabResolved, setTabResolved] = useState(false);
  const [state, setState] = useState<CurrentVideoState | null>(null);

  // Tracks which tab is active and its page kind, from the URL alone — the
  // same source entrypoints/sidepanel/App.tsx's M0 logic already reads
  // (chrome.tabs.query + onActivated/onUpdated). This is what makes a
  // non-YouTube tab resolve to "not a video page" immediately and without
  // waiting on any message: there is no content script on such a tab and
  // never will be, so nothing would ever push a report for it. `kind` is
  // derived here, independently of the second effect below, precisely so it
  // does not depend on a push that will never arrive.
  useEffect(() => {
    let cancelled = false;

    const resolveTab = () => {
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (cancelled) return;
        setTabId(tab?.id ?? null);
        setKind(classifyYoutubeUrl(tab?.url));
        setTabResolved(true);
      });
    };

    resolveTab();

    const handleActivated = () => resolveTab();
    // onUpdated fires for every tab; only react to the active one, and only
    // once per navigation (its `url` change), not on every loading/complete
    // event a single navigation produces.
    const handleUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (!tab.active || changeInfo.url === undefined) return;
      resolveTab();
    };

    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, []);

  // Once the active tab id is known, pull its current state (covers a video
  // detected before this hook mounted, or before the panel was open at all)
  // and subscribe to the background's push for further updates. Re-runs
  // whenever the active tab changes, and is the SOLE source of `video`/the
  // "provisional vs settled" half of `loading` — this is the push side; the
  // effect above is the tab-identity side, and the two do not fight over the
  // same field (that effect never touches `state`).
  useEffect(() => {
    if (tabId === null) {
      setState(null);
      return;
    }

    let cancelled = false;
    // Clear the previous tab's data immediately rather than leaving it on
    // screen while the new tab's state loads.
    setState(null);

    // Ask the content script to push its current report again. This is what
    // recovers a freshly-opened panel from an evicted service worker: the
    // background's `latestByTab` map (entrypoints/background.ts) is
    // in-memory only and does not survive an MV3 idle eviction, and nothing
    // else re-triggers the content script's settle loop. Fire-and-forget and
    // harmless to send unconditionally (not gated on `kind`): a non-video
    // YouTube tab's content script answers `settled`/`meta: null` via its own
    // `isVideoPage` gate, and a non-YouTube tab has no content script to
    // reach at all — background already swallows that "no receiving end"
    // case (see its `REQUEST_VIDEO_REEMIT` handler), so nothing here needs to
    // special-case it either. One send per `tabId` change, not a loop.
    void sendMessage({ type: 'REQUEST_VIDEO_REEMIT', payload: { tabId } }).catch(() => {
      // Background unreachable — same "nothing to do" outcome as below.
    });

    sendMessage({ type: 'GET_CURRENT_VIDEO', payload: { tabId } })
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch(() => {
        // Background unreachable (e.g. not woken up yet) — treated the same
        // as "no report yet", which is already the initial state.
      });

    const handleMessage = (msg: AppMessage) => {
      if (msg.type !== 'CURRENT_VIDEO_UPDATED') return;
      if (msg.payload.tabId !== tabId) return;
      setState(msg.payload.video);
    };
    chrome.runtime.onMessage.addListener(handleMessage);

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, [tabId]);

  const loading = !tabResolved || (kind !== 'other' && (state === null || state.status === 'provisional'));

  return {
    video: state?.meta ?? null,
    kind,
    loading,
    tabId,
  };
}
