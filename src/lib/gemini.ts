import type { GeminiTestResult } from '~/types/message';
import type { GlossaryEntry, TranscriptSegment } from '~/types/transcript';

// Task R5 — switched from `gemini-3.6-flash`: real-Chrome DoD found
// mandatory thinking on that model explodes on the rules-heavy translation
// prompt (a single 50-segment chunk took 150s+ and stalled). Measured
// `gemini-3.5-flash-lite`: 5.8s for 40 segments, `thoughtsTokenCount: 0`,
// `finishReason: STOP` — ~25x faster, zero thinking. Translation needs no
// reasoning, just a rules-following format transform, so lite is strictly
// better here for both speed and free-tier headroom.
export const MODEL_ID = 'gemini-3.5-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

interface GeminiCallOptions {
  fetchImpl?: typeof fetch;
}

interface GeminiErrorBody {
  error?: {
    message?: string;
    // Structured retry hint Gemini's REST error body can carry alongside
    // (or instead of) the human-readable `message` — one `details[]` entry
    // whose `@type` identifies it as a `RetryInfo`, with `retryDelay` a
    // protobuf Duration string like `"56s"`/`"56.5s"`.
    details?: Array<{ '@type'?: string; retryDelay?: string }>;
  };
}

// Shared status/message -> reason classification, extracted out of
// testGeminiKey's original inline logic so analyzeGlossary and
// translateBatch below classify errors identically instead of drifting.
export type GeminiErrorReason = 'unauthorized' | 'rate_limit' | 'network' | 'unknown';

export function classifyGeminiError(
  status: number,
  message: string,
): { reason: GeminiErrorReason; message: string } {
  if (status === 401 || status === 403) {
    return { reason: 'unauthorized', message };
  }
  if (status === 429) {
    return { reason: 'rate_limit', message };
  }
  return { reason: 'unknown', message };
}

export function classifyFetchError(err: unknown): { reason: 'network'; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { reason: 'network', message };
}

// Task R4 — hard timeout on every Gemini fetch. entrypoints/background.ts's
// SW keepalive now spans a translation pipeline's whole run specifically so
// a legitimately slow-but-eventually-successful request survives — but
// without an upper bound, a genuinely HUNG request (network black hole, a
// server that never responds at all) would keep the service worker alive
// forever right along with it. `AbortController.abort()` past this many ms
// rejects the fetch, which flows through the SAME `classifyFetchError` path
// as any other network failure — callers never see anything special, just
// an ordinary `reason:'network'` result (non-fatal for the glossary call
// via its retry+fallback; recorded as a non-retryable chunk failure for
// translation, same as any other `'network'` reason — `'network'` isn't
// `'rate_limit'`, so `callWithRateLimitRetry`, pipeline.ts, does not retry
// it, and the chunk simply stays pending for a future resume).
export const GEMINI_FETCH_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function testGeminiKey(
  key: string,
  opts: GeminiCallOptions = {},
): Promise<GeminiTestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: 'ping' }] }],
    generationConfig: { maxOutputTokens: 8 },
  });

  const started = performance.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch (err) {
    return { ok: false, ...classifyFetchError(err) };
  }
  const latencyMs = Math.round(performance.now() - started);

  if (response.ok) {
    return { ok: true, latencyMs, model: MODEL_ID };
  }

  const errorBody = await response.json().catch(() => ({} as GeminiErrorBody)) as GeminiErrorBody;
  const message = errorBody.error?.message ?? `HTTP ${response.status}`;
  return { ok: false, ...classifyGeminiError(response.status, message) };
}

// ---------------------------------------------------------------------------
// Shared plumbing for the two JSON-mode calls below (analyzeGlossary,
// translateBatch). testGeminiKey deliberately does NOT go through this: it
// only needs latency + ok/not-ok, never a parsed response body.
// ---------------------------------------------------------------------------

type GeminiCallResult =
  | { ok: true; text: string; finishReason?: string }
  | { ok: false; reason: GeminiErrorReason; message: string; retryDelayMs?: number };

function extractGeminiCandidate(
  data: unknown,
): { text?: string; finishReason?: string } {
  const candidate = (
    data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: unknown }> } | null
  )?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  const finishReason = candidate?.finishReason;
  return {
    text: typeof text === 'string' ? text : undefined,
    finishReason: typeof finishReason === 'string' ? finishReason : undefined,
  };
}

function secondsToMs(rawSeconds: string): number | undefined {
  const seconds = Number.parseFloat(rawSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

// Parses the free-tier rate-limit wait hint Gemini embeds in its 429 error
// message text — e.g. "... Please retry in 55.5s." — into milliseconds.
// This is the PRIMARY retry-delay source used by pipeline.ts's chunk retry
// loop (brief §3): every free-tier 429 observed in the field carries this
// exact wording. Returns `undefined` (never throws) when the message has no
// parseable hint, so callers can fall back to the structured
// `retryDelayMs` below, then a fixed default delay.
export function parseRetryDelayMs(message: string): number | undefined {
  const match = message.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!match) return undefined;
  return secondsToMs(match[1]);
}

// Structured fallback for a 429 whose `message` text has no parseable "retry
// in Ns" number (e.g. a bare "Resource has been exhausted") — reads the same
// wait time from `error.details[]`'s `RetryInfo` entry instead. Review fix:
// without this, such a response fell back to `DEFAULT_RETRY_DELAY_MS` (5s)
// regardless of how long the server actually asked for, which for a real
// 40-60s free-tier quota window reproduces the exact failure this refactor
// exists to kill.
function extractStructuredRetryDelayMs(errorBody: GeminiErrorBody): number | undefined {
  const details = errorBody.error?.details;
  if (!Array.isArray(details)) return undefined;
  const retryInfo = details.find(
    (d) => typeof d?.['@type'] === 'string' && d['@type'].includes('RetryInfo') && typeof d?.retryDelay === 'string',
  );
  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay !== 'string') return undefined;
  const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return undefined;
  return secondsToMs(match[1]);
}

async function callGeminiJson(
  key: string,
  requestBody: unknown,
  fetchImpl: typeof fetch,
): Promise<GeminiCallResult> {
  const url = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    return { ok: false, ...classifyFetchError(err) };
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({} as GeminiErrorBody)) as GeminiErrorBody;
    const message = errorBody.error?.message ?? `HTTP ${response.status}`;
    const classified = classifyGeminiError(response.status, message);
    // Structured retryDelayMs is only meaningful for a rate_limit result —
    // attaching it unconditionally would be harmless but misleading for
    // every other reason, so it's scoped to that branch.
    if (classified.reason === 'rate_limit') {
      return { ok: false, ...classified, retryDelayMs: extractStructuredRetryDelayMs(errorBody) };
    }
    return { ok: false, ...classified };
  }

  const data = await response.json().catch(() => null);
  const { text, finishReason } = extractGeminiCandidate(data);
  if (text === undefined) {
    return { ok: false, reason: 'unknown', message: 'Gemini response had no candidates' };
  }
  return { ok: true, text, finishReason };
}

// Defensive JSON parse: strips a ```json ... ``` (or bare ```...```) fence if
// present, then JSON.parse in a try/catch. Returns undefined (never throws)
// on anything that isn't valid JSON, so callers can turn "broken output" into
// a normal `ok:false` result instead of an uncaught exception.
function parseJsonResponseText(text: string): unknown {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// analyzeGlossary — ONE call: topic + glossary for a whole transcript.
// ---------------------------------------------------------------------------

export type AnalyzeGlossaryResult =
  | { ok: true; topic: string; glossary: GlossaryEntry[] }
  | { ok: false; reason: GeminiErrorReason; message: string };

const ANALYZE_GLOSSARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    topic: { type: 'STRING' },
    glossary: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          term: { type: 'STRING' },
          translation: { type: 'STRING' },
          keepEnglish: { type: 'BOOLEAN' },
        },
        required: ['term', 'translation', 'keepEnglish'],
      },
    },
  },
  required: ['topic', 'glossary'],
};

function buildAnalyzeGlossaryPrompt(fullText: string): string {
  return `You are analyzing the English transcript of a technical YouTube video to prepare a Korean-translation glossary.

Identify:
1. The video's topic, as one concise sentence.
2. Key technical terms (library/product names, jargon, recurring concepts) that should be translated consistently, with the recommended Korean handling for each: the Korean translation to use, and whether the English term should be kept as-is (keepEnglish: true) instead of translated.

Respond with JSON only, matching this shape:
{"topic": string, "glossary": [{"term": string, "translation": string, "keepEnglish": boolean}]}

Transcript:
"""
${fullText}
"""`;
}

function isGlossaryEntry(value: unknown): value is GlossaryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).term === 'string' &&
    typeof (value as Record<string, unknown>).translation === 'string' &&
    typeof (value as Record<string, unknown>).keepEnglish === 'boolean'
  );
}

function parseAnalyzeGlossaryPayload(
  parsed: unknown,
): { topic: string; glossary: GlossaryEntry[] } | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const topic = (parsed as Record<string, unknown>).topic;
  const glossaryRaw = (parsed as Record<string, unknown>).glossary;
  if (typeof topic !== 'string' || !Array.isArray(glossaryRaw)) return undefined;
  return { topic, glossary: glossaryRaw.filter(isGlossaryEntry) };
}

export async function analyzeGlossary(
  fullText: string,
  key: string,
  opts: GeminiCallOptions = {},
): Promise<AnalyzeGlossaryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestBody = {
    contents: [{ parts: [{ text: buildAnalyzeGlossaryPrompt(fullText) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ANALYZE_GLOSSARY_SCHEMA,
      // No `thinkingConfig` here: `gemini-3.5-flash-lite` (Task R5) already
      // has zero thinking by default for this call and rejects an explicit
      // `thinkingBudget` with a 400, the same failure mode `gemini-3.6-flash`
      // had for `thinkingBudget: 0` (Task R2, reverted) — so this is left as
      // just `responseMimeType`/`responseSchema` on purpose, not an oversight.
    },
  };

  const result = await callGeminiJson(key, requestBody, fetchImpl);
  if (!result.ok) return result;

  const parsed = parseAnalyzeGlossaryPayload(parseJsonResponseText(result.text));
  if (!parsed) {
    return { ok: false, reason: 'unknown', message: 'Could not parse glossary analysis response' };
  }
  return { ok: true, topic: parsed.topic, glossary: parsed.glossary };
}

// ---------------------------------------------------------------------------
// translateBatch — ONE call: translate a batch of segments to Korean.
// ---------------------------------------------------------------------------

// `translations` always has exactly `segs.length` entries, one per input
// segment in input order, each keyed by that segment's own `index` (never by
// array position — the model may drop or reorder items). A segment the
// model's response didn't include gets `translatedText: null` rather than
// being omitted, so Task 6's pipeline can retry by scanning this array for
// nulls without having to diff it against the input segments itself.
//
// `'truncated'`/`'bad_json'` are extra reasons beyond the shared
// `GeminiErrorReason` (M2 refactor §2, "truncation guard"): a single
// large-chunk request can hit the model's `MAX_TOKENS` output cap, which
// must NEVER be treated as a successful-but-partial response (that would
// silently persist a truncated translation as if it were complete) — it is
// classified `'truncated'` regardless of whether the cut-off text happens to
// parse as valid JSON. `'bad_json'` covers the pre-existing "response body
// isn't valid JSON" case, now named distinctly from the generic `'unknown'`
// so the pipeline's failure summary reads clearly for either cause.
export type TranslateBatchReason = GeminiErrorReason | 'truncated' | 'bad_json';

export type TranslateBatchResult =
  | { ok: true; translations: Array<{ index: number; translatedText: string | null }> }
  // `retryDelayMs` (rate_limit only) is the STRUCTURED `RetryInfo.retryDelay`
  // fallback — pipeline.ts prefers `parseRetryDelayMs(message)` first (the
  // human-readable "retry in Ns" text every real free-tier 429 carries), and
  // falls back to this field only when that text has no parseable number.
  | { ok: false; reason: TranslateBatchReason; message: string; retryDelayMs?: number };

const TRANSLATE_BATCH_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      index: { type: 'INTEGER' },
      translatedText: { type: 'STRING' },
    },
    required: ['index', 'translatedText'],
  },
};

// PRD §7.3 rules, restated for the model.
const TRANSLATION_RULES = `Translation rules:
- Do not translate code, commands, URLs, or library/product names.
- For technical terms, prefer the established Korean convention; add the English term in parentheses when it helps clarity.
- Keep terminology consistent with the glossary below — reuse its translations exactly wherever a listed term appears.
- Do not add any AI commentary, opinions, or explanations. Translate only.
- Translate each segment's text independently; do not merge, split, or reorder segments.`;

function buildGlossaryBlock(glossary: GlossaryEntry[]): string {
  if (glossary.length === 0) return '(none)';
  return glossary
    .map((entry) =>
      entry.keepEnglish
        ? `- ${entry.term} -> keep in English`
        : `- ${entry.term} -> ${entry.translation}`,
    )
    .join('\n');
}

function buildTranslateBatchPrompt(segs: TranscriptSegment[], glossary: GlossaryEntry[]): string {
  const segmentsText = segs.map((seg) => `[${seg.index}] ${seg.sourceText}`).join('\n');
  return `You are translating English YouTube transcript segments to Korean.

${TRANSLATION_RULES}

Glossary:
${buildGlossaryBlock(glossary)}

Translate each numbered segment below to Korean. Respond with JSON only: an array of {"index": number, "translatedText": string}, one entry per segment below, using the exact same index numbers.

Segments:
${segmentsText}`;
}

interface RawTranslationItem {
  index: number;
  translatedText: string;
}

function isRawTranslationItem(value: unknown): value is RawTranslationItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).index === 'number' &&
    typeof (value as Record<string, unknown>).translatedText === 'string'
  );
}

function parseTranslationItems(parsed: unknown): RawTranslationItem[] | undefined {
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter(isRawTranslationItem);
}

export async function translateBatch(
  segs: TranscriptSegment[],
  glossary: GlossaryEntry[],
  key: string,
  opts: GeminiCallOptions = {},
): Promise<TranslateBatchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestBody = {
    contents: [{ parts: [{ text: buildTranslateBatchPrompt(segs, glossary) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: TRANSLATE_BATCH_SCHEMA,
      // No `thinkingConfig` here (see MODEL_ID's own doc comment, Task R5):
      // `gemini-3.6-flash`'s mandatory thinking made this call explode
      // (150s+ for a single 50-segment chunk) and, per Task R2, rejected an
      // explicit `thinkingBudget: 0` with a 400 anyway. Switching to
      // `gemini-3.5-flash-lite` fixed the actual problem at the root —
      // `thoughtsTokenCount: 0` by default, no config needed, and this model
      // also 400s on an explicit `thinkingBudget`, so `responseMimeType`/
      // `responseSchema` alone is correct here, not incomplete.
    },
  };

  const result = await callGeminiJson(key, requestBody, fetchImpl);
  if (!result.ok) return result;

  // Truncation guard (M2 refactor §2): checked BEFORE attempting to parse —
  // a `MAX_TOKENS` finish means the model's output was cut off mid-response,
  // and a cut-off JSON array can still coincidentally parse as valid JSON
  // for whichever segments landed before the cutoff. Accepting that as
  // `ok:true` would silently drop every segment after the cutoff as "done"
  // when it never actually translated. Always a clean failure instead, so
  // the pipeline marks this chunk pending again rather than persisting a
  // partial result as complete.
  if (result.finishReason === 'MAX_TOKENS') {
    return {
      ok: false,
      reason: 'truncated',
      message: 'Response truncated at the model output token limit (finishReason: MAX_TOKENS)',
    };
  }

  const items = parseTranslationItems(parseJsonResponseText(result.text));
  if (items === undefined) {
    return { ok: false, reason: 'bad_json', message: 'Could not parse translation response' };
  }

  const byIndex = new Map(items.map((item) => [item.index, item.translatedText]));
  const translations = segs.map((seg) => ({
    index: seg.index,
    translatedText: byIndex.get(seg.index) ?? null,
  }));

  return { ok: true, translations };
}
