import type { GeminiTestResult } from '~/types/message';

export const MODEL_ID = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

interface TestOptions {
  fetchImpl?: typeof fetch;
}

interface GeminiErrorBody {
  error?: { message?: string };
}

export async function testGeminiKey(
  key: string,
  opts: TestOptions = {},
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
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'network', message };
  }
  const latencyMs = Math.round(performance.now() - started);

  if (response.ok) {
    return { ok: true, latencyMs, model: MODEL_ID };
  }

  const errorBody = await response.json().catch(() => ({} as GeminiErrorBody)) as GeminiErrorBody;
  const message = errorBody.error?.message ?? `HTTP ${response.status}`;

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized', message };
  }
  if (response.status === 429) {
    return { ok: false, reason: 'rate_limit', message };
  }
  return { ok: false, reason: 'unknown', message };
}
