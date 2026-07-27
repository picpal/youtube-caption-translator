import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, getVideo } from '~/lib/db';
import type { AppMessage } from '~/types/message';
import { handle } from '../entrypoints/background';

// Closes the M0 review's "no test for the message dispatch layer" gap: this
// drives the REAL `handle()` exported from entrypoints/background.ts — the
// same function `chrome.runtime.onMessage.addListener` calls in production —
// against a real IndexedDB (via fake-indexeddb, same pattern as
// src/lib/db.test.ts) and a stubbed `chrome.*`, asserting the actual response
// shapes rather than mocking handle()'s own collaborators away.
//
// Lives under src/, not beside entrypoints/background.ts, on purpose: WXT
// globs entrypointsDir for `*.[jt]s?(x)` to discover "unlisted-script"
// entrypoints, derives an entrypoint NAME by taking the filename up to its
// first dot, and rejects duplicate names. `entrypoints/background.test.ts`
// collided with `entrypoints/background.ts` under that rule — both name to
// "background" — and broke `pnpm wxt build` with "Multiple entrypoints with
// the same name detected" (measured; see task-8-report.md). vitest.config.ts
// only points `~` at `src/`, and WXT's `entrypointsDir` only globs
// `entrypoints/`, so `src/` is invisible to WXT and safe for this file.

let nextTabId = 1;
// A fresh tabId per test avoids any dependency on `latestByTab`'s module-level
// state being reset between tests (it has no reset hook, by design — see
// background.ts's comment on why losing it is harmless in production).
function freshTabId(): number {
  return nextTabId++;
}

function senderFor(tabId: number | undefined): chrome.runtime.MessageSender {
  return tabId === undefined ? {} : { tab: { id: tabId } as chrome.tabs.Tab };
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

let sendMessageMock: ReturnType<typeof vi.fn>;
let tabsSendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await deleteDb();
  sendMessageMock = vi.fn().mockResolvedValue({ ok: true });
  tabsSendMessageMock = vi.fn().mockResolvedValue(undefined);
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: sendMessageMock,
    },
    tabs: {
      sendMessage: tabsSendMessageMock,
    },
  };
});

const SETTLED_META = {
  videoId: 'zjkBMFhNj_g',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  title: '[1hr Talk] Intro to Large Language Models',
  channelName: 'Andrej Karpathy',
  thumbnailUrl: 'https://i.ytimg.com/vi/zjkBMFhNj_g/hqdefault.jpg',
  durationSeconds: 3588,
  captionAvailability: 'auto-only' as const,
};

describe('VIDEO_DETECTED', () => {
  it('caches to IndexedDB when settled with non-null meta, stamping fetchedAt', async () => {
    const tabId = freshTabId();
    const before = Date.now();

    const res = await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    expect(res).toEqual({ ok: true });

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).not.toBeNull();
    expect(cached?.title).toBe(SETTLED_META.title);
    expect(new Date(cached!.fetchedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does NOT cache a provisional report, even with non-null meta', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'provisional', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });

  it('does NOT cache an unsettled report', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'unsettled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });

  it('does NOT cache a settled report whose meta is null (not a video page)', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: null } },
      senderFor(tabId),
    );

    // Nothing to look up by id, so assert indirectly: GET_CURRENT_VIDEO still
    // reflects the in-memory report (proving the message WAS processed), but
    // no video with this id exists in the store.
    const res = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId } }, senderFor(undefined));
    expect(res).toEqual({ status: 'settled', meta: null });
    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });

  it('broadcasts CURRENT_VIDEO_UPDATED with the tabId and the real payload', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'CURRENT_VIDEO_UPDATED',
      payload: { tabId, video: { status: 'settled', meta: SETTLED_META } },
    });
  });

  it('acknowledges without throwing and without caching when the sender has no tab', async () => {
    const res = await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(undefined),
    );
    expect(res).toEqual({ ok: true });

    const cached = await getVideo(SETTLED_META.videoId);
    expect(cached).toBeNull();
  });
});

describe('GET_CURRENT_VIDEO', () => {
  it('returns null for a tab with no prior report', async () => {
    const tabId = freshTabId();
    const res = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId } }, senderFor(undefined));
    expect(res).toBeNull();
  });

  it('returns the most recent report for that tab, overwriting an earlier one', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'provisional', meta: SETTLED_META } },
      senderFor(tabId),
    );
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const res = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId } }, senderFor(undefined));
    expect(res).toEqual({ status: 'settled', meta: SETTLED_META });
  });

  it('keeps two tabs independent', async () => {
    const tabA = freshTabId();
    const tabB = freshTabId();
    const metaB = { ...SETTLED_META, videoId: 'other-video', title: 'A different video' };

    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabA),
    );
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: metaB } },
      senderFor(tabB),
    );

    const resA = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId: tabA } }, senderFor(undefined));
    const resB = await handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId: tabB } }, senderFor(undefined));

    expect(resA).toEqual({ status: 'settled', meta: SETTLED_META });
    expect(resB).toEqual({ status: 'settled', meta: metaB });
  });
});

describe('REQUEST_VIDEO_REEMIT', () => {
  it('asks the tab\'s content script to re-emit via chrome.tabs.sendMessage', async () => {
    const tabId = freshTabId();

    const res = await handle(
      { type: 'REQUEST_VIDEO_REEMIT', payload: { tabId } },
      senderFor(undefined),
    );

    expect(res).toEqual({ ok: true });
    expect(tabsSendMessageMock).toHaveBeenCalledWith(tabId, { type: 'REEMIT_VIDEO' });
  });

  it('does not throw out of handle() when the tab has no content script to receive it', async () => {
    const tabId = freshTabId();
    tabsSendMessageMock.mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await expect(
      handle({ type: 'REQUEST_VIDEO_REEMIT', payload: { tabId } }, senderFor(undefined)),
    ).resolves.toEqual({ ok: true });
  });
});

describe('CURRENT_VIDEO_UPDATED (self-delivery)', () => {
  it('is handled gracefully rather than falling through to the unhandled-type throw', async () => {
    const res = await handle(
      {
        type: 'CURRENT_VIDEO_UPDATED',
        payload: { tabId: freshTabId(), video: { status: 'settled', meta: null } },
      } as AppMessage as Extract<AppMessage, { type: 'CURRENT_VIDEO_UPDATED' }>,
      senderFor(undefined),
    );
    expect(res).toEqual({ ok: true });
  });
});
