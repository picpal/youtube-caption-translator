import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEMINI_FETCH_TIMEOUT_MS, analyzeGlossary, generateSummary, parseRetryDelayMs, testGeminiKey, translateBatch, MODEL_ID } from './gemini';
import type { GlossaryEntry, TranscriptSegment } from '~/types/transcript';

describe('parseRetryDelayMs', () => {
  it('parses a whole-second "retry in Ns" hint to milliseconds', () => {
    expect(parseRetryDelayMs('Please retry in 55s.')).toBe(55_000);
  });

  it('parses a fractional-second hint', () => {
    expect(parseRetryDelayMs('Please retry in 55.5s.')).toBe(55_500);
  });

  it('is case-insensitive and tolerant of surrounding text', () => {
    expect(parseRetryDelayMs('Quota exceeded. RETRY IN 3s to continue.')).toBe(3_000);
  });

  it('returns undefined when the message has no parseable delay', () => {
    expect(parseRetryDelayMs('Quota exceeded for this project.')).toBeUndefined();
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function requestBody(fetchImpl: ReturnType<typeof vi.fn>): { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: Record<string, unknown> } {
  const init = fetchImpl.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('testGeminiKey', () => {
  it('returns ok:true and latency on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe(MODEL_ID);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain(MODEL_ID);
    expect(url).toContain('key=AIzaFAKE');
  });

  it('returns unauthorized on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'bad key' } }, { status: 401 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      message: 'bad key',
    });
  });

  it('returns unauthorized on 403 too', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'forbidden' } }, { status: 403 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('returns rate_limit on 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'quota' } }, { status: 429 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'rate_limit',
      message: 'quota',
    });
  });

  it('returns network on fetch throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message: 'offline',
    });
  });

  it('returns unknown on unexpected status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});

describe('analyzeGlossary', () => {
  it('sends the transcript and requests JSON output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ topic: 't', glossary: [] }) }] } }],
      }),
    );
    await analyzeGlossary('This video is about React hooks.', 'AIzaFAKE', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain(MODEL_ID);

    const body = requestBody(fetchImpl);
    const prompt = body.contents[0].parts[0].text;
    expect(prompt).toContain('This video is about React hooks.');
    expect(prompt).toContain('topic');
    expect(prompt).toContain('glossary');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('parses a clean JSON response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                topic: 'React hooks explained',
                glossary: [{ term: 'closure', translation: '클로저', keepEnglish: false }],
              }),
            }],
          },
        }],
      }),
    );
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: true,
      topic: 'React hooks explained',
      glossary: [{ term: 'closure', translation: '클로저', keepEnglish: false }],
    });
  });

  it('parses JSON wrapped in a ```json fence', async () => {
    const payload = JSON.stringify({ topic: 'x', glossary: [] });
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '```json\n' + payload + '\n```' }] } }],
      }),
    );
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: true, topic: 'x', glossary: [] });
  });

  it('returns ok:false reason:unknown on broken JSON, without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'not json{{{' }] } }] }),
    );
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  it('returns ok:false reason:unknown when there are no candidates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }));
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  it('maps 401 to unauthorized', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'bad key' } }, { status: 401 }),
    );
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unauthorized', message: 'bad key' });
  });

  it('maps 429 to rate_limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'quota' } }, { status: 429 }),
    );
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'rate_limit', message: 'quota' });
  });

  it('maps a fetch throw to network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'network', message: 'offline' });
  });

  it('maps 500 to unknown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    );
    const result = await analyzeGlossary('...', 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});

function seg(index: number, sourceText: string): TranscriptSegment {
  return {
    segmentId: `vid:${index}`,
    videoId: 'vid',
    index,
    startSec: index * 10,
    endSec: index * 10 + 10,
    sourceText,
    translatedText: null,
  };
}

const SEGS: TranscriptSegment[] = [
  seg(0, 'Today we talk about React hooks.'),
  seg(1, 'Run npm install to get started.'),
  seg(2, 'A closure captures variables.'),
];

const GLOSSARY: GlossaryEntry[] = [
  { term: 'React', translation: 'React', keepEnglish: true },
  { term: 'closure', translation: '클로저', keepEnglish: false },
];

describe('translateBatch', () => {
  it('sends §7.3 rules, the glossary, and numbered segments; requests JSON output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }),
    );
    await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });

    const body = requestBody(fetchImpl);
    const prompt = body.contents[0].parts[0].text;

    // PRD §7.3 rules
    expect(prompt).toMatch(/do not translate code/i);
    expect(prompt).toMatch(/URLs/);
    expect(prompt).toMatch(/library\/product names/i);
    expect(prompt).toMatch(/consistent/i);
    expect(prompt).toMatch(/do not add any ai commentary/i);
    expect(prompt).toMatch(/do not merge, split, or reorder/i);

    // glossary injection
    expect(prompt).toContain('React');
    expect(prompt).toContain('closure');
    expect(prompt).toContain('클로저');

    // numbered source segments, keyed by index
    expect(prompt).toContain('[0] Today we talk about React hooks.');
    expect(prompt).toContain('[1] Run npm install to get started.');
    expect(prompt).toContain('[2] A closure captures variables.');

    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('parses a clean JSON array response, mapped back by index', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify([
                { index: 0, translatedText: '오늘은 React 훅에 대해 이야기합니다.' },
                { index: 1, translatedText: 'npm install을 실행하세요.' },
                { index: 2, translatedText: '클로저는 변수를 캡처합니다.' },
              ]),
            }],
          },
        }],
      }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: true,
      translations: [
        { index: 0, translatedText: '오늘은 React 훅에 대해 이야기합니다.' },
        { index: 1, translatedText: 'npm install을 실행하세요.' },
        { index: 2, translatedText: '클로저는 변수를 캡처합니다.' },
      ],
    });
  });

  it('parses JSON wrapped in a ```json fence', async () => {
    const payload = JSON.stringify([{ index: 0, translatedText: '번역됨' }]);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '```json\n' + payload + '\n```' }] } }],
      }),
    );
    const result = await translateBatch([SEGS[0]], [], 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: true, translations: [{ index: 0, translatedText: '번역됨' }] });
  });

  it('maps present items by index on a partial response, leaving the rest untranslated (null), without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify([{ index: 1, translatedText: 'npm install을 실행하세요.' }]) }],
          },
        }],
      }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: true,
      translations: [
        { index: 0, translatedText: null },
        { index: 1, translatedText: 'npm install을 실행하세요.' },
        { index: 2, translatedText: null },
      ],
    });
  });

  it('maps out-of-order items back to the correct segments by index', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify([
                { index: 2, translatedText: '클로저는 변수를 캡처합니다.' },
                { index: 0, translatedText: '오늘은 React 훅에 대해 이야기합니다.' },
                { index: 1, translatedText: 'npm install을 실행하세요.' },
              ]),
            }],
          },
        }],
      }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: true,
      translations: [
        { index: 0, translatedText: '오늘은 React 훅에 대해 이야기합니다.' },
        { index: 1, translatedText: 'npm install을 실행하세요.' },
        { index: 2, translatedText: '클로저는 변수를 캡처합니다.' },
      ],
    });
  });

  it('returns ok:false reason:bad_json on broken JSON, without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'not json[[[' }] } }] }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_json');
  });

  // M2 refactor §2 — a chunk that hit the model's MAX_TOKENS output cap must
  // be a clean failure, never a silently-accepted partial result, even when
  // the truncated text happens to still parse as valid JSON for whichever
  // segments landed before the cutoff.
  it('returns ok:false reason:truncated when finishReason is MAX_TOKENS, even if the partial JSON parses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{
          content: { parts: [{ text: JSON.stringify([{ index: 0, translatedText: '오늘은...' }]) }] },
          finishReason: 'MAX_TOKENS',
        }],
      }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('truncated');
      expect(result.message).toMatch(/MAX_TOKENS/);
    }
  });

  it('does not flag a normal STOP finish as truncated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{
          content: { parts: [{ text: JSON.stringify([{ index: 0, translatedText: '번역됨' }]) }] },
          finishReason: 'STOP',
        }],
      }),
    );
    const result = await translateBatch([SEGS[0]], GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: true, translations: [{ index: 0, translatedText: '번역됨' }] });
  });

  it('returns ok:false reason:unknown when there are no candidates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }));
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  it('maps 401 to unauthorized', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'bad key' } }, { status: 401 }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unauthorized', message: 'bad key' });
  });

  it('maps 429 to rate_limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'quota' } }, { status: 429 }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'rate_limit', message: 'quota' });
  });

  // Review fix — a 429 whose `message` has no parseable "retry in Ns" number
  // (e.g. a bare quota-exhausted message) must still surface the server's
  // actual wait time from the structured `error.details[]` RetryInfo entry,
  // so the pipeline doesn't fall back to a fixed default that can't survive
  // a real 40-60s free-tier quota window.
  it('surfaces retryDelayMs from error.details[].retryInfo.retryDelay when the message has no parseable number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: 'Resource has been exhausted (e.g. check quota).',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '56s' }],
          },
        },
        { status: 429 },
      ),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'rate_limit',
      message: 'Resource has been exhausted (e.g. check quota).',
      retryDelayMs: 56_000,
    });
  });

  it('parses a fractional-second structured retryDelay', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: 'Resource has been exhausted.',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '56.5s' }],
          },
        },
        { status: 429 },
      ),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryDelayMs).toBe(56_500);
  });

  it('leaves retryDelayMs undefined when details carry no RetryInfo entry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: 'Resource has been exhausted.',
            details: [{ '@type': 'type.googleapis.com/google.rpc.Help' }],
          },
        },
        { status: 429 },
      ),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryDelayMs).toBeUndefined();
  });

  it('maps a fetch throw to network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'network', message: 'offline' });
  });

  it('maps 500 to unknown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    );
    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});

// Task R4 — a hung fetch (network black hole, a server that never responds)
// must not be allowed to keep the SW-keepalive-covered pipeline (and the SW
// itself) alive forever. `fetchImpl` here deliberately mimics a REAL fetch's
// abort behavior — it never resolves on its own, only rejecting once the
// `AbortController`'s signal actually fires — rather than a bare
// `new Promise(() => {})`, which would hang this test too.
function neverResolvingAbortableFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  });
}

describe('fetch timeout (Task R4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('translateBatch: aborts a hung request at GEMINI_FETCH_TIMEOUT_MS and returns a classified error, not a throw', async () => {
    vi.useFakeTimers();
    const fetchImpl = neverResolvingAbortableFetch();

    const resultPromise = translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl: fetchImpl as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(GEMINI_FETCH_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('network');
  });

  it('analyzeGlossary: aborts a hung request at GEMINI_FETCH_TIMEOUT_MS and returns a classified error', async () => {
    vi.useFakeTimers();
    const fetchImpl = neverResolvingAbortableFetch();

    const resultPromise = analyzeGlossary('...', 'AIzaFAKE', { fetchImpl: fetchImpl as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(GEMINI_FETCH_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('network');
  });

  it('testGeminiKey: aborts a hung request at GEMINI_FETCH_TIMEOUT_MS and returns a classified error', async () => {
    vi.useFakeTimers();
    const fetchImpl = neverResolvingAbortableFetch();

    const resultPromise = testGeminiKey('AIzaFAKE', { fetchImpl: fetchImpl as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(GEMINI_FETCH_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('network');
  });

  it('does not abort a request that resolves well before the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }),
    );

    const result = await translateBatch(SEGS, GLOSSARY, 'AIzaFAKE', { fetchImpl });

    expect(result.ok).toBe(true);
  });
});

describe('generateSummary', () => {
  const segs = [
    { startSec: 0, sourceText: 'intro' },
    { startSec: 620, sourceText: 'main point' },
  ];
  const payload = {
    purpose: '문제',
    mainArguments: ['주장'],
    sections: [{ startSec: 620, title: '본론' }],
    keywords: ['Agent'],
    conclusion: '결론',
  };

  it('returns the normalized payload on a valid JSON response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: true, payload });
    const body = requestBody(fetchImpl);
    expect(body.contents[0].parts[0].text).toContain('[620] main point');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('clamps out-of-range section startSec to the last segment start', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ ...payload, sections: [{ startSec: 99999, title: '끝' }] }) }] } }],
      }),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.ok && result.payload.sections[0].startSec).toBe(620);
  });

  it('returns bad_json when the response is not a parseable summary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'bad_json',
      message: 'Could not parse summary response',
    });
  });

  it('propagates rate_limit with structured retryDelayMs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: 'quota exceeded',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '55s' }],
          },
        },
        { status: 429 },
      ),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(!result.ok && result.reason).toBe('rate_limit');
    expect(!result.ok && result.retryDelayMs).toBe(55_000);
  });
});
