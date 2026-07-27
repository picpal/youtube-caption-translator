import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractVideoMeta, parseIsoDuration, parseClockDuration } from '~/lib/video-meta';

// Resolved from the vitest root rather than `import.meta.url`: vite rewrites
// module URLs to root-relative paths, so `new URL('./x', import.meta.url)`
// resolves to `/src/lib/x` instead of the real on-disk location.
const FIXTURE_DIR = path.resolve(process.cwd(), 'src/lib/__fixtures__');

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

const FULL_URL = 'https://www.youtube.com/watch?v=zjkBMFhNj_g';
const SPA_URL = 'https://www.youtube.com/watch?v=qYNweeDHiyU';

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

  it('falls back to the player clock when the microdata duration is absent but fresh', () => {
    const doc = loadFixture(FULL_LOAD);
    doc.querySelector('meta[itemprop="duration"]')?.remove();
    expect(extractVideoMeta(doc, FULL_URL)?.durationSeconds).toBe(3587);
  });

  it('reports no channel rather than guessing when the owner anchor is gone', () => {
    const doc = loadFixture(SPA_STALE);
    doc.querySelector('#owner #channel-name a')?.remove();
    const meta = extractVideoMeta(doc, SPA_URL);
    expect(meta?.channelName).toBe('');
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
