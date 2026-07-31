// M2 data model (plan §3 / PRD §10). All types here describe the caption
// extraction + translation pipeline's on-disk and in-transit shapes; the
// pipeline itself (Tasks 4-7) and the `translations` IndexedDB store
// (Task 3) are built against these.

import type { TargetLang } from '~/lib/target-lang';

// PRD §10 TranscriptSegment — no isBookmarked field (bookmarks are a later
// M4 table, tracked separately by segmentId rather than denormalized here).
export interface TranscriptSegment {
  segmentId: string;         // `${videoId}:${index}`
  videoId: string;
  index: number;             // original order (batch/resume key)
  startSec: number;
  endSec: number;            // next segment's start (last = video duration)
  sourceText: string;        // reconstructed English after sentence-join/dedupe
  translatedText: string | null;  // null = not yet translated
}

export interface GlossaryEntry {
  term: string;
  translation: string;
  /** Keep the original-language term as-is instead of translating it. */
  keepOriginal: boolean;
}

export type TranslationStatus =
  | 'idle'
  | 'extracting'
  | 'analyzing'
  | 'translating'
  | 'done'
  | 'failed';

export interface TranslationRecord {
  videoId: string;           // key
  captionHash: string;       // hash of all sourceText — cache-invalidation key (PRD §12)
  sourceLang: string;        // 'en'
  status: TranslationStatus;
  segments: TranscriptSegment[];
  glossary: GlossaryEntry[];
  completedBatches: number;  // resume point
  totalBatches: number;
  error?: { step: TranslationStatus; reason: string };
  /** Language this record's `translatedText`/glossary are IN. Optional
   * because pre-existing records (persisted before language generalization)
   * lack it — every reader treats `undefined` as `'ko'`, the pipeline's
   * prior hardcoded target. */
  targetLang?: TargetLang;
  createdAt: string;
  updatedAt: string;
}

// M2 refactor (single large request + stage progress) — sub-phase of the
// CURRENT in-flight translate request during step 3 (`요청 전송 → 응답 수신
// → 파싱·정합성`). There is no per-segment counter anymore: a translation
// "chunk" is now up to `MAX_SEGMENTS_PER_REQUEST` segments sent as one
// sequential `translateBatch` call, so segment-level granularity within a
// chunk isn't meaningfully observable from the pipeline's own point of view.
export type TranslatePhase = 'sending' | 'receiving' | 'parsing';

// background -> panel Port event (channel `TRANSLATION_PROGRESS_PORT` in
// src/types/message.ts), streamed at each stage transition during the
// pipeline (extract -> analyze -> translate[per chunk: sending/receiving/
// parsing, then chunk-complete] -> done).
export interface TranslationProgress {
  videoId: string;
  status: TranslationStatus;
  step: 1 | 2 | 3 | 4;         // extract / analyze / translate / apply
  /** Only set while `step === 3` and a specific chunk request is actively
   * in flight — absent for every other step, and absent for step 3's own
   * "entering this step" / "chunk just completed" events (see pipeline.ts).
   */
  phase?: TranslatePhase;
  /** Chunks completed so far / total chunk count for this job — replaces
   * the old per-segment `done`/`total` counter. Both are `0` outside step 3
   * (nothing chunk-level to report yet), and `chunkIndex === totalChunks`
   * once step 4 (`done`) is reached. */
  chunkIndex: number;
  totalChunks: number;
}
