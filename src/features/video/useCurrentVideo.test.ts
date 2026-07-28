import { describe, expect, it } from 'vitest';
import { currentVideoState } from './useCurrentVideo';
import type { CurrentVideoState } from '~/types/message';

// Task R7 fix round 1 (Critical #3) — `currentVideoState` is the pure
// "only trust state tagged for the CURRENT tab" decision behind
// useCurrentVideo's tab-switch atomicity fix. The hook's own effects need a
// chrome.* mock and are verified in real Chrome instead (this codebase's
// established convention — see useTranslation's `shouldResume`/
// `pendingResolveDelayMs` for the same split).

const SETTLED_STATE: CurrentVideoState = { status: 'settled', meta: null };

describe('currentVideoState', () => {
  it('returns null when nothing has been tagged yet', () => {
    expect(currentVideoState(null, 5)).toBeNull();
  });

  it('returns the tagged state when its tabId matches the current tabId', () => {
    expect(currentVideoState({ tabId: 5, state: SETTLED_STATE }, 5)).toBe(SETTLED_STATE);
  });

  it('returns null when the tagged state belongs to a DIFFERENT tab (the tab-switch race)', () => {
    // The exact scenario Critical #3 describes: a stale tag from the
    // previous tab must never leak through as if it were the new tab's data.
    expect(currentVideoState({ tabId: 5, state: SETTLED_STATE }, 6)).toBeNull();
  });

  it('returns null when the current tabId is itself null (not yet resolved)', () => {
    expect(currentVideoState({ tabId: 5, state: SETTLED_STATE }, null)).toBeNull();
  });
});
