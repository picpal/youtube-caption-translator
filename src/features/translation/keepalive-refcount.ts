// Task R4 — pure reference-counting logic for the MV3 service-worker
// keepalive that spans a translation pipeline's entire run
// (entrypoints/background.ts). Multiple pipelines can be in flight at once
// (two videos translating concurrently, or a resumed job racing a fresh
// START_TRANSLATION for a different video — see `inFlightTranslations` in
// background.ts), and they must all share ONE underlying `setInterval`
// rather than each starting/stopping their own: starting a second interval
// on top of the first would be harmless-but-wasteful, but naively clearing
// the interval whenever ANY one pipeline finishes would kill the keepalive
// out from under every other pipeline still running.
//
// Kept chrome-API-agnostic and side-effect-free (no `setInterval`/`clearInterval`
// calls here at all) so this transition logic is unit-testable without any
// chrome.*/timer mocking, mirroring this codebase's existing pattern of
// pulling pure logic out of background.ts (progress-broadcast.ts's
// `broadcastToPorts`, `shouldResume` in useTranslation.ts).
export class RefCount {
  private count = 0;

  /** Call when a new holder acquires the shared resource. Returns `true`
   * only on the 0->1 transition — the ONE call the caller should actually
   * start the underlying interval for; every other call is a no-op as far
   * as the resource itself is concerned. */
  acquire(): boolean {
    this.count += 1;
    return this.count === 1;
  }

  /** Call when a holder releases the shared resource. Returns `true` only
   * on the 1->0 transition — the ONE call the caller should actually stop
   * the underlying interval for. Never goes negative: an unbalanced extra
   * `release()` (should not happen, but is not load-bearing to guard
   * against) is simply a no-op rather than reporting a spurious 0->0 as a
   * teardown. */
  release(): boolean {
    if (this.count === 0) return false;
    this.count -= 1;
    return this.count === 0;
  }

  /** Current holder count — exposed for tests/diagnostics, not used for any
   * production decision beyond what `acquire`/`release`'s return values
   * already convey. */
  get value(): number {
    return this.count;
  }
}
