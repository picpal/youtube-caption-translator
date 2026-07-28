import type { RawTranscriptRow } from '~/types/message';
import type { TranscriptSegment } from '~/types/transcript';

// M2 Task 4 — pure transcript parser. Everything here is dependency-free and
// operates only on `RawTranscriptRow[]` / strings, so it is unit-testable
// against the fixture samples in docs/youtube-transcript-findings.md without
// touching Chrome. The content-script scraper (entrypoints/content.ts) is
// the only caller that talks to the DOM; it feeds this module's functions in
// the order dedupeRows -> reconstructSentences -> rowsToSegments.

/**
 * Seconds from a transcript-panel timestamp string.
 *
 * Parse rule, measured in docs/youtube-transcript-findings.md §3: split on
 * `:`. 2 parts -> `m:ss` (`m*60 + s`). 3 parts -> `h:mm:ss`
 * (`h*3600 + m*60 + s`). No leading zero on the leftmost unit in either case
 * (`"0:00"`, `"1:00:11"` — never `"01:00:11"`).
 *
 * Throws on anything else (not 2 or 3 numeric parts) rather than returning a
 * sentinel: the DOM contract guarantees this shape for every row the scraper
 * hands in, so a malformed value here means the contract broke, and a silent
 * `NaN` propagating into `startSec`/`endSec` would be far harder to trace
 * than a thrown error at the parse site.
 */
export function parseTimestamp(ts: string): number {
  const parts = ts.trim().split(':');
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`parseTimestamp: expected "m:ss" or "h:mm:ss", got ${JSON.stringify(ts)}`);
  }

  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n))) {
    throw new Error(`parseTimestamp: non-numeric part in ${JSON.stringify(ts)}`);
  }

  return nums.length === 2
    ? nums[0] * 60 + nums[1]
    : nums[0] * 3600 + nums[1] * 60 + nums[2];
}

/**
 * Inverse of `parseTimestamp`: whole seconds -> YouTube's own display format
 * (docs/youtube-transcript-findings.md §3) — `m:ss` under 1h, `h:mm:ss` at or
 * above 1h, no leading zero on the leftmost unit, zero-padded lower units
 * (`0` -> `"0:00"`, `3611` -> `"1:00:11"`, never `"01:00:11"`).
 * `parseTimestamp(formatTimestamp(x)) === x` for every non-negative integer
 * `x` — see transcript-parse.test.ts for the round-trip assertion.
 *
 * The single seconds->clock definition in this codebase — `VideoCard.tsx`'s
 * `formatDuration` (video duration badge) delegates to this rather than
 * re-implementing the identical m:ss/h:mm:ss logic, so there is exactly one
 * place this format can drift. Used directly by `TranscriptList` (Task 9) to
 * render `TranscriptSegment.startSec`.
 *
 * A negative or non-finite input (`NaN`, `Infinity`) is clamped to `0`
 * rather than propagating into the arithmetic below: this runs on the
 * render path (unlike `parseTimestamp`, which throws in the guarded scrape
 * path), so a malformed value here should degrade to `"0:00"`, not crash
 * the panel or print `"NaN:NaN"`.
 */
export function formatTimestamp(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

/**
 * De-dupes rows by the `(tsText, text)` pair, keeping first-seen order.
 *
 * Exists as a pure, unit-testable counterpart to the dedup the scraper must
 * also do at scrape time (Task 1 §4b: the transcript panel mounts the ENTIRE
 * transcript TWICE — two identical `ytd-transcript-segment-list-renderer`
 * subtrees — so an unscoped `querySelectorAll` returns every row twice).
 * `entrypoints/content.ts`'s `scrapeRows` calls this directly rather than
 * re-implementing the same key logic, so there is exactly one definition of
 * "duplicate row" in the codebase.
 */
export function dedupeRows(rows: RawTranscriptRow[]): RawTranscriptRow[] {
  const seen = new Set<string>();
  const out: RawTranscriptRow[] = [];
  for (const row of rows) {
    // JSON.stringify rather than a plain string join: it escapes both
    // fields unambiguously, so a delimiter character appearing inside
    // either scraped field can never manufacture a false duplicate match.
    const key = JSON.stringify([row.tsText, row.text]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Target length (characters) a merged unit accumulates toward before
 * `reconstructSentences` flushes it, for caption text that carries no
 * sentence-ending punctuation (the ASR case — Task 1 §8 measured "no
 * punctuation, no capitalization" on the primary fixture). Chosen as a
 * reasonable default for a translation-unit size, not a measured value —
 * flagged in task-4-report.md for the controller to reconsider if the
 * downstream Gemini batching (Task 5) wants a different granularity.
 */
export const MERGE_TARGET_CHARS = 220;

// A caption line ends a sentence if it ends in ./!/? , optionally followed by
// one closing quote/paren. Manual captions (Task 1 §8) carry full
// punctuation; ASR rows never match this, so ASR merging is driven purely by
// MERGE_TARGET_CHARS below.
const SENTENCE_END_RE = /[.!?]['")\]]?$/;

/**
 * Merges CONSECUTIVE rows into translation units, each keeping the FIRST
 * merged row's timestamp as its own `tsText`. Returns the same
 * `RawTranscriptRow` shape so the result composes directly with
 * `rowsToSegments` (and, for testing, with `dedupeRows`/`reconstructSentences`
 * itself).
 *
 * Heuristic (TDD'd against docs/youtube-transcript-findings.md §7/§8, not a
 * measured YouTube behaviour — there is nothing to measure, this step is
 * this project's own design):
 * - A literal `\n` inside `.segment-text` (measured on manual captions, Task
 *   1 §8 — mid-sentence caption line breaks) is collapsed to a space, then
 *   runs of whitespace are collapsed to one space and the row is trimmed.
 * - A blank row (all whitespace) contributes nothing and is dropped rather
 *   than starting an empty unit.
 * - Rows accumulate into the current unit until EITHER the accumulated text
 *   ends in sentence-ending punctuation (manual captions) OR the accumulated
 *   length reaches `MERGE_TARGET_CHARS` (ASR captions, which carry no
 *   punctuation at all — Task 1 §7 confirmed 0-word overlap across every
 *   consecutive row pair in the panel DOM, so no rolling-overlap dedup is
 *   applied here; that would corrupt real text).
 * - Any remainder at the end of input is flushed as a final unit even if it
 *   never reached a boundary.
 */
export function reconstructSentences(rows: RawTranscriptRow[]): RawTranscriptRow[] {
  const units: RawTranscriptRow[] = [];
  let unitStart: string | null = null;
  let parts: string[] = [];
  let length = 0;

  const flush = (): void => {
    if (unitStart === null) return;
    units.push({ tsText: unitStart, text: parts.join(' ') });
    unitStart = null;
    parts = [];
    length = 0;
  };

  for (const row of rows) {
    const cleaned = row.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    if (unitStart === null) unitStart = row.tsText;
    parts.push(cleaned);
    length += cleaned.length + 1; // +1 accounts for the join separator

    if (SENTENCE_END_RE.test(cleaned) || length >= MERGE_TARGET_CHARS) {
      flush();
    }
  }
  flush();

  return units;
}

/**
 * Produces `TranscriptSegment`s from (already reconstructed) rows.
 *
 * `endSec` for every segment but the last is the NEXT row's `startSec` — the
 * two are contiguous by construction (they came from a single ordered
 * transcript). The last segment's `endSec` is `videoDurationSec` when the
 * caller supplies it; otherwise it falls back to that segment's OWN
 * `startSec`, i.e. a zero-length final segment. That fallback is a
 * deliberate "don't guess" choice (documented in the brief) rather than
 * inventing a length — callers that care about a non-zero final segment must
 * pass `videoDurationSec`.
 */
export function rowsToSegments(
  rows: RawTranscriptRow[],
  videoId: string,
  videoDurationSec?: number,
): TranscriptSegment[] {
  const startSecs = rows.map((row) => parseTimestamp(row.tsText));

  return rows.map((row, index) => {
    const isLast = index === rows.length - 1;
    const endSec = isLast ? (videoDurationSec ?? startSecs[index]) : startSecs[index + 1];

    return {
      segmentId: `${videoId}:${index}`,
      videoId,
      index,
      startSec: startSecs[index],
      endSec,
      sourceText: row.text,
      translatedText: null,
    };
  });
}

/**
 * A stable, dependency-free, non-cryptographic hash of caption text, used as
 * `TranslationRecord.captionHash` (src/types/transcript.ts) — the
 * cache-invalidation key per PRD §12: a cached translation is reused iff this
 * hash still matches the current scrape.
 *
 * This is cyrb53 (public-domain, by bryc: https://github.com/bryc/code —
 * reproduced here rather than imported, per the "no new deps" constraint).
 * 53 bits of avalanche from two 32-bit Mul/Xorshift accumulators, chosen
 * over a simpler djb2/FNV-1a for its much lower collision rate on
 * medium-length text; there is no cryptographic requirement here, only
 * "changes iff the content changes" for a UI cache key.
 */
export function captionHash(sourceText: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < sourceText.length; i += 1) {
    const ch = sourceText.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16);
}
