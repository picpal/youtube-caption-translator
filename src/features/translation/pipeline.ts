import { captionHash, dedupeRows, reconstructSentences, rowsToSegments } from '~/lib/transcript-parse';
import { parseRetryDelayMs } from '~/lib/gemini';
import type { AnalyzeGlossaryResult, TranslateBatchResult } from '~/lib/gemini';
import type { TargetLang } from '~/lib/target-lang';
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
// translate SEQUENTIALLY in SW-lifetime-safe chunks with retryDelay-honoring
// 429 handling -> consistency post-process -> done. Every side-effecting
// collaborator is INJECTED via `deps` so this file never touches real
// Gemini/IndexedDB/Chrome/timers — `pipeline.test.ts` drives it entirely
// with mocks and an injectable `sleep`, and `entrypoints/background.ts`
// assembles the real `deps`.
//
// Refactor history:
// - R1 (refactor-single-request-brief.md) SUPERSEDED the original plan §4
//   "8-segment batches at concurrency 3" design, which fanned out into ~30+
//   requests for a 1hr video and blew straight through the free-tier ~RPM 5
//   limit — switched to sequential requests + stage-based progress.
// - R2 (refactor-r2-brief.md) TUNED R1: R1's own "fewest possible requests"
//   choice of 300 segments/chunk turned out to take 1-2min per request,
//   long enough for MV3 to evict the service worker mid-fetch and lose the
//   job. `MAX_SEGMENTS_PER_REQUEST` below is now sized to fit well inside
//   the SW's active-fetch lifetime instead.
// The per-chunk persistence/resume machinery below (`upsertBatch`, deriving
// pending work from `translatedText === null`, out-of-order-safe failure
// collection) is UNCHANGED across both — only the request SHAPE (chunk
// size, sequential instead of concurrent) and the retry/progress reporting
// around it changed.

/** Segments packed into a single `translateBatch` call ("chunk").
 *
 * Task R2 (see .superpowers/sdd/2026-07-28-m2-caption-translation/
 * refactor-r2-brief.md): R1 originally set this to `300` — "fewest possible
 * requests" — but real-Chrome DoD proved that NOT viable on MV3: a
 * 247-segment request takes 1-2min to generate (measured ~288ms/segment
 * with thinking on), and Chrome can evict the service worker mid-fetch,
 * losing the in-flight request with no way to resume it (a fetch is not
 * itself resumable — only the NEXT chunk's dispatch survives an eviction).
 * `50` keeps each request to ~50 × 288ms ≈ 15s, safely inside the SW's
 * active-fetch lifetime, while the per-chunk `onProgress` calls between
 * requests also reset Chrome's idle timer. A 1hr talk (~247 segments) is
 * now 5 sequential translation chunks + 1 glossary call ≈ 6 requests total —
 * still paced under the free-tier RPM by the existing retryDelay-honoring
 * backoff below, just no longer gambling the whole job on one giant
 * long-running fetch. */
export const MAX_SEGMENTS_PER_REQUEST = 50;

/** Bounded retry count for a `rate_limit` (429) chunk result (brief §3:
 * "2-3"). Picked the lower end deliberately: each retry now waits out the
 * SERVER'S OWN reported delay (often 40-60s on the free tier, see
 * `parseRetryDelayMs`/`MAX_RETRY_DELAY_MS` below), so 2 retries already
 * means a chunk can spend up to ~2 minutes waiting before it is recorded as
 * a failure — 3 would risk the pipeline stalling even longer for no better
 * odds of success once the free-tier quota is genuinely exhausted. */
export const MAX_RATE_LIMIT_RETRIES = 2;

/** Upper bound on how long a single rate-limit wait is allowed to be, even
 * if the server's own message asks for longer (brief §3: "capped at a sane
 * max, e.g. 65s"). */
export const MAX_RETRY_DELAY_MS = 65_000;

/** Fallback wait when a `rate_limit` result's message has no parseable
 * "retry in Ns" hint (`parseRetryDelayMs` returns `undefined`) — still a
 * real wait rather than an immediate retry, just without server-provided
 * guidance on how long. */
export const DEFAULT_RETRY_DELAY_MS = 5_000;

/**
 * Task R6 — real-Chrome DoD: `gemini-3.5-flash-lite` occasionally OMITS a
 * few indices from a large chunk's JSON response even though the call
 * itself succeeded (`ok:true`, no error) — a 247-segment video came back
 * 244/247 on an otherwise-flawless first attempt, hard-failing the whole
 * job with "Some segments did not translate" and forcing a manual retry.
 * That is a soft, benign gap (see `ChunkFailure`'s doc comment below for
 * the HARD-error case this is deliberately NOT for), so after the main
 * chunk loop, up to this many extra passes re-translate ONLY the
 * still-null segments that came from an otherwise-OK chunk — re-chunked by
 * `MAX_SEGMENTS_PER_REQUEST`, sequential, the same
 * `callWithRateLimitRetry`. Bounded (not "until it's perfect") because a
 * model that keeps omitting the SAME index pass after pass is unlikely to
 * suddenly stop on a 3rd/4th try, and this must stay a small tolerance
 * mechanism, not a new unbounded retry loop.
 */
export const MAX_COMPLETENESS_PASSES = 2;

/**
 * Task R6 — fraction of segments that must have a non-null
 * `translatedText` for the job to be reported `done` even if the
 * completeness passes above didn't fully close the gap. "95%+ translated
 * is a usable result; punishing the user with a full failure + manual
 * retry for 3 dropped segments is wrong" (brief). A `TranslationRecord`
 * with a translatedText of `null` on a few segments already renders
 * correctly — `TranscriptList` shows the English-only line for those, the
 * same fallback already used for a genuinely `failed` job's partial
 * progress.
 *
 * This threshold ONLY applies when there were NO hard chunk errors
 * (`failures.length === 0` — see `ChunkFailure` below): a hard error (rate
 * limit exhausted, network, truncated, bad_json) always fails the job
 * regardless of how high the completeness ratio happens to be otherwise —
 * it is a real problem, not model noise, and deserves the visible
 * fail+retry affordance rather than being silently tolerated.
 */
export const COMPLETENESS_THRESHOLD = 0.95;

export interface TranslationPipelineDeps {
  /** Asks the content script on `tabId` for the raw transcript rows of
   * `videoId` (background -> content `REQUEST_TRANSCRIPT`, Task 4). */
  requestTranscript: (tabId: number, videoId: string) => Promise<RequestTranscriptResponse>;
  analyzeGlossary: (fullText: string, key: string, targetLang: TargetLang) => Promise<AnalyzeGlossaryResult>;
  translateBatch: (
    segs: TranscriptSegment[],
    glossary: GlossaryEntry[],
    key: string,
    targetLang: TargetLang,
  ) => Promise<TranslateBatchResult>;
  getTranslation: (videoId: string) => Promise<TranslationRecord | null>;
  putTranslation: (rec: TranslationRecord) => Promise<void>;
  upsertBatch: (videoId: string, batchIdx: number, segs: TranscriptSegment[]) => Promise<void>;
  /** Injectable so retry/rate-limit waits are instant in tests — never a
   * bare `setTimeout` call inside this file. */
  sleep: (ms: number) => Promise<void>;
  /** Fired at every stage transition (step 1-4), plus, during step 3, once
   * per chunk sub-phase (`sending`/`receiving`/`parsing`) and once more when
   * a chunk finishes persisting. Fire-and-forget from this file's point of
   * view — the pipeline does not await or react to it. */
  onProgress: (progress: TranslationProgress) => void;
}

export interface RunTranslationPipelineParams {
  videoId: string;
  tabId: number;
  key: string;
  targetLang: TargetLang;
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

/** A HARD failure only — a whole `translateBatch` call for `chunkIdx` came
 * back `ok:false` (rate limit exhausted, network, truncated, bad_json) or
 * its `upsertBatch` durability write rejected. Deliberately does NOT cover
 * a chunk that came back `ok:true` but simply omitted an index from its
 * response array (Task R6's "soft omission") — that case is handled
 * separately by the completeness passes (`MAX_COMPLETENESS_PASSES` above),
 * and a segment left null for THAT reason must never end up counted here:
 * this array's mere non-emptiness is what forces the job to `status:
 * 'failed'` regardless of how few segments it actually affects. */
interface ChunkFailure {
  chunkIdx: number;
  reason: string;
  message: string;
}

function summarizeFailures(failures: ChunkFailure[]): string {
  return failures.map((f) => `chunk ${f.chunkIdx}: ${f.reason} (${f.message})`).join('; ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fix round (2026-07-29 task-brief.md, "transcript 열기 로직 SPA-상태
 * 견고화") — the `reason` string recorded on a `failed` `TranslationRecord`
 * when `requestTranscript` comes back `{ unavailable: true }`, split by WHY
 * (src/types/message.ts's `RequestTranscriptResponse`):
 * - `'no-panel'` (or no `reason` at all — see the `undefined` case below):
 *   the video genuinely has no transcript engagement panel. Keeps the EXACT
 *   pre-existing literal (`error-display.ts`'s Korean mapping keys off it).
 * - `'open-failed'`: the panel/signal DID exist, but content.ts's
 *   `openTranscriptPanel` strategy ladder exhausted its 30s budget without
 *   ever populating rows — this is the field bug this fix round addresses
 *   (a captioned video was misreported with the `'no-panel'` message above),
 *   so it gets its own honest string rather than being folded into that one.
 *
 * `reason: undefined` (an older/back-compat `{unavailable:true}` with no
 * `reason` field) is handled the SAME as `'no-panel'` on purpose — that was
 * this function's only behavior before `reason` existed, and nothing about
 * this fix changes what an absent reason means.
 *
 * The `default` branch's `never` assignment is an exhaustiveness guard: a
 * third `RequestTranscriptResponse` reason value would fail to compile here
 * instead of silently falling through to the wrong message.
 */
function unavailableReasonMessage(reason: 'no-panel' | 'open-failed' | undefined): string {
  switch (reason) {
    case 'open-failed':
      return 'Transcript panel failed to open';
    case 'no-panel':
    case undefined:
      return 'No transcript panel available for this video';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** Shared shape both `AnalyzeGlossaryResult` and `TranslateBatchResult`'s
 * failure branches satisfy — enough for the retry helper below to inspect
 * `reason`/`message`/`retryDelayMs` generically without depending on either
 * concrete type. */
interface RetryableFailure {
  ok: false;
  reason: string;
  message: string;
  retryDelayMs?: number;
}

/**
 * Task R3 — the SAME retryDelay-honoring 429 retry logic, factored out so
 * both the glossary call (step 2) and each translate chunk (step 3) share
 * it rather than duplicating the wait-calculation. On a `rate_limit`
 * result, waits `parseRetryDelayMs(message) ?? retryDelayMs ??
 * DEFAULT_RETRY_DELAY_MS`, capped at `MAX_RETRY_DELAY_MS`, and retries up to
 * `MAX_RATE_LIMIT_RETRIES` times. Any other failure reason (or a `rate_limit`
 * that has exhausted its retry budget) is returned as-is — this helper never
 * decides what a failure MEANS, only whether to try again.
 *
 * `attempt` is called fresh on every try (not memoized) so a caller that
 * needs to react per-attempt — the chunk loop's own `sending` progress
 * event, fired before each individual request — can do so from inside it.
 */
async function callWithRateLimitRetry<T extends { ok: true } | RetryableFailure>(
  deps: TranslationPipelineDeps,
  attempt: () => Promise<T>,
): Promise<T> {
  let tries = 0;
  for (;;) {
    const result = await attempt();
    if (result.ok) return result;
    if (result.reason !== 'rate_limit' || tries >= MAX_RATE_LIMIT_RETRIES) return result;

    const delayMs = Math.min(
      parseRetryDelayMs(result.message) ?? result.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      MAX_RETRY_DELAY_MS,
    );
    await deps.sleep(delayMs);
    tries += 1;
  }
}

// Best-effort persist: swallows a rejection rather than letting it escape as
// an unhandled promise rejection. Used only where the write is NOT
// load-bearing for the rest of this run (the two TERMINAL writes below, and
// failPipeline's own write) — by the time these run, the pipeline's real
// work is already done (or already being reported as failed), so a broken
// DB write here must not turn "translation succeeded" into "the whole
// pipeline promise rejects." The caller always gets the correct in-memory
// TranslationRecord back either way, even if this particular write didn't
// durably land.
async function persistBestEffort(deps: TranslationPipelineDeps, rec: TranslationRecord): Promise<void> {
  try {
    await deps.putTranslation(rec);
  } catch {
    // Nothing further to do — see comment above.
  }
}

async function failPipeline(
  deps: TranslationPipelineDeps,
  videoId: string,
  targetLang: TargetLang,
  errorStep: TranslationStatus,
  progressStep: 1 | 2 | 3,
  reason: string,
  base?: TranslationRecord,
): Promise<TranslationRecord> {
  const now = new Date().toISOString();
  // `base` (a preserved prior record) already carries its OWN stamped
  // targetLang via the spread — never overwritten here by this attempt's
  // `targetLang` param, same "preserve the prior good record" discipline as
  // every other field on that branch. Only the base-less fresh-failure
  // literal stamps the incoming `targetLang` directly.
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
        targetLang,
        error: { step: errorStep, reason },
        createdAt: now,
        updatedAt: now,
      };
  await persistBestEffort(deps, rec);
  deps.onProgress({
    videoId,
    status: 'failed',
    step: progressStep,
    // Best-effort chunk counts for a step-1/2 failure: `rec.totalBatches` is
    // only meaningfully nonzero here when `base` (a preserved prior record)
    // already had chunk progress from an earlier attempt — a fresh failure
    // has nothing chunk-level to report yet, which is exactly what 0/0 conveys.
    chunkIndex: rec.completedBatches,
    totalChunks: rec.totalBatches,
  });
  return rec;
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Step 4 ("일관성", plan §4) — a PURE post-process, no extra Gemini call.
 * `translateBatch`'s prompt already tells the model to reuse each glossary
 * term's translation (src/lib/gemini.ts's `translationRulesFor`), but that
 * is only a prompt-level convention: nothing stops the model from leaving a
 * term untranslated in one batch while translating it correctly in
 * another, since every batch is an independent call. This pass corrects
 * exactly that leftover-English case deterministically: for every
 * `keepOriginal:false` glossary entry whose term appears in a segment's
 * `sourceText`, if that segment's `translatedText` contains the literal
 * English term as a standalone token AND does NOT already contain the
 * glossary's canonical Korean translation anywhere, every such occurrence of
 * the term is replaced with that translation.
 *
 * Two guards, both fixed after review-round-1 caught real corruption cases:
 * - `text.includes(entry.translation)` — `TRANSLATION_RULES` (gemini.ts)
 *   also tells the model it may "add the English term in parentheses when
 *   it helps clarity", e.g. `"리액트(React)를 사용합니다"`. That string
 *   already contains BOTH the Korean translation and the bare English term —
 *   without this guard, the old code rewrote it to `"리액트(리액트)를..."`,
 *   corrupting an already-correct translation. If the canonical Korean form
 *   is present anywhere in the text, the term was handled; leave it alone.
 * - `\b...\b` word-boundary anchors — without them, a short term like
 *   `"Go"` matched as a bare substring inside `"Google"`/`"ago"`. JS's `\b`
 *   is defined against `\w` ([A-Za-z0-9_]), and Korean characters are NOT
 *   `\w`, so the boundary still fires correctly at an English-term/Korean
 *   transition with no whitespace needed (e.g. `"React훅"` still matches
 *   `\bReact\b`) — the anchors are only weak for terms glued to OTHER
 *   ASCII word characters, which is an acceptable, rare false-negative for
 *   a best-effort safety net.
 *
 * Segments where the model already used the Korean translation (with or
 * without a parenthetical English echo) are untouched. `keepOriginal:true`
 * entries are intentionally left alone — the term is SUPPOSED to stay in
 * the original language, so there is nothing to unify.
 */
export function applyGlossaryConsistency(
  segments: TranscriptSegment[],
  glossary: GlossaryEntry[],
): TranscriptSegment[] {
  const rewritable = glossary.filter((entry) => !entry.keepOriginal && entry.term.trim().length > 0);
  if (rewritable.length === 0) return segments;

  return segments.map((seg) => {
    if (seg.translatedText === null) return seg;
    let text = seg.translatedText;
    for (const entry of rewritable) {
      const escaped = escapeRegExp(entry.term);
      const testRe = new RegExp(`\\b${escaped}\\b`, 'i');
      if (!testRe.test(seg.sourceText)) continue;
      if (!testRe.test(text)) continue; // nothing left in English to fix here
      if (text.includes(entry.translation)) continue; // already has the canonical Korean form
      const replaceRe = new RegExp(`\\b${escaped}\\b`, 'gi');
      text = text.replace(replaceRe, entry.translation);
    }
    return text === seg.translatedText ? seg : { ...seg, translatedText: text };
  });
}

export async function runTranslationPipeline(
  params: RunTranslationPipelineParams,
  deps: TranslationPipelineDeps,
): Promise<TranslationRecord> {
  const { videoId, tabId, key, targetLang } = params;

  // --- Step 1: extract -------------------------------------------------
  deps.onProgress({ videoId, status: 'extracting', step: 1, chunkIndex: 0, totalChunks: 0 });

  // Read whatever is currently persisted for this video FIRST, before any
  // extraction work — moved up front (final-review fix) specifically so a
  // TRANSIENT failure below (unreachable content script, no transcript
  // panel on THIS attempt, a malformed timestamp) can pass it as `base` to
  // `failPipeline` and PRESERVE a prior good record's segments/glossary/
  // captionHash instead of clobbering it with an empty one.
  //
  // This matters once a `done` video can be re-run at all (Task 10's
  // "다시 생성" button, or an auto-resume of an in-progress record):
  // re-running re-scrapes the transcript panel first, and the scraper's own
  // documented contract (docs/youtube-transcript-findings.md) is that a
  // post-SPA panel reopen can transiently fail (ghost-cards, 30s timeout ->
  // `{unavailable:true}`). Without preserving `existing` here, that one
  // flaky re-scrape would permanently destroy an already-fully-translated
  // cached record (breaking "revisit -> instant cache load") or wipe an
  // in-progress record's already-persisted batches. A fresh video
  // (`existing === null`) is unaffected — `failPipeline` with no `base`
  // behaves exactly as before.
  let existing: TranslationRecord | null;
  try {
    existing = await deps.getTranslation(videoId);
  } catch (err) {
    // Nothing persisted (or unreadable) — no `base` to preserve here, same
    // as every other base-less failPipeline call below.
    return failPipeline(deps, videoId, targetLang, 'analyzing', 2, `Could not read cached translation: ${errorMessage(err)}`);
  }

  let rawResult: RequestTranscriptResponse;
  try {
    rawResult = await deps.requestTranscript(tabId, videoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failPipeline(
      deps,
      videoId,
      targetLang,
      'extracting',
      1,
      `Could not reach content script: ${message}`,
      existing ?? undefined,
    );
  }

  if (!Array.isArray(rawResult)) {
    // `{unavailable:true}` — no transcript engagement panel at all (PRD §9
    // 실패 상태), or (for a re-run) a transient post-SPA reopen flake — see
    // the `existing` comment above for why this is passed as `base` rather
    // than dropped. Clean failure, not a crash: there is nothing new to
    // parse or hash, so this short-circuits before the cache/resume logic
    // below, which needs a freshly-computed captionHash to key off of.
    // The reason string itself is now split by `reason` — see
    // `unavailableReasonMessage`'s own doc comment above.
    return failPipeline(
      deps,
      videoId,
      targetLang,
      'extracting',
      1,
      unavailableReasonMessage(rawResult.reason),
      existing ?? undefined,
    );
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
    return failPipeline(
      deps,
      videoId,
      targetLang,
      'extracting',
      1,
      `Failed to parse transcript: ${message}`,
      existing ?? undefined,
    );
  }

  const fullText = segments.map((seg) => seg.sourceText).join('\n');
  const hash = captionHash(fullText);
  // Named `totalChunks` (not `totalBatches`) at this call site on purpose —
  // this IS the same number as the persisted record's `totalBatches` field
  // (schema unchanged, brief §5), just under the name this refactor uses for
  // it everywhere outside the record shape itself.
  const totalChunks = segments.length === 0 ? 0 : Math.ceil(segments.length / MAX_SEGMENTS_PER_REQUEST);

  // --- Step 2: cache/resume decision ------------------------------------
  // The two language rules (brief "Resume consistency" / "Mismatch
  // restart" — record state decides which one applies):
  // - a NON-terminal existing record (`analyzing`/`translating` — the job
  //   was interrupted mid-flight, e.g. SW eviction) ALWAYS resumes in ITS
  //   OWN stamped language, regardless of the incoming `targetLang` param.
  // - a TERMINAL existing record (`done`/`failed`) whose stamped language
  //   differs from the incoming param is treated as ABSENT: full fresh
  //   start below, no glossary/batch reuse, stamped with the incoming
  //   `targetLang` — a differing language on a terminal record means the
  //   user deliberately switched settings and wants a fresh result.
  // `effectiveTargetLang` is assigned once here and used for every
  // prompt/stamp call below, per the resume rule.
  let usableExisting: TranslationRecord | null =
    existing !== null && existing.captionHash === hash ? existing : null;
  let effectiveTargetLang = targetLang;
  if (usableExisting !== null) {
    const recordLang = usableExisting.targetLang ?? 'ko';
    if (usableExisting.status === 'analyzing' || usableExisting.status === 'translating') {
      effectiveTargetLang = recordLang; // non-terminal: resume rule wins, regardless of `targetLang`
    } else if (recordLang !== targetLang) {
      usableExisting = null; // terminal (done/failed) + language mismatch: mismatch-restart rule
    }
  }

  if (usableExisting !== null && usableExisting.status === 'done') {
    // Same captions, same language, already fully translated — reuse as-is, no re-work.
    deps.onProgress({
      videoId,
      status: 'done',
      step: 4,
      chunkIndex: usableExisting.totalBatches,
      totalChunks: usableExisting.totalBatches,
    });
    return usableExisting;
  }

  // Same captionHash, same-or-resumable language, but not done (any
  // non-'done' status, including a previous 'failed' — a prior failure may
  // still have persisted partial batch progress worth keeping) -> RESUME.
  // Different hash, a mismatch-restarted terminal record, or no record at
  // all -> fresh skeleton, persisted FIRST (before any batch work) so
  // upsertBatch (Task 3: throws on an absent record) always has something
  // to merge into.
  const resuming = usableExisting !== null;
  let record: TranslationRecord;
  if (resuming) {
    record = usableExisting as TranslationRecord;
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
      totalBatches: totalChunks,
      targetLang: effectiveTargetLang,
      createdAt: now,
      updatedAt: now,
    };
    // Load-bearing: `upsertBatch` (Task 3) THROWS if no record exists yet
    // for this videoId, so a failure to persist THIS skeleton must halt the
    // pipeline here rather than silently continue into batch work that
    // would cascade into every subsequent upsertBatch call also failing.
    try {
      await deps.putTranslation(record);
    } catch (err) {
      return failPipeline(deps, videoId, effectiveTargetLang, 'analyzing', 2, `Could not persist translation record: ${errorMessage(err)}`, record);
    }
  }

  // Review fix: unify on the freshly-recomputed `totalChunks` (in scope
  // since the extract step above) rather than `record.totalBatches` — same
  // value in-version, but `record.totalBatches` is what a STALE
  // pre-refactor-format persisted record would carry on a resume (computed
  // under the old 8-segment-batch math), which must never leak into a
  // live progress event.
  let completedChunks = record.completedBatches;

  // --- Step 2 (progress) / glossary analysis ----------------------------
  deps.onProgress({
    videoId,
    status: 'analyzing',
    step: 2,
    chunkIndex: completedChunks,
    totalChunks,
  });

  let glossary: GlossaryEntry[];
  if (resuming && glossaryResolved(record)) {
    glossary = record.glossary;
  } else {
    // Task R3: same retryDelay-honoring retry as translate chunks (real-
    // Chrome DoD found a single 429 here used to fail the WHOLE pipeline in
    // ~3s with no wait, even though the server's own message asked for a
    // 53s retry). AND, if it still fails after retries (rate_limit
    // exhausted, or any other error) — NON-FATAL: the glossary is a
    // consistency aid, not required for `translateBatch` (which already
    // handles an empty glossary as a no-op, see `buildGlossaryBlock` in
    // gemini.ts). Translation is the core deliverable and must not be
    // killed by a glossary hiccup.
    const glossaryResult = await callWithRateLimitRetry(deps, () =>
      deps.analyzeGlossary(fullText, key, effectiveTargetLang),
    );
    if (glossaryResult.ok) {
      glossary = glossaryResult.glossary;
    } else {
      console.warn(
        `[translation pipeline] glossary analysis failed for ${videoId}, proceeding with an empty glossary: ${glossaryResult.reason} (${glossaryResult.message})`,
      );
      glossary = [];
    }
    record = { ...record, status: 'translating', glossary, updatedAt: new Date().toISOString() };
    try {
      await deps.putTranslation(record);
    } catch (err) {
      return failPipeline(deps, videoId, effectiveTargetLang, 'analyzing', 2, `Could not persist glossary: ${errorMessage(err)}`, record);
    }
  }

  // --- Step 3: translate SEQUENTIALLY in large chunks, honoring the
  // server's own retry-after delay on a 429 ------------------------------
  // `liveSegments` is this run's in-memory mirror of the record's segments,
  // kept index-aligned with `record.segments` (rowsToSegments assigns
  // contiguous `index` 0..n-1 in array order, and upsertBatch/db.ts's merge
  // preserves that order, so `liveSegments[i].index === i` holds). Mutating
  // this array (rather than re-reading `deps.getTranslation` after every
  // chunk) is safe now for an even simpler reason than before: chunks run
  // one at a time, so there is no interleaving to reason about at all.
  const liveSegments = record.segments.slice();

  deps.onProgress({ videoId, status: 'translating', step: 3, chunkIndex: completedChunks, totalChunks });

  function chunkRange(chunkIdx: number): [number, number] {
    return [
      chunkIdx * MAX_SEGMENTS_PER_REQUEST,
      Math.min((chunkIdx + 1) * MAX_SEGMENTS_PER_REQUEST, liveSegments.length),
    ];
  }

  // Pending work is derived fresh from the ACTUAL stored segment state (not
  // from `completedBatches`, a `max`-advanced hint): a chunk is pending iff
  // ANY segment in its index range still has `translatedText === null`,
  // checked directly against `liveSegments` (a snapshot of `record.segments`,
  // i.e. whatever a prior run's upsertBatch calls already persisted). An
  // already-fully-translated chunk is never re-sent at all — cheaper than
  // relying solely on upsertBatch's idempotency, though that idempotency is
  // still what makes a partial-response chunk (some segments filled, some
  // still null) safe to retry on a later run without corrupting the
  // segments upsertBatch already wrote. (Chunks now run strictly in order,
  // one at a time, but pending indices can still be non-contiguous on a
  // resume — e.g. chunk 0 pending, chunk 1 already done from a prior run.)
  const pendingChunkIndices: number[] = [];
  for (let c = 0; c < totalChunks; c += 1) {
    const [start, end] = chunkRange(c);
    if (liveSegments.slice(start, end).some((seg) => seg.translatedText === null)) {
      pendingChunkIndices.push(c);
    }
  }

  const failures: ChunkFailure[] = [];

  async function runChunk(chunkIdx: number): Promise<void> {
    const [start, end] = chunkRange(chunkIdx);
    const segs = liveSegments.slice(start, end);

    // Task R3: the retry/backoff itself is now the SHARED
    // `callWithRateLimitRetry` helper (also used by the glossary call
    // above) — `attempt` fires the `sending` progress event fresh on every
    // try (including retries), since that's a per-request signal the shared
    // helper itself has no opinion on.
    const result = await callWithRateLimitRetry(deps, () => {
      deps.onProgress({
        videoId,
        status: 'translating',
        step: 3,
        phase: 'sending',
        chunkIndex: completedChunks,
        totalChunks,
      });
      return deps.translateBatch(segs, glossary, key, effectiveTargetLang);
    });

    if (!result.ok) {
      // Either a non-retryable error (including the truncation guard's
      // `'truncated'`/`'bad_json'` reasons — never retried, brief §2: "no
      // auto re-split required"), or a rate_limit that exhausted its retry
      // budget. Policy: record the failure and CONTINUE processing the
      // other chunks (one stuck chunk should not abort every other
      // segment's translation) — the pipeline as a whole is marked failed
      // below only after every chunk has had its chance, and the segments
      // this chunk would have covered simply stay untranslated
      // (translatedText: null), which is exactly what makes them "pending"
      // again for a future resume run.
      failures.push({ chunkIdx, reason: result.reason, message: result.message });
      return;
    }

    deps.onProgress({
      videoId,
      status: 'translating',
      step: 3,
      phase: 'receiving',
      chunkIndex: completedChunks,
      totalChunks,
    });

    const byIndex = new Map(result.translations.map((t) => [t.index, t.translatedText]));
    // A translatedText the model omitted for THIS call falls back to
    // whatever `seg` already had (possibly still null, possibly a
    // value a prior run's partial response already filled in) —
    // never regress an already-known-good translation to null.
    const translatedSegs = segs.map((seg) => ({
      ...seg,
      translatedText: byIndex.get(seg.index) ?? seg.translatedText,
    }));

    deps.onProgress({
      videoId,
      status: 'translating',
      step: 3,
      phase: 'parsing',
      chunkIndex: completedChunks,
      totalChunks,
    });

    try {
      await deps.upsertBatch(videoId, chunkIdx, translatedSegs);
    } catch (err) {
      // The chunk's own durability guarantee failed — do NOT mirror the
      // translated result into `liveSegments` as if it were safely
      // saved (it may not be, if the DB is genuinely broken). Recorded
      // as a chunk failure via the SAME mechanism as a translateBatch
      // error, so it surfaces through the existing "any failure ->
      // overall status:'failed'" path below rather than rejecting this
      // function (and with it, the whole pipeline promise).
      failures.push({ chunkIdx, reason: 'unknown', message: `upsertBatch rejected: ${errorMessage(err)}` });
      return;
    }

    for (const seg of translatedSegs) {
      liveSegments[seg.index] = seg;
    }
    // `Math.max`, not a plain increment: on a resume, `pendingChunkIndices`
    // can be a non-contiguous subset (e.g. chunk 1 already done, only
    // chunks 0 and 2 pending) — a plain `+= 1` would double-count past
    // whatever the seeded `record.completedBatches` hint already
    // credited. This mirrors the pre-refactor batch loop's own
    // resume-safe formula, just walked sequentially instead of by
    // out-of-order completion.
    completedChunks = Math.max(completedChunks, chunkIdx + 1);
    // Chunk fully done and persisted — no `phase` (nothing is
    // in-flight right now), `chunkIndex` advanced.
    deps.onProgress({ videoId, status: 'translating', step: 3, chunkIndex: completedChunks, totalChunks });
  }

  // Sequential, one chunk at a time (never concurrent) — the free-tier RPM
  // limit that motivated this refactor never has more than one translate
  // request in flight at once.
  for (const chunkIdx of pendingChunkIndices) {
    await runChunk(chunkIdx);
  }

  // --- Task R6: bounded completeness passes for SOFT-omitted segments ---
  // A segment can still be null here for two very different reasons: its
  // chunk hard-failed (already in `failures`, tracked by chunk INDEX
  // RANGE), or its chunk came back `ok:true` but the model just dropped
  // that one index. Only the latter is worth retrying — re-attempting a
  // hard-failed chunk's segments here would blur `failures`' meaning (see
  // its own doc comment) and duplicate work the main loop's resume path
  // already owns.
  const hardFailedSegmentIndices = new Set<number>();
  for (const failure of failures) {
    const [start, end] = chunkRange(failure.chunkIdx);
    for (let i = start; i < end; i += 1) hardFailedSegmentIndices.add(i);
  }

  function softOmittedSegments(): TranscriptSegment[] {
    return liveSegments.filter(
      (seg) => seg.translatedText === null && !hardFailedSegmentIndices.has(seg.index),
    );
  }

  for (let pass = 0; pass < MAX_COMPLETENESS_PASSES; pass += 1) {
    const pending = softOmittedSegments();
    if (pending.length === 0) break; // fully caught up — stop early, no wasted calls

    // Re-chunked by MAX_SEGMENTS_PER_REQUEST like any other translate call,
    // but over the (usually tiny) set of leftover indices rather than a
    // contiguous range — `translateBatch`/`upsertBatch` don't care that
    // these indices may be non-contiguous, only `db.ts`'s upsertBatch's
    // by-`index` merge, which already works this way for every chunk.
    for (let i = 0; i < pending.length; i += MAX_SEGMENTS_PER_REQUEST) {
      const segs = pending.slice(i, i + MAX_SEGMENTS_PER_REQUEST);

      const result = await callWithRateLimitRetry(deps, () =>
        deps.translateBatch(segs, glossary, key, effectiveTargetLang),
      );
      if (!result.ok) continue; // still not translated — left null; NOT added to `failures` (see R6 doc comments above)

      const byIndex = new Map(result.translations.map((t) => [t.index, t.translatedText]));
      const translatedSegs = segs.map((seg) => ({
        ...seg,
        translatedText: byIndex.get(seg.index) ?? seg.translatedText,
      }));

      try {
        // `totalChunks + pass`: an out-of-range, pass-distinguishing
        // batchIdx — safe because upsertBatch (db.ts) merges `segs` by
        // segment `index`, never by batchIdx position; batchIdx only ever
        // feeds `completedBatches`, itself just a resume HINT (see the
        // main loop's own comment on this).
        await deps.upsertBatch(videoId, totalChunks + pass, translatedSegs);
      } catch {
        continue; // durability failure — do not mirror into liveSegments as saved
      }

      for (const seg of translatedSegs) {
        liveSegments[seg.index] = seg;
      }
    }
  }

  const translatedCount = liveSegments.filter((seg) => seg.translatedText !== null).length;
  const totalSegments = liveSegments.length;
  // Vacuously complete for an empty transcript, matching the pre-R6
  // behavior of `liveSegments.every(...)` on an empty array.
  const completeness = totalSegments === 0 ? 1 : translatedCount / totalSegments;
  const hasHardFailures = failures.length > 0;

  if (hasHardFailures || completeness < COMPLETENESS_THRESHOLD) {
    // A hard failure's reason is always the authoritative one when present
    // (brief: hard errors force `failed` regardless of completeness); only
    // when there ISN'T one does the completeness shortfall get its own,
    // clearer message instead of the generic fallback.
    const reason = hasHardFailures
      ? summarizeFailures(failures) || 'Some segments did not translate'
      : `Only ${translatedCount}/${totalSegments} segments translated (${Math.round(completeness * 100)}%) — below the ${Math.round(COMPLETENESS_THRESHOLD * 100)}% completeness threshold`;
    const failedRecord: TranslationRecord = {
      ...record,
      segments: liveSegments,
      glossary,
      completedBatches: completedChunks,
      totalBatches: totalChunks,
      status: 'failed',
      error: { step: 'translating', reason },
      updatedAt: new Date().toISOString(),
    };
    await persistBestEffort(deps, failedRecord);
    deps.onProgress({ videoId, status: 'failed', step: 3, chunkIndex: completedChunks, totalChunks });
    return failedRecord;
  }

  // --- Step 4: consistency post-process + done --------------------------
  // R6: `done` here can still carry a handful of `translatedText: null`
  // segments (≤5% of the total) — TranscriptList already renders those as
  // English-only, the same fallback a genuinely `failed` job's partial
  // progress uses.
  const consistentSegments = applyGlossaryConsistency(liveSegments, glossary);
  const finalRecord: TranslationRecord = {
    ...record,
    segments: consistentSegments,
    glossary,
    completedBatches: completedChunks,
    totalBatches: totalChunks,
    status: 'done',
    updatedAt: new Date().toISOString(),
  };
  delete finalRecord.error;
  await persistBestEffort(deps, finalRecord);
  deps.onProgress({ videoId, status: 'done', step: 4, chunkIndex: totalChunks, totalChunks });
  return finalRecord;
}
