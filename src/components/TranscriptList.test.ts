import { describe, expect, it } from 'vitest';
import { visibleTexts } from './TranscriptList';
import type { TranscriptSegment } from '~/types/transcript';

// Task R7 (Fix 1) — `visibleTexts` is the pure decision behind each
// transcript row's rendering; covered here instead of a component-render
// test (this repo has no such setup, and the brief says not to introduce
// one).

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    segmentId: 'v1:0',
    videoId: 'v1',
    index: 0,
    startSec: 0,
    endSec: 5,
    sourceText: 'Hello world',
    translatedText: '안녕하세요',
    ...overrides,
  };
}

describe('visibleTexts', () => {
  describe("mode: 'both'", () => {
    it('shows EN (secondary) + KO (primary) when translated', () => {
      expect(visibleTexts(segment(), 'both')).toEqual({
        kind: 'dual',
        secondaryText: 'Hello world',
        primaryText: '안녕하세요',
      });
    });

    it('falls back to EN-only, secondary style, when translatedText is null', () => {
      expect(visibleTexts(segment({ translatedText: null }), 'both')).toEqual({
        kind: 'secondary-only',
        text: 'Hello world',
      });
    });
  });

  describe("mode: 'ko'", () => {
    it('shows KO alone, in primary style', () => {
      expect(visibleTexts(segment(), 'ko')).toEqual({ kind: 'primary-only', text: '안녕하세요' });
    });

    it('falls back to EN, still in primary style, when translatedText is null (no empty row)', () => {
      expect(visibleTexts(segment({ translatedText: null }), 'ko')).toEqual({
        kind: 'primary-only',
        text: 'Hello world',
      });
    });
  });

});
