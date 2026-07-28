import { captionHash, dedupeRows, reconstructSentences, rowsToSegments } from '~/lib/transcript-parse';
import type { AnalyzeGlossaryResult, TranslateBatchResult } from '~/lib/gemini';
import type { RequestTranscriptResponse } from '~/types/message';
import type {
  GlossaryEntry,
  TranscriptSegment,
  TranslationProgress,
  TranslationRecord,
  TranslationStatus,
} from '~/types/transcript';

// M2 Task 6 — the translation pipeline orchestrator. Wires Task 4's pure
// parser, Task 5's Gemini client, and Task 3's IndexedDB store into one
// async job: extract -> (cache/resume decision) -> analyze glossary ->
// translate in concurrency-capped batches with 429 backoff -> consistency
// post-process -> done. Every side-effecting collaborator is INJECTED via
// `deps` so this file never touches real Gemini/IndexedDB/Chrome/timers —
// `pipeline.test.ts` drives it entirely with mocks and an injectable
// `sleep`, and `entrypoints/background.ts` assembles the real `deps`.

/** Segments per Gemini `translateBatch` call. Plan §4 calls for 5-10; picked
 * the middle of that range as a default with no measured reason to prefer
 * either edge yet — revisit with real-Chrome timing if it turns out to be
 * wrong in either direction. */
export const BATCH_SIZE = 8;

/** Max simultaneously in-flight `translateBatch` calls (plan §4: "동시성
 * ≤3"). Enforced by `runWithConcurrencyLimit` below, a small fixed-size
 * worker pool — never `Promise.all` over every batch at once. */
export const MAX_CONCURRENCY = 3;

/** Exponential backoff schedule (ms) for a `rate_limit` (429) batch result,
 * per plan §4 ("예: 1s,2s,4s,최대 3~4회"). `BACKOFF_MS.length` (3) retries
 * are attempted after the first try, so a batch gets up to 4 attempts total
 * before it is recorded as a failure. */
export const BACKOFF_MS = [1000, 2000, 4000];

export interface TranslationPipelineDeps {
  /** Asks the content script on `tabId` for the raw transcript rows of
   * `videoId` (background -> content `REQUEST_TRANSCRIPT`, Task 4). */
  requestTranscript: (tabId: number, videoId: string) => Promise<RequestTranscriptResponse>;
  analyzeGlossary: (fullText: string, key: string) => Promise<AnalyzeGlossaryResult>;
  translateBatch: (
    segs: TranscriptSegment[],
    glossary: GlossaryEntry[],
    key: string,
  ) => Promise<TranslateBatchResult>;
  getTranslation: (videoId: string) => Promise<TranslationRecord | null>;
  putTranslation: (rec: TranslationRecord) => Promise<void>;
  upsertBatch: (videoId: string, batchIdx: number, segs: TranscriptSegment[]) => Promise<void>;
  /** Injectable so backoff waits are instant in tests — never a bare
   * `setTimeout` call inside this file. */
  sleep: (ms: number) => Promise<void>;
  /** Fired at least once per pipeline step (1-4) and once per completed
   * batch during step 3. Fire-and-forget from this file's point of view —
   * the pipeline does not await or react to it. */
  onProgress: (progress: TranslationProgress) => void;
}

export interface RunTranslationPipelineParams {
  videoId: string;
  tabId: number;
  key: string;
}

function countDone(segments: TranscriptSegment[]): number {
  return segments.filter((seg) => seg.translatedText !== null).length;
}

/**
 * Whether a previously-persisted record already has a resolved glossary
 * step, i.e. it is safe to reuse `record.glossary` instead of calling
 * `analyzeGlossary` again. `record.status` alone is not quite enough: a
 * record can be `'failed'` either because the glossary CALL itself failed
 * (glossary never resolved — `error.step === 'analyzing'`) or because a
 * later translate batch failed AFTER a successful glossary analysis
 * (`error.step === 'translating'`, glossary IS resolved and must not be
 * thrown away/re-billed on retry).
 */
function glossaryResolved(record: TranslationRecord): boolean {
  if (record.status === 'translating' || record.status === 'done') return true;
  if (record.status === 'failed' && record.error?.step !== 'analyzing') return true;
  return false;
}

interface BatchFailure {
  batchIdx: number;
  reason: string;
  message: string;
}

function summarizeFailures(failures: BatchFailure[]): string {
  return failures.map((f) => `batch ${f.batchIdx}: ${f.reason} (${f.message})`).join('; ');
}

async function failPipeline(
  deps: TranslationPipelineDeps,
  videoId: string,
  errorStep: TranslationStatus,
  progressStep: 1 | 2 | 3,
  reason: string,
  base?: TranslationRecord,
): Promise<TranslationRecord> {
  const now = new Date().toISOString();
  const rec: TranslationRecord = base
    ? { ...base, status: 'failed', error: { step: errorStep, reason }, updatedAt: now }
    : {
        videoId,
        captionHash: '',
        sourceLang: 'en',
        status: 'failed',
        segments: [],
        glossary: [],
        completedBatches: 0,
        totalBatches: 0,
        error: { step: errorStep, reason },
        createdAt: now,
        updatedAt: now,
      };
  await deps.putTranslation(rec);
  deps.onProgress({
    videoId,
    status: 'failed',
    done: countDone(rec.segments),
    total: rec.segments.length,
    step: progressStep,
  });
  return rec;
}

/**
 * Runs `worker` over `items` with at most `limit` calls in flight at once —
 * a fixed-size pool of `limit` runners each pulling the next item off a
 * shared cursor, rather than `Promise.all(items.map(worker))` (unbounded
 * concurrency) or one-at-a-time (no concurrency). Order of START is by
 * `items` order; order of COMPLETION is whatever each `worker` call takes,
 * which is exactly why batch persistence (`upsertBatch`) must be
 * self-contained per call rather than relying on completion order.
 */
async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const poolSize = Math.max(0, Math.min(limit, items.length));
  const runners: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i += 1) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const item = items[cursor];
          cursor += 1;
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Step 4 ("일관성", plan §4) — a PURE post-process, no extra Gemini call.
 * `translateBatch`'s prompt already tells the model to reuse each glossary
 * term's translation (src/lib/gemini.ts's `TRANSLATION_RULES`), but that is
 * only a prompt-level convention: nothing stops the model from leaving a
 * term untranslated in one batch while translating it correctly in
 * another, since every batch is an independent call. This pass corrects
 * exactly that leftover-English case deterministically: for every
 * `keepEnglish:false` glossary entry whose term appears (case-insensitively)
 * in a segment's `sourceText`, if that segment's `translatedText` STILL
 * contains the literal English term (i.e. the model skipped translating it
 * in that particular batch), every such occurrence is replaced with the
 * glossary's canonical translation. Segments where the model already used
 * the Korean translation are untouched (the regex finds nothing to
 * replace). `keepEnglish:true` entries are intentionally left alone — the
 * term is SUPPOSED to stay in English, so there is nothing to unify.
 */
export function applyGlossaryConsistency(
  segments: TranscriptSegment[],
  glossary: GlossaryEntry[],
): TranscriptSegment[] {
  const rewritable = glossary.filter((entry) => !entry.keepEnglish && entry.term.trim().length > 0);
  if (rewritable.length === 0) return segments;

  return segments.map((seg) => {
    if (seg.translatedText === null) return seg;
    let text = seg.translatedText;
    for (const entry of rewritable) {
      const testRe = new RegExp(escapeRegExp(entry.term), 'i');
      if (testRe.test(seg.sourceText) && testRe.test(text)) {
        const replaceRe = new RegExp(escapeRegExp(entry.term), 'gi');
        text = text.replace(replaceRe, entry.translation);
      }
    }
    return text === seg.translatedText ? seg : { ...seg, translatedText: text };
  });
}

export async function runTranslationPipeline(
  params: RunTranslationPipelineParams,
  deps: TranslationPipelineDeps,
): Promise<TranslationRecord> {
  const { videoId, tabId, key } = params;

  // --- Step 1: extract -------------------------------------------------
  deps.onProgress({ videoId, status: 'extracting', done: 0, total: 0, step: 1 });

  let rawResult: RequestTranscriptResponse;
  try {
    rawResult = await deps.requestTranscript(tabId, videoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failPipeline(deps, videoId, 'extracting', 1, `Could not reach content script: ${message}`);
  }

  if (!Array.isArray(rawResult)) {
    // `{unavailable:true}` — no transcript engagement panel at all (PRD §9
    // 실패 상태). Clean failure, not a crash: there is nothing to parse or
    // hash, so this short-circuits before the cache/resume logic below,
    // which needs a captionHash to key off of.
    return failPipeline(deps, videoId, 'extracting', 1, 'No transcript panel available for this video');
  }

  let segments: TranscriptSegment[];
  try {
    // dedupeRows -> reconstructSentences -> rowsToSegments, the exact order
    // transcript-parse.ts's own doc comment specifies. Wrapped in try/catch
    // because rowsToSegments calls parseTimestamp, which THROWS on a
    // malformed timestamp (transcript-parse.ts's documented contract) — one
    // bad row must fail this video cleanly, not crash the service worker.
    const deduped = dedupeRows(rawResult);
    const merged = reconstructSentences(deduped);
    segments = rowsToSegments(merged, videoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failPipeline(deps, videoId, 'extracting', 1, `Failed to parse transcript: ${message}`);
  }

  const fullText = segments.map((seg) => seg.sourceText).join('\n');
  const hash = captionHash(fullText);
  const totalBatches = segments.length === 0 ? 0 : Math.ceil(segments.length / BATCH_SIZE);

  // --- Step 2: cache/resume decision ------------------------------------
  const existing = await deps.getTranslation(videoId);

  if (existing && existing.captionHash === hash && existing.status === 'done') {
    // Same captions, already fully translated — reuse as-is, no re-work.
    deps.onProgress({
      videoId,
      status: 'done',
      done: existing.segments.length,
      total: existing.segments.length,
      step: 4,
    });
    return existing;
  }

  // Same captionHash but not done (any non-'done' status, including a
  // previous 'failed' — a prior failure may still have persisted partial
  // batch progress worth keeping) -> RESUME. Different hash or no record at
  // all -> fresh skeleton, persisted FIRST (before any batch work) so
  // upsertBatch (Task 3: throws on an absent record) always has something
  // to merge into.
  const resuming = existing !== null && existing.captionHash === hash;
  let record: TranslationRecord;
  if (resuming) {
    record = existing as TranslationRecord;
  } else {
    const now = new Date().toISOString();
    record = {
      videoId,
      captionHash: hash,
      sourceLang: 'en',
      status: 'analyzing',
      segments,
      glossary: [],
      completedBatches: 0,
      totalBatches,
      createdAt: now,
      updatedAt: now,
    };
    await deps.putTranslation(record);
  }

  // --- Step 2 (progress) / glossary analysis ----------------------------
  deps.onProgress({
    videoId,
    status: 'analyzing',
    done: countDone(record.segments),
    total: record.segments.length,
    step: 2,
  });

  let glossary: GlossaryEntry[];
  if (resuming && glossaryResolved(record)) {
    glossary = record.glossary;
  } else {
    const glossaryResult = await deps.analyzeGlossary(fullText, key);
    if (!glossaryResult.ok) {
      return failPipeline(deps, videoId, 'analyzing', 2, glossaryResult.message, record);
    }
    glossary = glossaryResult.glossary;
    record = { ...record, status: 'translating', glossary, updatedAt: new Date().toISOString() };
    await deps.putTranslation(record);
  }

  // --- Step 3: translate in concurrency-capped, backoff-retried batches -
  const total = record.segments.length;
  // `liveSegments` is this run's in-memory mirror of the record's segments,
  // kept index-aligned with `record.segments` (rowsToSegments assigns
  // contiguous `index` 0..n-1 in array order, and upsertBatch/db.ts's merge
  // preserves that order, so `liveSegments[i].index === i` holds). Mutating
  // this array (rather than re-reading `deps.getTranslation` after every
  // batch) is safe because JS has no true parallelism — concurrent batch
  // workers below only interleave at `await` points, never mid-statement.
  const liveSegments = record.segments.slice();
  let doneCount = countDone(liveSegments);
  let completedBatches = record.completedBatches;

  deps.onProgress({ videoId, status: 'translating', done: doneCount, total, step: 3 });

  function batchRange(batchIdx: number): [number, number] {
    return [batchIdx * BATCH_SIZE, Math.min((batchIdx + 1) * BATCH_SIZE, liveSegments.length)];
  }

  // ⚠️ RESUME UNDER CONCURRENCY: batches complete out of order, so
  // `completedBatches` (a `max`-advanced hint, Task 3) is never used to
  // decide what to (re)send — it would treat a later batch that raced ahead
  // of an earlier still-pending one as "already covered". Instead, pending
  // work is derived fresh from the ACTUAL stored segment state: a batch is
  // pending iff ANY segment in its index range still has
  // `translatedText === null`, checked directly against `liveSegments`
  // (which starts as a snapshot of `record.segments`, i.e. whatever a prior
  // run's upsertBatch calls already persisted). An already-fully-translated
  // batch is never re-dispatched at all — cheaper than relying solely on
  // upsertBatch's idempotency, though that idempotency is still what makes
  // a partial-response batch (some segments filled, some still null) safe
  // to retry on a later run without corrupting the segments upsertBatch
  // already wrote.
  const pendingBatchIndices: number[] = [];
  for (let b = 0; b < totalBatches; b += 1) {
    const [start, end] = batchRange(b);
    if (liveSegments.slice(start, end).some((seg) => seg.translatedText === null)) {
      pendingBatchIndices.push(b);
    }
  }

  const failures: BatchFailure[] = [];

  async function runBatch(batchIdx: number): Promise<void> {
    const [start, end] = batchRange(batchIdx);
    const segs = liveSegments.slice(start, end);

    let attempt = 0;
    for (;;) {
      const result = await deps.translateBatch(segs, glossary, key);

      if (result.ok) {
        const byIndex = new Map(result.translations.map((t) => [t.index, t.translatedText]));
        // A translatedText the model omitted for THIS call falls back to
        // whatever `seg` already had (possibly still null, possibly a
        // value a prior run's partial response already filled in) —
        // never regress an already-known-good translation to null.
        const translatedSegs = segs.map((seg) => ({
          ...seg,
          translatedText: byIndex.get(seg.index) ?? seg.translatedText,
        }));

        await deps.upsertBatch(videoId, batchIdx, translatedSegs);

        for (const seg of translatedSegs) {
          liveSegments[seg.index] = seg;
        }
        doneCount = countDone(liveSegments);
        completedBatches = Math.max(completedBatches, batchIdx + 1);
        deps.onProgress({ videoId, status: 'translating', done: doneCount, total, step: 3 });
        return;
      }

      if (result.reason === 'rate_limit' && attempt < BACKOFF_MS.length) {
        await deps.sleep(BACKOFF_MS[attempt]);
        attempt += 1;
        continue;
      }

      // Either a non-retryable error, or a rate_limit that exhausted its
      // retry budget. Policy: record the failure and CONTINUE processing
      // the other batches (one stuck batch should not stall/abort every
      // other segment's translation) — the pipeline as a whole is marked
      // failed below only after every batch has had its chance, and the
      // segments this batch would have covered simply stay untranslated
      // (translatedText: null), which is exactly what makes them "pending"
      // again for a future resume run.
      failures.push({ batchIdx, reason: result.reason, message: result.message });
      return;
    }
  }

  await runWithConcurrencyLimit(pendingBatchIndices, MAX_CONCURRENCY, runBatch);

  const allTranslated = liveSegments.every((seg) => seg.translatedText !== null);
  if (!allTranslated || failures.length > 0) {
    const failedRecord: TranslationRecord = {
      ...record,
      segments: liveSegments,
      glossary,
      completedBatches,
      totalBatches,
      status: 'failed',
      error: { step: 'translating', reason: summarizeFailures(failures) || 'Some segments did not translate' },
      updatedAt: new Date().toISOString(),
    };
    await deps.putTranslation(failedRecord);
    deps.onProgress({ videoId, status: 'failed', done: doneCount, total, step: 3 });
    return failedRecord;
  }

  // --- Step 4: consistency post-process + done --------------------------
  const consistentSegments = applyGlossaryConsistency(liveSegments, glossary);
  const finalRecord: TranslationRecord = {
    ...record,
    segments: consistentSegments,
    glossary,
    completedBatches,
    totalBatches,
    status: 'done',
    updatedAt: new Date().toISOString(),
  };
  delete finalRecord.error;
  await deps.putTranslation(finalRecord);
  deps.onProgress({ videoId, status: 'done', done: total, total, step: 4 });
  return finalRecord;
}
