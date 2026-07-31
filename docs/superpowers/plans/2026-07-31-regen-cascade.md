# Regen Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 번역 `다시 생성` regenerates the summary too (only when one already exists), and the Summary tab's own 다시 생성 button is removed.

**Architecture:** Background-side cascade chained onto START_TRANSLATION's fire-and-forget pipeline promise (shared `startSummaryJob` helper with the GENERATE_SUMMARY handler); panel-side removals (SummaryPanel header action, useSummary.regenerate, App.tsx prop) + one banner copy change.

**Tech Stack:** WXT + React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-regen-cascade-design.md`

## Global Constraints

- Cascade fires ONLY when: pipeline settled AND `getTranslation(videoId).status === 'done'` AND `getSummary(videoId)` exists. Never creates a first summary. Never fires on `failed`.
- The existing keepalive release in START_TRANSLATION's `.finally` must remain the LAST step — the cascade runs inside the chain before it.
- Cascade errors are logged only — never affect the translation result or the ack already sent.
- Summary language keeps coming from `getTargetLang()` inside `runSummaryGeneration` (no change there).
- Panel: empty-state `요약 생성` and failed-state `다시 시도` keep working (generate path untouched); only the done-state header action goes away.
- UI copy Korean. Gates before commit: `npx tsc --noEmit` (0), `npx vitest run` (all pass), `npm run build` (ok).

---

### Task 1: Cascade + button removal

**Files:**
- Modify: `entrypoints/background.ts` (extract `startSummaryJob`, chain cascade at the `void runTranslationPipeline(` call ~line 365)
- Modify: `src/components/SummaryPanel.tsx` (remove done-state header 다시 생성 + `onRegenerate` prop, ~lines 20/30/90)
- Modify: `src/features/summary/useSummary.ts` (remove `regenerate` from the hook's API and implementation; keep the shared internal generation body used by `generate`)
- Modify: `entrypoints/sidepanel/App.tsx` (remove `onRegenerate={summaryState.regenerate}`; summary banner copy tail `다시 생성으로 교체할 수 있어요` → `다시 생성 시 함께 갱신됩니다` — the TRANSLATION banner keeps its existing copy)
- Test: `src/background.test.ts`

**Interfaces:**
- Produces: `startSummaryJob(videoId: string): Promise<AppResponseMap['GENERATE_SUMMARY']>` in background.ts (module-scope helper; GENERATE_SUMMARY handler and cascade both call it).

- [ ] **Step 1: Extract the helper.** In `entrypoints/background.ts`, lift the GENERATE_SUMMARY handler's body into:

```ts
function startSummaryJob(videoId: string): Promise<AppResponseMap['GENERATE_SUMMARY']> {
  let job = inFlightSummaries.get(videoId);
  if (!job) {
    job = runSummaryGeneration(videoId).finally(() => {
      inFlightSummaries.delete(videoId);
    });
    inFlightSummaries.set(videoId, job);
  }
  return job;
}
```

and make the `GENERATE_SUMMARY` case `return (await startSummaryJob(payload.videoId)) as AppResponseMap[T];`.

- [ ] **Step 2: Chain the cascade.** The existing kickoff has the shape `void runTranslationPipeline(params, deps).catch(…).finally(release…)` (read the actual chain first — preserve its catch/finally semantics exactly). Insert a `.then` BEFORE the final release so the chain becomes: pipeline → cascade → release. The cascade step:

```ts
          .then(async () => {
            // 다시 생성 캐스케이드 (spec 2026-07-31-regen-cascade §2): a
            // re-translation that ends `done` refreshes this video's summary
            // too — but only if one already exists (summaries stay opt-in,
            // and a `failed` run must not burn a summary call on top).
            const [rec, cached] = await Promise.all([getTranslation(payload.videoId), getSummary(payload.videoId)]);
            if (rec?.status !== 'done' || !cached) return;
            const result = await startSummaryJob(payload.videoId);
            if (!result.ok) console.warn('[bg] summary cascade failed:', result.error);
          })
```

(If the current chain has no `.catch` before `.finally`, add the `.then` with a `.catch((err) => console.warn('[bg] summary cascade error:', err))` on the cascade step itself so a cascade throw can never surface as an unhandled rejection.)

- [ ] **Step 3: Panel removals.** SummaryPanel: delete the done-state header 다시 생성 button and the `onRegenerate` prop (interface + destructuring). useSummary: delete `regenerate` (keep the internal generation body that `generate` uses; update the hook's doc comments — they currently describe both paths). App.tsx: stop passing `onRegenerate`; change ONLY the summary banner's trailing clause to `다시 생성 시 함께 갱신됩니다`.

- [ ] **Step 4: Tests first-ish.** In `src/background.test.ts` (existing mock/fake patterns; `generateSummary` and the two pipeline Gemini fns already have partial-mock precedents):
  1. Cascade fires: seed a done-able pipeline run (mock `analyzeGlossary`/`translateBatch`) AND a pre-existing summary for the videoId (seed via `putSummary` or the fake store the file uses) + mock `generateSummary`; send START_TRANSLATION; `await vi.waitFor` until `getSummary(videoId)` has a NEW `createdAt` (or `generateSummary` mock called once); assert the refreshed summary's `targetLang` matches the stored setting.
  2. No prior summary → after the run settles to done, `generateSummary` mock NOT called.
  3. Failed pipeline (e.g. transcript unavailable, the file's existing failure fixture) with a pre-existing summary → `generateSummary` NOT called and the old summary untouched.

- [ ] **Step 5: Sweep + gates.** `grep -rn "onRegenerate\|regenerate" src entrypoints` — only allowed leftovers are unrelated words (expect 0 hits in practice; fix comments too, e.g. useSummary's header). Then `npx tsc --noEmit`, `npx vitest run`, `npm run build`.

- [ ] **Step 6: Commit.**

```bash
git add entrypoints/background.ts src/components/SummaryPanel.tsx src/features/summary/useSummary.ts entrypoints/sidepanel/App.tsx src/background.test.ts
git commit -m "feat(panel): 다시 생성 cascades to existing summary, drop summary-side regenerate"
```
