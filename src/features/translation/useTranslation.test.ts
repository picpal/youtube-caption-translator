import { describe, expect, it } from 'vitest';
import { pendingResolveDelayMs, shouldResume } from './useTranslation';
import type { TranslationRecord, TranslationStatus } from '~/types/transcript';

// Only `shouldResume` is unit-tested here — the hook's connect/subscribe/
// auto-resume/cleanup lifecycle needs a real `chrome.runtime.connect` Port
// and is validated in real Chrome instead (Task 7's brief: no brittle
// chrome-API mock for the full hook). This pure decision function is what
// the effect's auto-resume branch delegates to, so covering it here covers
// the actual "does this record get auto-resumed" logic without a browser.

function recordWithStatus(status: TranslationStatus): TranslationRecord {
  return {
    videoId: 'v1',
    captionHash: 'hash',
    sourceLang: 'en',
    status,
    segments: [],
    glossary: [],
    completedBatches: 0,
    totalBatches: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('shouldResume', () => {
  it('returns false when there is no record at all', () => {
    expect(shouldResume(null)).toBe(false);
  });

  it('returns true for an analyzing record', () => {
    expect(shouldResume(recordWithStatus('analyzing'))).toBe(true);
  });

  it('returns true for a translating record', () => {
    expect(shouldResume(recordWithStatus('translating'))).toBe(true);
  });

  it('returns false for a done record (nothing left to do)', () => {
    expect(shouldResume(recordWithStatus('done'))).toBe(false);
  });

  it('returns false for a failed record (terminal, no auto-retry)', () => {
    expect(shouldResume(recordWithStatus('failed'))).toBe(false);
  });

  it('returns false for idle/extracting, statuses the pipeline never actually persists', () => {
    expect(shouldResume(recordWithStatus('idle'))).toBe(false);
    expect(shouldResume(recordWithStatus('extracting'))).toBe(false);
  });
});

// Task R7 (Fix 2A) — the pure "how much longer must pending wait" helper
// behind `useTranslation`'s `pending` flag. The timer-driven race itself (a
// Port message / start() rejection / 5s safety timeout, whichever comes
// first) needs a real Port and is exercised in real Chrome, same reasoning
// as `shouldResume` above — this covers the one piece of that logic that
// doesn't need a chrome.* mock.
describe('pendingResolveDelayMs', () => {
  it('returns the full minimum when no time has elapsed yet', () => {
    expect(pendingResolveDelayMs(0, 600)).toBe(600);
  });

  it('returns the remaining time when partway through the minimum window', () => {
    expect(pendingResolveDelayMs(250, 600)).toBe(350);
  });

  it('returns 0 once the minimum window has fully elapsed', () => {
    expect(pendingResolveDelayMs(600, 600)).toBe(0);
  });

  it('never returns negative even when elapsed overshoots the minimum', () => {
    expect(pendingResolveDelayMs(5000, 600)).toBe(0);
  });
});
