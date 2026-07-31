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
    // 세 호출을 직접 통제되는 프라미스로 되돌려, 아무것도 resolve하기 전에 세
    // 호출 모두가 이미 나갔는지를 확인한다. Promise.all([a(), b(), c()])는 배열을
    // 만드는 시점에 a/b/c를 동기적으로 전부 호출한 뒤에야 await로 넘어가므로, 첫
    // await가 걸리기 전에 이미 3건이 기록돼 있어야 한다. 순차 await 체인으로
    // 바뀌면 이 시점에 1건만 기록된다 — 정렬된 타입 배열 비교만으로는 이 차이를
    // 잡지 못했다(무엇이든 결국 세 건이 쌓이므로).
    const resolvers: Record<string, (value: unknown) => void> = {};
    sendMessage.mockImplementation(
      (msg: { type: string }) =>
        new Promise((resolve) => {
          resolvers[msg.type] = resolve;
        }),
    );

    const resultPromise = fetchExportData(VIDEO_ID);

    expect(sendMessage).toHaveBeenCalledTimes(3);
    const types = sendMessage.mock.calls.map(([msg]) => msg.type).sort();
    expect(types).toEqual(['GET_SUMMARY', 'GET_TRANSLATION', 'GET_VIDEO_META']);

    resolvers.GET_VIDEO_META(VIDEO);
    resolvers.GET_TRANSLATION(DONE);
    resolvers.GET_SUMMARY(null);

    const state = await resultPromise;
    expect(state.status).toBe('ready');
  });

  it('reports no-video when a read rejects', async () => {
    sendMessage.mockRejectedValue(new Error('extension context invalidated'));
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'no-video' });
  });
});
