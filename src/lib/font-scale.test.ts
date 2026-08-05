import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STEPS,
  formatFontScale,
  normalizeFontScale,
  stepFontScale,
} from './font-scale';

describe('normalizeFontScale', () => {
  it('keeps a value that is one of the steps', () => {
    expect(normalizeFontScale(1.3)).toBe(1.3);
  });

  it('falls back to the default for a number outside the ladder', () => {
    expect(normalizeFontScale(1.2)).toBe(DEFAULT_FONT_SCALE);
  });

  it('falls back for non-numbers, undefined and NaN', () => {
    expect(normalizeFontScale('1.3')).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(undefined)).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(Number.NaN)).toBe(DEFAULT_FONT_SCALE);
  });
});

describe('stepFontScale', () => {
  it('moves one step up and down the ladder', () => {
    expect(stepFontScale(1, 1)).toBe(1.15);
    expect(stepFontScale(1.15, -1)).toBe(1);
  });

  it('stays put at both boundaries', () => {
    const min = FONT_SCALE_STEPS[0];
    const max = FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1];
    expect(stepFontScale(min, -1)).toBe(min);
    expect(stepFontScale(max, 1)).toBe(max);
  });

  it('treats a corrupt current value as the default before stepping', () => {
    expect(stepFontScale(99, 1)).toBe(1.15);
  });
});

describe('formatFontScale', () => {
  it('renders whole percents without floating point residue', () => {
    expect(formatFontScale(0.9)).toBe('90%');
    expect(formatFontScale(1.15)).toBe('115%');
    expect(formatFontScale(1.75)).toBe('175%');
  });
});
