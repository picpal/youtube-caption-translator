import { describe, expect, it } from 'vitest';
import { isYoutubeWatchUrl } from './youtube';

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
