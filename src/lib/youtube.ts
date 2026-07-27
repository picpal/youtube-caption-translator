// The panel's host_permissions only cover youtube.com, so `tab.url` reads as
// undefined on any other origin — that's Chrome enforcing the permission
// boundary, not a bug. isYoutubeWatchUrl treats an unreadable url the same as
// a non-YouTube tab (falls through to `false`), which is the correct result
// either way.
export function isYoutubeWatchUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      /(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.pathname === '/watch'
    );
  } catch {
    return false;
  }
}
