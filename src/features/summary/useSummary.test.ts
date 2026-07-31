import { describe, expect, it } from 'vitest';
import { SUMMARY_SAFETY_TIMEOUT_MS } from './useSummary';

// 2026-07-31 timeout fix — this codebase has no hook-rendering test harness
// (no @testing-library/react; see useTranslation.test.ts's own pure-helper-only
// coverage for the same reason), so this only pins the exported constant
// itself rather than exercising the hook's timer/effect wiring end to end.
// The value must stay ahead of gemini.ts's SUMMARY_FETCH_TIMEOUT_MS (300s)
// with headroom to spare — see this constant's own doc comment in
// useSummary.ts for the real-Chrome DoD measurements (182,657ms/3m3s, then
// 225,129ms/3m45s on the SAME prompt — ~25% latency variance) that made the
// old 180s value, and then the first-round 300s value, both give up on a
// request that was still going to succeed.
describe('SUMMARY_SAFETY_TIMEOUT_MS', () => {
  it('is 360s (300s SUMMARY_FETCH_TIMEOUT_MS + headroom)', () => {
    expect(SUMMARY_SAFETY_TIMEOUT_MS).toBe(360_000);
  });
});
