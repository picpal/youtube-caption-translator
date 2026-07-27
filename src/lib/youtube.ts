function isYoutubeHostname(hostname: string): boolean {
  return /(^|\.)youtube\.com$/.test(hostname);
}

/**
 * The kind of page a YouTube URL points at, determined from the URL alone.
 *
 * Caveat: a live stream served at `/watch?v=<id>` is indistinguishable from a
 * VOD by URL alone (measured in Task 1 — the same live stream rendered at
 * `/watch?v=`, `/live/<id>`, and `/@handle/live`, with no URL-level
 * difference between the `/watch?v=` shape and an ordinary VOD watch page).
 * `classifyYoutubeUrl` therefore only ever returns `'live'` for the
 * unambiguous `/live/<id>` and `/@handle/live` shapes; a live stream on a
 * plain watch URL classifies as `'watch'`. DOM-level live detection (e.g.
 * the `.ytp-live-badge` signal) is out of scope for a URL parser.
 */
export type YoutubePageKind = 'watch' | 'shorts' | 'live' | 'other';

/**
 * Classifies a YouTube URL by shape alone. See the `YoutubePageKind` doc
 * comment for the known limitation around live streams on `/watch?v=` URLs.
 */
export function classifyYoutubeUrl(url: string | undefined): YoutubePageKind {
  if (!url) return 'other';
  try {
    const parsed = new URL(url);
    if (!isYoutubeHostname(parsed.hostname)) return 'other';

    if (parsed.pathname === '/watch') return 'watch';
    if (parsed.pathname.startsWith('/shorts/')) return 'shorts';
    if (parsed.pathname.startsWith('/live/')) return 'live';
    if (/^\/@[^/]+\/live\/?$/.test(parsed.pathname)) return 'live';

    return 'other';
  } catch {
    return 'other';
  }
}

/**
 * Extracts a video id from a YouTube URL, covering the `v=` query
 * parameter as well as the `/shorts/<id>` and `/live/<id>` path shapes and
 * the `youtu.be/<id>` short-link host. Returns `null` when no id can be
 * found (including when `v` is present but empty).
 */
export function parseVideoId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);

    if (parsed.hostname === 'youtu.be' || parsed.hostname === 'www.youtu.be') {
      const youtuBeMatch = parsed.pathname.match(/^\/([^/]+)/);
      return youtuBeMatch ? youtuBeMatch[1] : null;
    }

    if (!isYoutubeHostname(parsed.hostname)) return null;

    if (parsed.pathname === '/watch') {
      const id = parsed.searchParams.get('v');
      return id || null;
    }

    const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/]+)/);
    if (shortsMatch) return shortsMatch[1];

    const liveMatch = parsed.pathname.match(/^\/live\/([^/]+)/);
    if (liveMatch) return liveMatch[1];

    return null;
  } catch {
    return null;
  }
}

// The panel's host_permissions only cover youtube.com, so `tab.url` reads as
// undefined on any other origin — that's Chrome enforcing the permission
// boundary, not a bug. isYoutubeWatchUrl treats an unreadable url the same as
// a non-YouTube tab (falls through to `false`), which is the correct result
// either way.
export function isYoutubeWatchUrl(url: string | undefined): boolean {
  return classifyYoutubeUrl(url) === 'watch';
}
