import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractVideoMeta, parseIsoDuration, parseClockDuration } from '~/lib/video-meta';

// Resolved from this file's own location, not `process.cwd()`, so the suite
// still works when vitest is invoked from a subdirectory.
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function loadFixture(name: string): Document {
  const html = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

// The three watch fixtures below are real CDP captures — see the comment block
// at the top of each file for how and when each was taken.
const FULL_LOAD = 'watch-full-load.html';
const SPA_STALE = 'watch-spa-stale-head.html';
const SPA_STALE_AD = 'watch-spa-stale-head-ad.html';
const NOTHING = 'no-video-metadata.html';
const LIVE = 'watch-live.html';
const SHORTS = 'shorts.html';
// Task 6 caption fixtures — same capture method, see each file's header.
const CAP_MANUAL = 'watch-captions-manual.html';
const CAP_NONE = 'watch-captions-none.html';
const SPA_CAP_UNKNOWN = 'watch-spa-captions-unknown.html';
const SPA_CAP_NONE = 'watch-spa-captions-none.html';

const FULL_URL = 'https://www.youtube.com/watch?v=zjkBMFhNj_g';
const SPA_URL = 'https://www.youtube.com/watch?v=qYNweeDHiyU';
const CAP_MANUAL_URL = 'https://www.youtube.com/watch?v=MB5IX-np5fE';
const CAP_NONE_URL = 'https://www.youtube.com/watch?v=I_6ZcOo6pnk';

describe('parseIsoDuration', () => {
  it('parses the measured fixture value PT59M48S', () => {
    expect(parseIsoDuration('PT59M48S')).toBe(3588);
  });

  it('parses hours, minutes and seconds together', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
  });

  it('parses an hours-only value', () => {
    expect(parseIsoDuration('PT2H')).toBe(7200);
  });

  it('parses a seconds-only value', () => {
    expect(parseIsoDuration('PT30S')).toBe(30);
  });

  it('parses the measured Shorts value PT1M11S', () => {
    expect(parseIsoDuration('PT1M11S')).toBe(71);
  });

  it('parses a day component', () => {
    expect(parseIsoDuration('P1DT2H3M4S')).toBe(93784);
  });

  it('returns null for a zero duration rather than reporting 0 seconds', () => {
    expect(parseIsoDuration('PT0S')).toBeNull();
  });

  it('returns null for junk, empty and missing input', () => {
    expect(parseIsoDuration('59:48')).toBeNull();
    expect(parseIsoDuration('P')).toBeNull();
    expect(parseIsoDuration('PT')).toBeNull();
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });
});

describe('parseClockDuration', () => {
  it('parses the measured M:SS/MM:SS fixture values', () => {
    expect(parseClockDuration('59:47')).toBe(3587);
    expect(parseClockDuration('10:00')).toBe(600);
    expect(parseClockDuration('0:59')).toBe(59);
  });

  it('parses H:MM:SS', () => {
    expect(parseClockDuration('1:02:03')).toBe(3723);
  });

  it('parses the measured live-DVR D:HH:MM:SS shape', () => {
    expect(parseClockDuration('137:04:51:37')).toBe(11854297);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseClockDuration('\n  10:00  ')).toBe(600);
  });

  it('returns null for a zero clock rather than reporting 0 seconds', () => {
    expect(parseClockDuration('0:00')).toBeNull();
  });

  it('rejects out-of-range minute and second fields', () => {
    expect(parseClockDuration('1:60')).toBeNull();
    expect(parseClockDuration('1:60:00')).toBeNull();
  });

  it('returns null for junk, empty and missing input', () => {
    expect(parseClockDuration('12')).toBeNull();
    expect(parseClockDuration('abc')).toBeNull();
    expect(parseClockDuration('1:2:3:4:5')).toBeNull();
    expect(parseClockDuration('')).toBeNull();
    expect(parseClockDuration(null)).toBeNull();
    expect(parseClockDuration(undefined)).toBeNull();
  });
});

describe('extractVideoMeta — full-load document (fresh microdata)', () => {
  const meta = () => extractVideoMeta(loadFixture(FULL_LOAD), FULL_URL);

  it('extracts all four fields', () => {
    expect(meta()).toEqual({
      videoId: 'zjkBMFhNj_g',
      url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
      title: '[1hr Talk] Intro to Large Language Models',
      channelName: 'Andrej Karpathy',
      thumbnailUrl: 'https://i.ytimg.com/vi/zjkBMFhNj_g/hqdefault.jpg',
      durationSeconds: 3588,
      // The inline player-response script names this same video and carries
      // exactly one `kind: "asr"` track.
      captionAvailability: 'auto-only',
    });
  });

  it('takes duration from the ad-immune microdata, not the player clock', () => {
    // The clock reads 59:47 (3587s); the microdata reads PT59M48S (3588s).
    // When the sentinel says the microdata is fresh it wins, because it is the
    // only ad-immune source.
    expect(meta()?.durationSeconds).toBe(3588);
    expect(meta()?.durationSeconds).not.toBe(3587);
  });

  it('reads the title from #title h1 despite an earlier decoy #title in the document', () => {
    const doc = loadFixture(FULL_LOAD);
    // Guard the fixture's own premise: a plain '#title' lookup hits the decoy.
    expect(doc.querySelector('#title')?.tagName).toBe('H2');
    expect(extractVideoMeta(doc, FULL_URL)?.title).toBe(
      '[1hr Talk] Intro to Large Language Models',
    );
  });
});

describe('extractVideoMeta — post-SPA document (stale microdata, different channel)', () => {
  const meta = () => extractVideoMeta(loadFixture(SPA_STALE), SPA_URL);

  it('extracts the CURRENT video, never the stale previous one', () => {
    expect(meta()).toEqual({
      videoId: 'qYNweeDHiyU',
      url: 'https://www.youtube.com/watch?v=qYNweeDHiyU',
      title: 'AI, Machine Learning, Deep Learning and Generative AI Explained',
      channelName: 'IBM Technology',
      thumbnailUrl: 'https://i.ytimg.com/vi/qYNweeDHiyU/hqdefault.jpg',
      durationSeconds: 600,
      // This fixture was captured for Task 5 and carries no caption nodes at
      // all — no inline script, no description subtree — so nothing about
      // captions can be determined from it. See the dedicated caption
      // fixtures below for the SPA caption cases.
      captionAvailability: 'unknown',
    });
  });

  it('does not fall for og:title / meta[itemprop=name] (both still the old video)', () => {
    const doc = loadFixture(SPA_STALE);
    expect(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
      '[1hr Talk] Intro to Large Language Models',
    );
    expect(meta()?.title).not.toBe('[1hr Talk] Intro to Large Language Models');
  });

  it('does not fall for the stale [itemprop=author] channel', () => {
    expect(meta()?.channelName).not.toBe('Andrej Karpathy');
  });

  it('detects the stale microdata via the identifier sentinel and uses the clock', () => {
    const doc = loadFixture(SPA_STALE);
    expect(doc.querySelector('meta[itemprop="identifier"]')?.getAttribute('content')).toBe(
      'zjkBMFhNj_g',
    );
    expect(doc.querySelector('meta[itemprop="duration"]')?.getAttribute('content')).toBe(
      'PT59M48S',
    );
    // 3588 would be the previous video's runtime — the exact confident lie the
    // sentinel exists to prevent.
    expect(meta()?.durationSeconds).toBe(600);
    expect(meta()?.durationSeconds).not.toBe(3588);
  });

  it('does not fall for the stale link[rel=canonical]', () => {
    const doc = loadFixture(SPA_STALE);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toContain(
      'zjkBMFhNj_g',
    );
    expect(meta()?.videoId).toBe('qYNweeDHiyU');
  });
});

describe('extractVideoMeta — post-SPA document with a pre-roll ad playing', () => {
  const meta = () => extractVideoMeta(loadFixture(SPA_STALE_AD), SPA_URL);

  it('returns no duration rather than the stale microdata or the ad clock', () => {
    expect(meta()?.durationSeconds).toBeNull();
    expect(meta()?.durationSeconds).not.toBe(3588); // stale microdata
    expect(meta()?.durationSeconds).not.toBe(59); // the ad's own length
    expect(meta()?.durationSeconds).not.toBe(0); // "0:00" in the panel is a lie
  });

  it('still extracts every other field', () => {
    expect(meta()).toEqual({
      videoId: 'qYNweeDHiyU',
      url: 'https://www.youtube.com/watch?v=qYNweeDHiyU',
      title: 'AI, Machine Learning, Deep Learning and Generative AI Explained',
      channelName: 'IBM Technology',
      thumbnailUrl: 'https://i.ytimg.com/vi/qYNweeDHiyU/hqdefault.jpg',
      durationSeconds: null,
      captionAvailability: 'unknown',
    });
  });
});

describe('extractVideoMeta — fallback chains', () => {
  it('falls back to ytd-watch-flexy[video-id] when the URL carries no v param', () => {
    const meta = extractVideoMeta(loadFixture(FULL_LOAD), 'https://www.youtube.com/watch');
    expect(meta?.videoId).toBe('zjkBMFhNj_g');
  });

  it('falls back to link[rel=canonical] when the URL and the flexy element are both unusable', () => {
    const doc = loadFixture(FULL_LOAD);
    doc.querySelector('ytd-watch-flexy')?.removeAttribute('video-id');
    const meta = extractVideoMeta(doc, 'https://www.youtube.com/watch');
    expect(meta?.videoId).toBe('zjkBMFhNj_g');
  });

  it('falls back to document.title minus the " - YouTube" suffix when #title h1 is gone', () => {
    const doc = loadFixture(SPA_STALE);
    doc.querySelector('#title h1')?.remove();
    expect(extractVideoMeta(doc, SPA_URL)?.title).toBe(
      'AI, Machine Learning, Deep Learning and Generative AI Explained',
    );
  });

  it('treats a fresh microdata block with no duration as live and reports none', () => {
    // Measured: a live stream is exactly this shape — the microdata block is
    // fresh (identifier matches) yet carries no meta[itemprop="duration"].
    // A VOD always had one. So this is a live signal, not a reason to trust
    // the clock (which would report the DVR window).
    const doc = loadFixture(FULL_LOAD);
    doc.querySelector('meta[itemprop="duration"]')?.remove();
    expect(extractVideoMeta(doc, FULL_URL)?.durationSeconds).toBeNull();
  });

  it('prefers the media element over the player clock', () => {
    const doc = loadFixture(SPA_STALE);
    // The SPA fixture's clock says 10:00 (600s). Give the media element a
    // clearly different value so this test can only pass if the media element
    // is genuinely preferred.
    const video = doc.createElement('video');
    Object.defineProperty(video, 'duration', { value: 612.7, configurable: true });
    doc.querySelector('#movie_player')?.appendChild(video);
    expect(extractVideoMeta(doc, SPA_URL)?.durationSeconds).toBe(613);
  });

  it('ignores a media element whose duration has not loaded yet and uses the clock', () => {
    const doc = loadFixture(SPA_STALE);
    const video = doc.createElement('video');
    Object.defineProperty(video, 'duration', { value: NaN, configurable: true });
    doc.querySelector('#movie_player')?.appendChild(video);
    expect(extractVideoMeta(doc, SPA_URL)?.durationSeconds).toBe(600);
  });

  it('ignores a media element reporting Infinity and falls through to the clock', () => {
    // Not observed on YouTube (its live player reports a finite DVR length),
    // but Infinity is the standard live value for a plain media element, so
    // it must never be rounded into a number.
    const doc = loadFixture(SPA_STALE);
    const video = doc.createElement('video');
    Object.defineProperty(video, 'duration', { value: Infinity, configurable: true });
    doc.querySelector('#movie_player')?.appendChild(video);
    expect(extractVideoMeta(doc, SPA_URL)?.durationSeconds).toBe(600);
  });

  it('reports no channel rather than guessing when the owner anchor is gone', () => {
    const doc = loadFixture(SPA_STALE);
    doc.querySelector('#owner #channel-name a')?.remove();
    const meta = extractVideoMeta(doc, SPA_URL);
    expect(meta?.channelName).toBeNull();
    expect(meta?.title).toBe('AI, Machine Learning, Deep Learning and Generative AI Explained');
  });

  it('collapses the whitespace the h1 markup introduces', () => {
    const doc = loadFixture(SPA_STALE);
    const h1 = doc.querySelector('#title h1');
    // Guard the premise: the raw textContent really is padded/multi-line.
    expect(h1?.textContent).not.toBe(h1?.textContent?.trim());
    h1!.textContent = '\n   Spaced    out\ttitle \n';
    expect(extractVideoMeta(doc, SPA_URL)?.title).toBe('Spaced out title');
  });
});

describe('extractVideoMeta — nothing usable', () => {
  it('returns null for a document with no video metadata at all', () => {
    expect(extractVideoMeta(loadFixture(NOTHING), 'https://www.youtube.com/')).toBeNull();
  });

  it('returns null when a video id exists but no title can be resolved', () => {
    const doc = loadFixture(FULL_LOAD);
    doc.querySelector('#title h1')?.remove();
    doc.title = 'YouTube';
    expect(extractVideoMeta(doc, FULL_URL)).toBeNull();
  });

  it('returns null when a title exists but no video id can be resolved', () => {
    const doc = loadFixture(FULL_LOAD);
    doc.querySelector('ytd-watch-flexy')?.removeAttribute('video-id');
    doc.querySelector('link[rel="canonical"]')?.remove();
    expect(extractVideoMeta(doc, 'https://www.youtube.com/feed/subscriptions')).toBeNull();
  });
});

describe('extractVideoMeta — live stream (no honest duration exists)', () => {
  const meta = () => extractVideoMeta(loadFixture(LIVE), 'https://www.youtube.com/watch?v=yq2ozBAd4MI');

  it('reports no duration rather than the DVR window', () => {
    const doc = loadFixture(LIVE);
    // Guard the fixture's premises, all measured on the live page:
    expect(doc.querySelector('meta[itemprop="identifier"]')?.getAttribute('content')).toBe('yq2ozBAd4MI');
    expect(doc.querySelector('meta[itemprop="duration"]')).toBeNull();
    expect(doc.querySelector('.ytp-time-duration')?.textContent).toBe('1:00:00');
    expect(doc.querySelector('.ytp-time-display')?.classList.contains('ytp-live')).toBe(true);

    // 3600 is the DVR window, not a runtime. So is the 137-day figure that
    // Task 1 measured on a longer DVR window.
    expect(meta()?.durationSeconds).toBeNull();
    expect(meta()?.durationSeconds).not.toBe(3600);
  });

  it('still extracts title and channel for a live stream', () => {
    expect(meta()).toEqual({
      videoId: 'yq2ozBAd4MI',
      url: 'https://www.youtube.com/watch?v=yq2ozBAd4MI',
      title: 'Mornings with Ridge and Frost | Monday 27 July 2026',
      channelName: 'Sky News',
      thumbnailUrl: 'https://i.ytimg.com/vi/yq2ozBAd4MI/hqdefault.jpg',
      durationSeconds: null,
      captionAvailability: 'unknown',
    });
  });

  it('rejects the DVR window via the ytp-live class even when the microdata is stale', () => {
    // The SPA-into-a-live-stream shape: stale microdata (so the
    // fresh-block-without-duration signal cannot fire) plus a live player.
    const doc = loadFixture(LIVE);
    doc.querySelector('meta[itemprop="identifier"]')?.setAttribute('content', 'someOtherId');
    expect(extractVideoMeta(doc, 'https://www.youtube.com/watch?v=yq2ozBAd4MI')?.durationSeconds).toBeNull();
  });

  it('does not let a live media element duration through either', () => {
    const doc = loadFixture(LIVE);
    doc.querySelector('meta[itemprop="identifier"]')?.setAttribute('content', 'someOtherId');
    const video = doc.createElement('video');
    // Measured on the real live stream: a finite DVR length, NOT Infinity.
    Object.defineProperty(video, 'duration', { value: 3600, configurable: true });
    doc.querySelector('#movie_player')?.appendChild(video);
    expect(extractVideoMeta(doc, 'https://www.youtube.com/watch?v=yq2ozBAd4MI')?.durationSeconds).toBeNull();
  });
});

describe('extractVideoMeta — Shorts (behaviour pinned, not accidental)', () => {
  const SHORTS_URL = 'https://www.youtube.com/shorts/3cRnRfPT7mM';
  const meta = () => extractVideoMeta(loadFixture(SHORTS), SHORTS_URL);

  it('returns a full record, NOT null', () => {
    // An earlier report claimed Shorts returned null "naturally". It does not,
    // and this test exists so the real behaviour stops being accidental.
    expect(meta()).toEqual({
      videoId: '3cRnRfPT7mM',
      // Deliberate: a Short is playable at the /watch?v= form, and the record
      // is keyed by video id.
      url: 'https://www.youtube.com/watch?v=3cRnRfPT7mM',
      title: "[외신 헤드라인] 빅테크 AI 투자 눈덩이…'현금' 잠식 경고 #shorts",
      channelName: null,
      thumbnailUrl: 'https://i.ytimg.com/vi/3cRnRfPT7mM/hqdefault.jpg',
      durationSeconds: 71,
      captionAvailability: 'unknown',
    });
  });

  it('falls through the whitespace-only #title h1 to document.title', () => {
    const doc = loadFixture(SHORTS);
    const h1 = doc.querySelector('#title h1');
    // Guard the premise: the element exists but holds only whitespace.
    expect(h1).not.toBeNull();
    expect(h1?.textContent?.trim()).toBe('');
  });

  it('has no owner anchor, so the channel is null rather than a guess', () => {
    expect(loadFixture(SHORTS).querySelector('#owner #channel-name a')).toBeNull();
    expect(meta()?.channelName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 6: caption availability
// ---------------------------------------------------------------------------

/** A minimal watch document carrying a hand-built inline player response. */
function docWithPlayerResponse(scriptBody: string, extraBody = ''): Document {
  return new DOMParser().parseFromString(
    `<html><head><title>T - YouTube</title></head><body>` +
      `<ytd-watch-flexy video-id="vvvvvvvvvvv"></ytd-watch-flexy>` +
      `<div id="title"><h1>T</h1></div>` +
      extraBody +
      `<script nonce="">${scriptBody}</script>` +
      `</body></html>`,
    'text/html',
  );
}

const VVV_URL = 'https://www.youtube.com/watch?v=vvvvvvvvvvv';

describe('caption availability — the inline player-response script (full loads)', () => {
  it('reports auto-only when every track is auto-generated', () => {
    const doc = loadFixture(FULL_LOAD);
    // Guard the fixture's premises: the script names THIS video, and its one
    // track is the asr shape (kind "asr", vssId "a.en").
    const text = doc.querySelector('script')?.textContent ?? '';
    expect(text).toContain('"videoId":"zjkBMFhNj_g"');
    expect(text).toContain('"kind":"asr"');
    expect(text).toContain('"vssId":"a.en"');
    expect(extractVideoMeta(doc, FULL_URL)?.captionAvailability).toBe('auto-only');
  });

  it('reports available when a human-authored track sits alongside the asr one', () => {
    const doc = loadFixture(CAP_MANUAL);
    const text = doc.querySelector('script')?.textContent ?? '';
    // The measured discriminator: a manual track has NO `kind` property and a
    // vssId beginning with "."; an auto track has kind "asr" and vssId "a.".
    expect(text).toContain('"vssId":".en"');
    expect(text).toContain('"vssId":"a.en"');
    expect(extractVideoMeta(doc, CAP_MANUAL_URL)?.captionAvailability).toBe('available');
  });

  it('reports none when the captions key is absent from the player response', () => {
    const doc = loadFixture(CAP_NONE);
    const text = doc.querySelector('script')?.textContent ?? '';
    // Measured: the key is absent entirely, not an empty object or array. This
    // is why the check is `'captions' in response`, not a length check.
    expect(text).toContain('"videoId":"I_6ZcOo6pnk"');
    expect(text).not.toContain('"captions"');
    expect(extractVideoMeta(doc, CAP_NONE_URL)?.captionAvailability).toBe('none');
  });

  it('reports none for an empty captionTracks array (the measured live-stream shape)', () => {
    const doc = docWithPlayerResponse(
      'var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":' +
        '{"captionTracks":[]}},"videoDetails":{"videoId":"vvvvvvvvvvv"}};',
    );
    expect(extractVideoMeta(doc, VVV_URL)?.captionAvailability).toBe('none');
  });

  it('treats any non-asr kind as a human-authored track', () => {
    const doc = docWithPlayerResponse(
      'var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":' +
        '{"captionTracks":[{"vssId":".en","languageCode":"en","kind":"forced"}]}},' +
        '"videoDetails":{"videoId":"vvvvvvvvvvv"}};',
    );
    expect(extractVideoMeta(doc, VVV_URL)?.captionAvailability).toBe('available');
  });

  it('survives a player response whose strings contain a literal };', () => {
    // A non-greedy /(\{[\s\S]*?\});/ regex would truncate here and throw. The
    // real scripts measured on Chrome 150 were 34KB-671KB with exactly one
    // "};" in them, so this never fired in practice — but a video description
    // is free text and one day it will.
    const doc = docWithPlayerResponse(
      'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"vvvvvvvvvvv",' +
        '"shortDescription":"code sample: if (x) {y();};  and more"},' +
        '"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":' +
        '[{"vssId":".en","languageCode":"en"}]}}};var meta = 1;',
    );
    expect(extractVideoMeta(doc, VVV_URL)?.captionAvailability).toBe('available');
  });

  it('ignores an inline script left over from a PREVIOUS video', () => {
    // Measured: this script is never replaced on an SPA transition. Trusting
    // it blindly would report the previous video's captions.
    const doc = loadFixture(CAP_MANUAL);
    const script = doc.querySelector('script')!;
    script.textContent = script.textContent!.replace('"videoId":"MB5IX-np5fE"', '"videoId":"someOtherId"');
    // The manual fixture's DOM says only "a transcript section exists", so the
    // kind is no longer knowable: 'unknown', never 'available'.
    const result = extractVideoMeta(doc, CAP_MANUAL_URL)?.captionAvailability;
    expect(result).toBe('unknown');
    expect(result).not.toBe('available');
  });

  it('degrades to the DOM path instead of throwing when the JSON is malformed', () => {
    const doc = loadFixture(CAP_NONE);
    const script = doc.querySelector('script')!;
    script.textContent = 'var ytInitialPlayerResponse = {"videoDetails":{"videoId": ,,,};';
    // CAP_NONE's DOM has a mounted description subtree and no transcript
    // section, so the DOM path can still answer.
    expect(() => extractVideoMeta(doc, CAP_NONE_URL)).not.toThrow();
    expect(extractVideoMeta(doc, CAP_NONE_URL)?.captionAvailability).toBe('none');
  });

  it('degrades to the DOM path when the object never closes', () => {
    const doc = docWithPlayerResponse('var ytInitialPlayerResponse = {"videoDetails": {"videoId": "vvv');
    expect(extractVideoMeta(doc, VVV_URL)?.captionAvailability).toBe('unknown');
  });

  it('ignores a script that merely mentions the variable without assigning it', () => {
    const doc = docWithPlayerResponse('if (window.ytInitialPlayerResponse) { boot(); }');
    expect(extractVideoMeta(doc, VVV_URL)?.captionAvailability).toBe('unknown');
  });
});

describe('caption availability — the DOM fallback (post-SPA, no usable script)', () => {
  it('reports unknown for a captioned video reached by an in-page navigation', () => {
    const doc = loadFixture(SPA_CAP_UNKNOWN);
    // Guard the fixture's premise: measured "no-script" on this document.
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('ytd-video-description-transcript-section-renderer')).not.toBeNull();
    // Captions demonstrably exist (this is the asr fixture video), but from
    // the DOM alone their kind cannot be recovered.
    expect(extractVideoMeta(doc, FULL_URL)?.captionAvailability).toBe('unknown');
  });

  it('reports none for a caption-free video reached by an in-page navigation', () => {
    // THE reverse-direction case Task 1 never measured: a stale positive here
    // would silently claim captions on a video that has none.
    const doc = loadFixture(SPA_CAP_NONE);
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('ytd-structured-description-content-renderer')).not.toBeNull();
    expect(doc.querySelector('ytd-video-description-transcript-section-renderer')).toBeNull();
    expect(extractVideoMeta(doc, CAP_NONE_URL)?.captionAvailability).toBe('none');
  });

  it('reports unknown, not none, while the description subtree is still mounting', () => {
    // Measured lazy mount: on a captioned video the transcript section read
    // absent 947ms after load and present at 1599ms. Reading "absent" as "no
    // captions" during that window would be a confident lie, so the mounted
    // container is required as corroboration.
    const doc = loadFixture(SPA_CAP_NONE);
    doc.querySelector('ytd-structured-description-content-renderer')?.remove();
    expect(extractVideoMeta(doc, CAP_NONE_URL)?.captionAvailability).toBe('unknown');
  });

  it('never reads data-tooltip-title, which is locale-dependent AND transiently wrong', () => {
    // Measured on a captioned video: "자막 사용 불가" at +947ms, "자막(c)" at
    // +1372ms. Both directions are pinned here.
    const captioned = loadFixture(SPA_CAP_UNKNOWN);
    captioned
      .querySelector('.ytp-subtitles-button')
      ?.setAttribute('data-tooltip-title', '자막 사용 불가');
    expect(extractVideoMeta(captioned, FULL_URL)?.captionAvailability).toBe('unknown');

    const bare = loadFixture(SPA_CAP_NONE);
    bare.querySelector('.ytp-subtitles-button')?.setAttribute('data-tooltip-title', '자막(c)');
    expect(extractVideoMeta(bare, CAP_NONE_URL)?.captionAvailability).toBe('none');
  });

  it('never reads aria-pressed, which follows the user\'s CC toggle', () => {
    // Measured: clicking the CC button on a captioned video flipped
    // aria-pressed true -> false and the preference persisted to the next
    // video, making it indistinguishable from a caption-free one.
    const captioned = loadFixture(SPA_CAP_UNKNOWN);
    captioned.querySelector('.ytp-subtitles-button')?.setAttribute('aria-pressed', 'false');
    expect(extractVideoMeta(captioned, FULL_URL)?.captionAvailability).toBe('unknown');

    const bare = loadFixture(SPA_CAP_NONE);
    bare.querySelector('.ytp-subtitles-button')?.setAttribute('aria-pressed', 'true');
    expect(extractVideoMeta(bare, CAP_NONE_URL)?.captionAvailability).toBe('none');
  });

  it('never reads aria-label, which said "subtitles unavailable" on all three videos', () => {
    const doc = loadFixture(SPA_CAP_UNKNOWN);
    // Guard the trap's premise straight from the capture.
    expect(doc.querySelector('.ytp-subtitles-button')?.getAttribute('aria-label')).toBe(
      '자막 사용 불가',
    );
    expect(extractVideoMeta(doc, FULL_URL)?.captionAvailability).toBe('unknown');
  });

  it('reports unknown when the page carries no caption signal whatsoever', () => {
    // A watch document read before the player or the description exists.
    // 'none' would assert an absence that was never observed.
    const doc = docWithPlayerResponse('/* nothing */');
    expect(extractVideoMeta(doc, VVV_URL)?.captionAvailability).toBe('unknown');
  });
});

describe('caption availability — the measured mid-SPA-transition transient', () => {
  it('still sees the previous video\'s panel while both are mounted', () => {
    // Measured synchronously inside a yt-page-data-updated handler, arriving
    // at the caption-free I_6ZcOo6pnk from a captioned video: the document
    // held 2 transcript sections and 3 description containers; at +100ms it
    // held 0 and 2. Nothing in the markup says which panel belongs to which
    // video, so the pure function cannot tell them apart and reports the
    // previous video's captions.
    //
    // This test does not endorse that answer — it pins it, so the day a
    // caller starts reading at yt-page-data-updated the failure is a visible
    // expectation rather than a silent wrong label in the panel.
    const doc = loadFixture(SPA_CAP_NONE);
    const stalePanel = doc.createElement('ytd-structured-description-content-renderer');
    stalePanel.appendChild(
      doc.createElement('ytd-video-description-transcript-section-renderer'),
    );
    doc.querySelector('ytd-watch-flexy')?.insertBefore(
      stalePanel,
      doc.querySelector('ytd-structured-description-content-renderer'),
    );

    expect(doc.querySelectorAll('ytd-structured-description-content-renderer')).toHaveLength(2);
    expect(extractVideoMeta(doc, CAP_NONE_URL)?.captionAvailability).toBe('unknown');
  });

  it('is unreachable when the inline script is fresh, which is why full loads are safe', () => {
    // The same stale panel on a full load changes nothing: the sentinel
    // matches, so the player response answers and the DOM is never consulted.
    const doc = loadFixture(CAP_NONE);
    const stalePanel = doc.createElement('ytd-structured-description-content-renderer');
    stalePanel.appendChild(
      doc.createElement('ytd-video-description-transcript-section-renderer'),
    );
    doc.querySelector('ytd-watch-flexy')?.appendChild(stalePanel);
    expect(extractVideoMeta(doc, CAP_NONE_URL)?.captionAvailability).toBe('none');
  });
});
