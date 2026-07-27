import { defineContentScript } from 'wxt/sandbox';
import { classifyYoutubeUrl } from '~/lib/youtube';
import { extractVideoMeta } from '~/lib/video-meta';

// ISOLATED world (the default — no `world` option needed), and Task 4's ruling
// stands, but not for the reason it gave. Task 4 assumed MAIN world would be
// required to distinguish manual captions from auto-generated ones, since
// `ytInitialPlayerResponse` is a page-context global. Task 6 measured that the
// ISOLATED world can recover the same object on a full load by reading the
// inline <script> element's TEXT — script text is ordinary DOM content — so
// all four CaptionAvailability values are reachable from here. See
// `resolveCaptionAvailability` in src/lib/video-meta.ts and task-6-report.md.
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  main() {
    const logMeta = (reason: string) => {
      const kind = classifyYoutubeUrl(location.href);
      const meta = extractVideoMeta(document, location.href);
      console.log(
        `[ypa] ${reason} kind:`,
        kind,
        'captions:',
        // Distinguished on purpose: `null` is a real value meaning "nothing
        // readable yet, ask again", and `??` would hide it behind the
        // no-record case.
        meta ? (meta.captionAvailability ?? 'null (ask again later)') : '(no meta)',
        'meta:',
        meta,
      );
    };

    logMeta('load');

    // Task 1 measured that at content-script time the watch DOM is not built
    // yet (`ytd-watch-flexy[video-id]` was still empty at `window load`), and
    // that `yt-page-data-updated` is the only signal at which both
    // `ytd-watch-flexy[video-id]` and `document.title` already hold the new
    // video's values — on a full load AND on an in-page navigation.
    //
    // This listener exists so Task 5 can be verified against a live page; it
    // is deliberately naive. Task 7 owns real navigation handling (debouncing
    // the duplicate `Page.navigatedWithinDocument`, last-seen-id idempotency,
    // the `ytd-page-manager` MutationObserver backstop) and Task 8 owns
    // forwarding the result over messaging instead of logging it.
    document.addEventListener('yt-page-data-updated', () => logMeta('yt-page-data-updated'));
  },
});
