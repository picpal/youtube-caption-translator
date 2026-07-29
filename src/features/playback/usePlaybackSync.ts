import { useEffect, useRef, useState } from 'react';
import { PLAYBACK_PORT, type PlaybackPanelMessage, type PlaybackTick } from '~/types/message';

/** How often a dead stream retries connecting while the hook stays enabled. */
const RECONNECT_RETRY_MS = 3000;

export interface UsePlaybackSyncParams {
  videoId: string | null;
  tabId: number | null;
  /** Connect only while the transcript list is actually shown (spec §3.2). */
  enabled: boolean;
}

export interface UsePlaybackSyncResult {
  /** Latest streamed playback position, or null before the first tick. */
  currentTime: number | null;
  paused: boolean | null;
  /** Seeks the video. Lazily reconnects first if the stream port is dead. */
  seek: (seconds: number) => void;
}

/**
 * Panel side of the playback port (spec §3.2) — the deliberate direct
 * panel<->content-script connection (see PLAYBACK_PORT's doc comment for why
 * this one stream does NOT go through the background SW). Mirrors
 * useTranslation's lifecycle discipline: reset + reconnect per
 * [videoId, tabId, enabled] change, lazy reconnect on a dead port (here via
 * both a retry interval and seek()'s reconnect-before-send), cleanup on
 * unmount. The content script owns the staleness gate (it self-disconnects
 * on a video-id mismatch), so this hook only manages connection liveness.
 */
export function usePlaybackSync({ videoId, tabId, enabled }: UsePlaybackSyncParams): UsePlaybackSyncResult {
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const deadRef = useRef(true);
  const connectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setCurrentTime(null);
    setPaused(null);
    portRef.current = null;
    deadRef.current = true;
    connectRef.current = null;

    if (!enabled || videoId === null || tabId === null) return;

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      try {
        const port = chrome.tabs.connect(tabId, { name: PLAYBACK_PORT });
        portRef.current = port;
        deadRef.current = false;
        port.onMessage.addListener((msg: PlaybackTick) => {
          if (cancelled) return;
          setCurrentTime(msg.t);
          setPaused(msg.paused);
        });
        port.onDisconnect.addListener(() => {
          // Only the CURRENT port may flip the dead flag — a stale port's
          // disconnect must not kill a newer connection (same guard shape as
          // useTranslation's generation checks).
          if (portRef.current === port) {
            portRef.current = null;
            deadRef.current = true;
          }
        });
        const init: PlaybackPanelMessage = { type: 'init', videoId };
        port.postMessage(init);
      } catch {
        // No receiving end (orphaned/absent CS) — stay dead; the retry
        // interval below keeps trying while the hook is enabled.
        portRef.current = null;
        deadRef.current = true;
      }
    };
    connectRef.current = connect;

    connect();
    const retry = setInterval(() => {
      if (deadRef.current) connect();
    }, RECONNECT_RETRY_MS);

    return () => {
      cancelled = true;
      clearInterval(retry);
      connectRef.current = null;
      portRef.current?.disconnect();
      portRef.current = null;
      deadRef.current = true;
    };
  }, [videoId, tabId, enabled]);

  function seek(seconds: number): void {
    if (deadRef.current) connectRef.current?.();
    const msg: PlaybackPanelMessage = { type: 'seek', seconds };
    try {
      portRef.current?.postMessage(msg);
    } catch {
      // Port died between the reconnect attempt and the send — the retry
      // interval will restore the stream; the click is simply dropped.
    }
  }

  return { currentTime, paused, seek };
}
