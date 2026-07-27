import { defineContentScript } from 'wxt/sandbox';
import { classifyYoutubeUrl, parseVideoId } from '~/lib/youtube';

// ISOLATED world (the default — no `world` option needed). MAIN world would
// only be required to distinguish manual captions from auto-generated ones
// via `ytInitialPlayerResponse.captions` (a page-context global), and M1's
// UI only renders a binary "captions available" / "no captions" that never
// surfaces that distinction. See task-4-report.md for the full reasoning.
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  main() {
    const kind = classifyYoutubeUrl(location.href);
    const videoId = parseVideoId(location.href);
    console.log('[ypa] page kind:', kind);
    console.log('[ypa] video id:', videoId);
  },
});
