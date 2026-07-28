import type { GeminiTestResult } from '~/types/message';
import type { GlossaryEntry, TranscriptSegment } from '~/types/transcript';

export const MODEL_ID = 'gemini-3.6-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

interface GeminiCallOptions {
  fetchImpl?: typeof fetch;
}

interface GeminiErrorBody {
  error?: { message?: string };
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
    response = await fetchImpl(url, {
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
  | { ok: false; reason: GeminiErrorReason; message: string };

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

// Parses the free-tier rate-limit wait hint Gemini embeds in its 429 error
// message text — e.g. "... Please retry in 55.5s." — into milliseconds.
// This is the ONLY retry-delay source used by pipeline.ts's chunk retry loop
// (brief §3): the Gemini REST error body can also carry a structured
// `error.details[].retryInfo.retryDelay` (a protobuf Duration string like
// "55s"), but every free-tier 429 observed in the field already echoes the
// same number back in the human-readable `message`, so parsing THAT (already
// plumbed through `classifyGeminiError`/`TranslateBatchResult.message`) covers
// the real case without adding a second field to every Gemini result type.
// Returns `undefined` (never throws) when the message has no parseable hint,
// so callers can fall back to a fixed default delay.
export function parseRetryDelayMs(message: string): number | undefined {
  const match = message.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!match) return undefined;
  const seconds = Number.parseFloat(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

async function callGeminiJson(
  key: string,
  requestBody: unknown,
  fetchImpl: typeof fetch,
): Promise<GeminiCallResult> {
  const url = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
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
    return { ok: false, ...classifyGeminiError(response.status, message) };
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
  | { ok: false; reason: TranslateBatchReason; message: string };

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
