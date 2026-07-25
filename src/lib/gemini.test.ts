import { describe, expect, it, vi } from 'vitest';
import { testGeminiKey, MODEL_ID } from './gemini';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
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
