import { describe, expect, it } from 'vitest';
import {
  activeSegmentIndex,
  isAutoScrollSuspended,
  isUserScroll,
  shouldEmitTick,
} from './playback-sync';

const segs = (...starts: number[]) => starts.map((startSec) => ({ startSec }));

describe('activeSegmentIndex', () => {
  it('returns null for an empty list', () => {
    expect(activeSegmentIndex([], 10)).toBeNull();
  });

  it('returns null when t is before the first segment', () => {
    expect(activeSegmentIndex(segs(5, 10, 20), 4.9)).toBeNull();
  });

  it('returns the index whose startSec equals t exactly', () => {
    expect(activeSegmentIndex(segs(0, 10, 20), 10)).toBe(1);
  });

  it('returns the previous index while t is between two starts', () => {
    expect(activeSegmentIndex(segs(0, 10, 20), 19.99)).toBe(1);
  });

  it('returns the last index when t is past the last start', () => {
    expect(activeSegmentIndex(segs(0, 10, 20), 9999)).toBe(2);
  });

  it('handles a single-segment list', () => {
    expect(activeSegmentIndex(segs(3), 2)).toBeNull();
    expect(activeSegmentIndex(segs(3), 3)).toBe(0);
  });
});

describe('shouldEmitTick', () => {
  it('always emits the first tick (no previous emit)', () => {
    expect(shouldEmitTick(null, 1000)).toBe(true);
  });

  it('suppresses a tick inside the interval', () => {
    expect(shouldEmitTick(1000, 1499)).toBe(false);
  });

  it('emits once the interval has elapsed (inclusive)', () => {
    expect(shouldEmitTick(1000, 1500)).toBe(true);
  });

  it('honors a custom interval', () => {
    expect(shouldEmitTick(1000, 1200, 100)).toBe(true);
  });
});

describe('isAutoScrollSuspended', () => {
  it('is not suspended when the user has never scrolled', () => {
    expect(isAutoScrollSuspended(null, 99999)).toBe(false);
  });

  it('is suspended within the window after a user scroll', () => {
    expect(isAutoScrollSuspended(1000, 5999)).toBe(true);
  });

  it('resumes once the window has fully elapsed', () => {
    expect(isAutoScrollSuspended(1000, 6000)).toBe(false);
  });

  it('honors a custom window', () => {
    expect(isAutoScrollSuspended(1000, 1500, 400)).toBe(false);
  });
});

describe('isUserScroll', () => {
  it('treats any scroll as user scroll when nothing programmatic is pending', () => {
    expect(isUserScroll(1000, null)).toBe(true);
  });

  it('ignores scroll events inside the programmatic window', () => {
    expect(isUserScroll(1000, 1300)).toBe(false);
  });

  it('treats scrolls at/after the window end as user scrolls', () => {
    expect(isUserScroll(1300, 1300)).toBe(true);
  });
});
