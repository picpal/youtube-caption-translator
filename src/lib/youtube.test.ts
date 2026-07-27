import { describe, expect, it } from 'vitest';
import { classifyYoutubeUrl, isYoutubeWatchUrl, parseVideoId } from './youtube';

describe('isYoutubeWatchUrl', () => {
  it('returns false for undefined (unreadable url, e.g. no host permission)', () => {
    expect(isYoutubeWatchUrl(undefined)).toBe(false);
  });

  it('returns true for a youtube.com watch url', () => {
    expect(isYoutubeWatchUrl('https://www.youtube.com/watch?v=zjkBMFhNj_g')).toBe(true);
  });

  it('returns true for the bare apex domain', () => {
    expect(isYoutubeWatchUrl('https://youtube.com/watch?v=abc')).toBe(true);
  });

  it('returns true for other youtube.com subdomains (e.g. m.youtube.com)', () => {
    expect(isYoutubeWatchUrl('https://m.youtube.com/watch?v=abc')).toBe(true);
  });

  it('returns false for the youtube.com homepage (not a watch page)', () => {
    expect(isYoutubeWatchUrl('https://www.youtube.com/')).toBe(false);
  });

  it('returns false for other youtube.com paths (e.g. /results, /channel/...)', () => {
    expect(isYoutubeWatchUrl('https://www.youtube.com/results?search_query=x')).toBe(false);
    expect(isYoutubeWatchUrl('https://www.youtube.com/channel/UC123')).toBe(false);
  });

  it('returns false for a lookalike domain that merely contains youtube.com', () => {
    expect(isYoutubeWatchUrl('https://youtube.com.evil.example/watch')).toBe(false);
    expect(isYoutubeWatchUrl('https://notyoutube.com/watch')).toBe(false);
  });

  it('returns false for a non-YouTube url', () => {
    expect(isYoutubeWatchUrl('https://example.com/watch')).toBe(false);
  });

  it('returns false for a malformed url instead of throwing', () => {
    expect(isYoutubeWatchUrl('not a url')).toBe(false);
  });
});

describe('parseVideoId', () => {
  it('extracts the id from a standard watch url', () => {
    expect(parseVideoId('https://www.youtube.com/watch?v=YDvsBbKfLPA')).toBe('YDvsBbKfLPA');
  });

  it('extracts the id from a watch url with extra query params and a timestamp', () => {
    expect(
      parseVideoId('https://www.youtube.com/watch?v=YDvsBbKfLPA&list=PL123&t=42s')
    ).toBe('YDvsBbKfLPA');
  });

  it('extracts the id from a youtu.be short link', () => {
    expect(parseVideoId('https://youtu.be/YDvsBbKfLPA')).toBe('YDvsBbKfLPA');
  });

  it('extracts the id from a shorts url', () => {
    expect(parseVideoId('https://www.youtube.com/shorts/3cRnRfPT7mM')).toBe('3cRnRfPT7mM');
  });

  it('extracts the id from a /live/<id> url', () => {
    expect(parseVideoId('https://www.youtube.com/live/YDvsBbKfLPA')).toBe('YDvsBbKfLPA');
  });

  it('returns null for undefined', () => {
    expect(parseVideoId(undefined)).toBeNull();
  });

  it('returns null for a non-YouTube url', () => {
    expect(parseVideoId('https://example.com/watch?v=YDvsBbKfLPA')).toBeNull();
  });

  it('returns null when v is present but empty', () => {
    expect(parseVideoId('https://www.youtube.com/watch?v=')).toBeNull();
  });

  it('returns null for a malformed url instead of throwing', () => {
    expect(parseVideoId('not a url')).toBeNull();
  });
});

describe('classifyYoutubeUrl', () => {
  it('classifies a standard watch url as watch', () => {
    expect(classifyYoutubeUrl('https://www.youtube.com/watch?v=YDvsBbKfLPA')).toBe('watch');
  });

  it('classifies a shorts url as shorts', () => {
    expect(classifyYoutubeUrl('https://www.youtube.com/shorts/3cRnRfPT7mM')).toBe('shorts');
  });

  it('classifies a /live/<id> url as live', () => {
    expect(classifyYoutubeUrl('https://www.youtube.com/live/YDvsBbKfLPA')).toBe('live');
  });

  it('classifies an /@handle/live url as live', () => {
    expect(classifyYoutubeUrl('https://www.youtube.com/@SkyNews/live')).toBe('live');
  });

  it('a live stream on a watch url classifies as watch — URL alone cannot tell', () => {
    // Task 1 measured that /watch?v=YDvsBbKfLPA served the same live stream as
    // /live/YDvsBbKfLPA and /@SkyNews/live, with no URL-level difference from a
    // VOD. This is the documented boundary of classifyYoutubeUrl, not a bug.
    expect(classifyYoutubeUrl('https://www.youtube.com/watch?v=YDvsBbKfLPA')).toBe('watch');
  });

  it('classifies the youtube.com homepage as other', () => {
    expect(classifyYoutubeUrl('https://www.youtube.com/')).toBe('other');
  });

  it('classifies a non-YouTube url as other', () => {
    expect(classifyYoutubeUrl('https://example.com/watch?v=YDvsBbKfLPA')).toBe('other');
  });

  it('classifies undefined as other', () => {
    expect(classifyYoutubeUrl(undefined)).toBe('other');
  });
});
