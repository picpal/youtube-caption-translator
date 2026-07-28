// M2 data model (plan §3 / PRD §10). All types here describe the caption
// extraction + translation pipeline's on-disk and in-transit shapes; the
// pipeline itself (Tasks 4-7) and the `translations` IndexedDB store
// (Task 3) are built against these.

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
  keepEnglish: boolean;
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
  createdAt: string;
  updatedAt: string;
}

// background -> panel Port event (channel `TRANSLATION_PROGRESS_PORT` in
// src/types/message.ts), streamed once per batch/step during the pipeline.
export interface TranslationProgress {
  videoId: string;
  status: TranslationStatus;
  done: number;               // segment-based progress
  total: number;
  step: 1 | 2 | 3 | 4;        // extract / analyze / translate / apply
}
