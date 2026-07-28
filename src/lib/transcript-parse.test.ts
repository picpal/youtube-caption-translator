import { describe, it, expect } from 'vitest';
import {
  parseTimestamp,
  formatTimestamp,
  dedupeRows,
  reconstructSentences,
  rowsToSegments,
  captionHash,
  MERGE_TARGET_CHARS,
} from '~/lib/transcript-parse';
import type { RawTranscriptRow } from '~/types/message';

// Fixture rows, verbatim from docs/youtube-transcript-findings.md.

// §7 — primary fixture (zjkBMFhNj_g, ASR), rows 0-7. No punctuation, no
// rolling overlap (measured: 0 word overlap across every consecutive pair).
const ASR_ROWS: RawTranscriptRow[] = [
  {
    tsText: '0:00',
    text: 'hi everyone so recently I gave a 30-minute talk on large language models just kind of like an intro talk um',
  },
  {
    tsText: '0:06',
    text: 'unfortunately that talk was not recorded but a lot of people came to me after the talk and they told me that uh they',
  },
  {
    tsText: '0:11',
    text: 'really liked the talk so I would just I thought I would just re-record it and basically put it up on YouTube so here',
  },
  {
    tsText: '0:16',
    text: "we go the busy person's intro to large language models director Scott okay so let's begin first of all what is a large",
  },
  {
    tsText: '0:24',
    text: 'language model really well a large language model is just two files right um there will be two files in this',
  },
  {
    tsText: '0:31',
    text: 'hypothetical directory so for example working with a specific example of the Llama 270b model this is a large',
  },
  {
    tsText: '0:38',
    text: 'language model released by meta Ai and this is basically the Llama series of language models the second iteration of',
  },
  {
    tsText: '0:45',
    text: "it and this is the 70 billion parameter model of uh of this series so there's",
  },
];

// §8 — manual-caption fixture (MB5IX-np5fE, English track), first 8 rows.
// Has punctuation/capitalization and literal `\n` inside `.segment-text`.
const MANUAL_ROWS: RawTranscriptRow[] = [
  { tsText: '0:13', text: 'For a really long time,' },
  { tsText: '0:14', text: 'I had two mysteries\nthat were hanging over me.' },
  { tsText: '0:18', text: "I didn't understand them" },
  {
    tsText: '0:20',
    text: 'and, to be honest, I was quite afraid\nto look into them.',
  },
  { tsText: '0:24', text: "The first mystery was, I'm 40 years old," },
  { tsText: '0:27', text: 'and all throughout my lifetime,\nyear after year,' },
  { tsText: '0:30', text: 'serious depression and anxiety have risen,' },
  { tsText: '0:34', text: 'in the United States, in Britain,' },
];

describe('parseTimestamp', () => {
  it('parses m:ss (2 parts)', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('0:06')).toBe(6);
    expect(parseTimestamp('59:45')).toBe(59 * 60 + 45);
    expect(parseTimestamp('59:57')).toBe(59 * 60 + 57);
  });

  it('parses h:mm:ss (3 parts), no leading zero on the leftmost unit', () => {
    // §3 measured transition + max, long-form fixture kCc8FmEb1nY.
    expect(parseTimestamp('1:00:11')).toBe(1 * 3600 + 0 * 60 + 11);
    expect(parseTimestamp('1:56:15')).toBe(1 * 3600 + 56 * 60 + 15);
  });

  it('trims surrounding whitespace', () => {
    expect(parseTimestamp('  0:06  ')).toBe(6);
  });

  it('throws on a malformed timestamp (not 2 or 3 numeric parts)', () => {
    expect(() => parseTimestamp('')).toThrow();
    expect(() => parseTimestamp('abc')).toThrow();
    expect(() => parseTimestamp('1:2:3:4')).toThrow();
    expect(() => parseTimestamp('1')).toThrow();
  });
});

describe('formatTimestamp', () => {
  it('formats under-1h as m:ss, no leading zero on minutes', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(6)).toBe('0:06');
    expect(formatTimestamp(359)).toBe('5:59');
    expect(formatTimestamp(59 * 60 + 45)).toBe('59:45');
  });

  it('formats 1h+ as h:mm:ss, no leading zero on hours, zero-padded mm/ss', () => {
    expect(formatTimestamp(3600)).toBe('1:00:00');
    expect(formatTimestamp(3611)).toBe('1:00:11');
    expect(formatTimestamp(1 * 3600 + 56 * 60 + 15)).toBe('1:56:15');
  });

  it('round-trips with parseTimestamp for representative values', () => {
    for (const sec of [0, 6, 45, 359, 599, 3599, 3600, 3611, 7025]) {
      expect(parseTimestamp(formatTimestamp(sec))).toBe(sec);
    }
  });

  it('clamps a negative or non-finite input to "0:00" instead of throwing or emitting garbage', () => {
    expect(formatTimestamp(-5)).toBe('0:00');
    expect(formatTimestamp(NaN)).toBe('0:00');
    expect(formatTimestamp(Infinity)).toBe('0:00');
    expect(formatTimestamp(-Infinity)).toBe('0:00');
  });
});

describe('dedupeRows', () => {
  it('is a no-op on an already-unique list, preserving order', () => {
    expect(dedupeRows(ASR_ROWS)).toEqual(ASR_ROWS);
  });

  it('collapses the double-mount pattern (Task 1 §4b): two full copies back to back', () => {
    // Measured: querySelectorAll unscoped returns every row twice because the
    // panel mounts two identical ytd-transcript-segment-list-renderer
    // subtrees (581 unique -> 1162 raw on the primary fixture).
    const doubled = [...ASR_ROWS, ...ASR_ROWS];
    expect(dedupeRows(doubled)).toEqual(ASR_ROWS);
  });

  it('keeps first-seen order when a duplicate reappears out of a clean back-to-back split', () => {
    const withInterleave = [ASR_ROWS[0], ASR_ROWS[1], ASR_ROWS[0], ASR_ROWS[2]];
    expect(dedupeRows(withInterleave)).toEqual([ASR_ROWS[0], ASR_ROWS[1], ASR_ROWS[2]]);
  });

  it('treats rows as distinct when either field differs', () => {
    const rows: RawTranscriptRow[] = [
      { tsText: '0:00', text: 'a' },
      { tsText: '0:00', text: 'b' }, // same ts, different text
      { tsText: '0:01', text: 'a' }, // different ts, same text
    ];
    expect(dedupeRows(rows)).toEqual(rows);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeRows([])).toEqual([]);
  });
});

describe('reconstructSentences', () => {
  it('does NOT apply rolling-overlap dedup — every word from every row survives, in order', () => {
    // Task 1 §7 measured 0 word overlap across all consecutive ASR row pairs
    // in the panel DOM; a rolling-overlap dedup step would corrupt this text.
    const units = reconstructSentences(ASR_ROWS);
    const joinedWords = units
      .map((u) => u.text)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean);
    const originalWords = ASR_ROWS.map((r) => r.text)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean);
    expect(joinedWords).toEqual(originalWords);
  });

  it('merges punctuation-free ASR rows by accumulated length, keeping the first row timestamp', () => {
    const units = reconstructSentences(ASR_ROWS);
    // None of these 8 rows contain sentence-ending punctuation, so merging is
    // driven purely by MERGE_TARGET_CHARS. Every unit must therefore have
    // reached the target length, except possibly the last (end of input).
    for (const unit of units.slice(0, -1)) {
      expect(unit.text.length).toBeGreaterThanOrEqual(MERGE_TARGET_CHARS);
    }
    // Every unit's tsText must be one of the original rows' tsText values
    // (the first row folded into that unit), and units must be fewer than
    // rows (some merging happened).
    expect(units.length).toBeGreaterThan(0);
    expect(units.length).toBeLessThan(ASR_ROWS.length);
    for (const unit of units) {
      expect(ASR_ROWS.map((r) => r.tsText)).toContain(unit.tsText);
    }
    // First unit starts at the first row's timestamp.
    expect(units[0].tsText).toBe('0:00');
  });

  it('flushes at a sentence boundary for manual (punctuated) captions, collapsing \\n to a space', () => {
    const units = reconstructSentences(MANUAL_ROWS);
    expect(units).toEqual([
      {
        tsText: '0:13',
        text: 'For a really long time, I had two mysteries that were hanging over me.',
      },
      {
        tsText: '0:18',
        text: "I didn't understand them and, to be honest, I was quite afraid to look into them.",
      },
      {
        tsText: '0:24',
        text: "The first mystery was, I'm 40 years old, and all throughout my lifetime, year after year, serious depression and anxiety have risen, in the United States, in Britain,",
      },
    ]);
  });

  it('drops rows that are blank after \\n/whitespace collapse rather than emitting an empty unit', () => {
    const rows: RawTranscriptRow[] = [
      { tsText: '0:00', text: '  \n  ' },
      { tsText: '0:01', text: 'hello.' },
    ];
    expect(reconstructSentences(rows)).toEqual([{ tsText: '0:01', text: 'hello.' }]);
  });

  it('returns an empty array for empty input', () => {
    expect(reconstructSentences([])).toEqual([]);
  });
});

describe('rowsToSegments', () => {
  const units: RawTranscriptRow[] = [
    { tsText: '0:00', text: 'first unit.' },
    { tsText: '0:10', text: 'second unit.' },
    { tsText: '0:25', text: 'third unit.' },
  ];

  it('computes segmentId, index and startSec/endSec from consecutive unit timestamps', () => {
    const segments = rowsToSegments(units, 'zjkBMFhNj_g');
    expect(segments).toEqual([
      {
        segmentId: 'zjkBMFhNj_g:0',
        videoId: 'zjkBMFhNj_g',
        index: 0,
        startSec: 0,
        endSec: 10,
        sourceText: 'first unit.',
        translatedText: null,
      },
      {
        segmentId: 'zjkBMFhNj_g:1',
        videoId: 'zjkBMFhNj_g',
        index: 1,
        startSec: 10,
        endSec: 25,
        sourceText: 'second unit.',
        translatedText: null,
      },
      {
        segmentId: 'zjkBMFhNj_g:2',
        videoId: 'zjkBMFhNj_g',
        index: 2,
        startSec: 25,
        // Fallback (no videoDurationSec given): last segment's endSec equals
        // its own startSec, documented in the brief as the no-duration case.
        endSec: 25,
        sourceText: 'third unit.',
        translatedText: null,
      },
    ]);
  });

  it('uses videoDurationSec for the last segment endSec when provided', () => {
    const segments = rowsToSegments(units, 'zjkBMFhNj_g', 3588);
    expect(segments[2].endSec).toBe(3588);
    // Earlier segments are unaffected by videoDurationSec.
    expect(segments[0].endSec).toBe(10);
    expect(segments[1].endSec).toBe(25);
  });

  it('returns an empty array for empty input', () => {
    expect(rowsToSegments([], 'zjkBMFhNj_g')).toEqual([]);
  });

  it('handles a single unit (startSec === endSec fallback, no next unit)', () => {
    const segments = rowsToSegments([{ tsText: '0:05', text: 'only.' }], 'v');
    expect(segments).toEqual([
      {
        segmentId: 'v:0',
        videoId: 'v',
        index: 0,
        startSec: 5,
        endSec: 5,
        sourceText: 'only.',
        translatedText: null,
      },
    ]);
  });
});

describe('captionHash', () => {
  it('is deterministic: the same input always produces the same hash', () => {
    const text = 'hi everyone so recently I gave a 30-minute talk';
    expect(captionHash(text)).toBe(captionHash(text));
  });

  it('changes when the content changes', () => {
    const a = captionHash('hi everyone so recently I gave a 30-minute talk');
    const b = captionHash('hi everyone so recently I gave a 31-minute talk');
    expect(a).not.toBe(b);
  });

  it('is sensitive to concatenation order (not just the multiset of characters)', () => {
    expect(captionHash('ab')).not.toBe(captionHash('ba'));
  });

  it('returns a non-empty string for empty input without throwing', () => {
    expect(typeof captionHash('')).toBe('string');
    expect(captionHash('')).toBe(captionHash(''));
  });

  it('is a hex string (regression pin against the concrete cyrb53 algorithm)', () => {
    expect(captionHash('hello')).toMatch(/^[0-9a-f]+$/);
  });
});
