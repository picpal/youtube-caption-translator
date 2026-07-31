import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchExportData } from './useExportData';

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('~/lib/messaging', () => ({ sendMessage }));

const VIDEO_ID = 'zjkBMFhNj_g';
const VIDEO = { videoId: VIDEO_ID, title: 't', channelName: null, durationSeconds: null };
const DONE = { videoId: VIDEO_ID, status: 'done', segments: [] };

function routeResponses(over: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    GET_VIDEO_META: VIDEO,
    GET_TRANSLATION: DONE,
    GET_SUMMARY: null,
    ...over,
  };
  sendMessage.mockImplementation((msg: { type: string }) => Promise.resolve(table[msg.type]));
}

describe('fetchExportData', () => {
  beforeEach(() => {
    sendMessage.mockReset();
  });

  it('returns ready with all three records when the translation is done', async () => {
    routeResponses({ GET_SUMMARY: { videoId: VIDEO_ID } });
    const state = await fetchExportData(VIDEO_ID);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') throw new Error('unreachable');
    expect(state.video).toEqual(VIDEO);
    expect(state.summary).toEqual({ videoId: VIDEO_ID });
  });

  it('is still ready when there is no summary', async () => {
    routeResponses();
    const state = await fetchExportData(VIDEO_ID);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') throw new Error('unreachable');
    expect(state.summary).toBeNull();
  });

  it("reports not-done when the record isn't finished", async () => {
    routeResponses({ GET_TRANSLATION: { videoId: VIDEO_ID, status: 'translating', segments: [] } });
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'not-done' });
  });

  it('reports not-done when there is no record at all', async () => {
    routeResponses({ GET_TRANSLATION: null });
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'not-done' });
  });

  it('reports no-video when the meta was never cached', async () => {
    routeResponses({ GET_VIDEO_META: null });
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'no-video' });
  });

  it('sends the three reads concurrently, not one after another', async () => {
    routeResponses();
    await fetchExportData(VIDEO_ID);
    const types = sendMessage.mock.calls.map(([msg]) => msg.type).sort();
    expect(types).toEqual(['GET_SUMMARY', 'GET_TRANSLATION', 'GET_VIDEO_META']);
  });

  it('reports no-video when a read rejects', async () => {
    sendMessage.mockRejectedValue(new Error('extension context invalidated'));
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'no-video' });
  });
});
