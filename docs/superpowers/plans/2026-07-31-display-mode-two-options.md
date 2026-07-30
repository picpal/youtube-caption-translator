# Display Mode Two Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `'en'` (원문-only) display mode — `DisplayMode` becomes `'both' | 'ko'` — and rename the two remaining buttons to language-neutral labels (`원문+한국어`, `한국어만`).

**Architecture:** Pure narrowing change across 3 source files + 2 test files. No migration code: panel-prefs' per-field literal validation already makes a stored legacy `'en'` fall back to `'both'`.

**Tech Stack:** WXT + React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-display-mode-two-options-design.md`

## Global Constraints

- UI copy Korean; the two labels are exactly `원문+한국어` and `한국어만`.
- `DisplayMode` is exactly `'both' | 'ko'` after this change; `grep -rn "'en'" src entrypoints` must return no DisplayMode-related hits.
- Do not change: `visibleTexts`'s `'both'` and `'ko'` behavior (including the `'ko'` null-translation fallback to sourceText), the segmented-button markup/styles, panel-prefs keys/defaults, anything else in App.tsx.
- Gates before commit: `npx tsc --noEmit` (0 errors), `npx vitest run` (all pass), `npm run build` (succeeds).

---

### Task 1: Narrow DisplayMode to two options

**Files:**
- Modify: `src/components/TranscriptList.tsx:6-13` (doc comment + type), `:39-43` (VisibleTexts doc), `:50-63` (visibleTexts)
- Modify: `entrypoints/sidepanel/App.tsx:292-296` (DISPLAY_MODE_OPTIONS)
- Modify: `src/lib/panel-prefs.ts:20` (DISPLAY_MODES)
- Test: `src/components/TranscriptList.test.ts` (remove `mode: 'en'` block), `src/lib/panel-prefs.test.ts` (replace `'en'` uses, add legacy fallback test)

**Interfaces:**
- Consumes: existing `DisplayMode` consumers (App.tsx useState/props) — they compile unchanged because they only ever produce `'both' | 'ko'` after the options array shrinks.
- Produces: `DisplayMode = 'both' | 'ko'` (final shape; no later tasks).

- [ ] **Step 1: Update the tests first**

In `src/components/TranscriptList.test.ts`: delete the entire `describe("mode: 'en'", …)` block (2 tests).

In `src/lib/panel-prefs.test.ts`:
- In the test `falls back per field on non-string garbage`, change `store.panelDisplayMode = 'en';` to `store.panelDisplayMode = 'ko';` and the expectation `displayMode: 'en'` to `displayMode: 'ko'`.
- In the test `savePanelDisplayMode writes only its own key`, change `await savePanelDisplayMode('en');` to `await savePanelDisplayMode('ko');` and `expect(store.panelDisplayMode).toBe('en');` to `.toBe('ko');`.
- Add one new test inside the `loadPanelPrefs` describe block:

```ts
  it("treats the removed legacy 'en' mode as invalid and falls back to 'both'", async () => {
    store.panelDisplayMode = 'en'; // persisted by a pre-2-option version
    store.panelLastTab = 'summary';
    expect(await loadPanelPrefs()).toEqual({ displayMode: 'both', lastTab: 'summary' });
  });
```

- [ ] **Step 2: Run tests to verify the right failures**

Run: `npx vitest run src/lib/panel-prefs.test.ts src/components/TranscriptList.test.ts`
Expected: the new legacy-fallback test FAILS (loadPanelPrefs still accepts `'en'`); the edited tests pass.

- [ ] **Step 3: Narrow the type and remove the 'en' branch**

In `src/components/TranscriptList.tsx`:

Replace the type and its doc comment (lines 6-13):

```ts
/**
 * Task R7 (Fix 1) — the panel's 자막 표시 selector. `'both'` is the pre-R7
 * default look (source muted + KO primary); `'ko'` shows the translation
 * alone. The `'en'` (source-only) mode was removed 2026-07-31 — YouTube's
 * own player already shows the source captions, and `'both'` covers
 * checking the source in the panel. Persisted to chrome.storage.local via
 * `~/lib/panel-prefs` and restored on panel mount (M3).
 */
export type DisplayMode = 'both' | 'ko';
```

In the `VisibleTexts` doc comment, replace the `'primary-only'` bullet (lines 39-43) with:

```
 * - `'primary-only'` — `'ko'` mode (real KO, or its own source-text
 *   fallback when `translatedText` is still `null`): a SINGLE line, but
 *   rendered in the primary style — the brief is explicit that a single
 *   visible line must never be left looking like an orphaned
 *   secondary/muted line.
```

Replace `visibleTexts`'s `'ko'`/`'en'` tail (lines 56-62) so the function ends:

```ts
  // mode === 'ko' — "빈 행 금지": a still-untranslated row falls back to
  // the source text rather than rendering nothing.
  return { kind: 'primary-only', text: segment.translatedText ?? segment.sourceText };
}
```

(The `if (mode === 'ko')` wrapper goes away; `'both'` branch stays byte-identical.)

In `entrypoints/sidepanel/App.tsx`, replace the options array (lines 292-296):

```ts
const DISPLAY_MODE_OPTIONS: ReadonlyArray<{ mode: DisplayMode; label: string }> = [
  { mode: 'both', label: '원문+한국어' },
  { mode: 'ko', label: '한국어만' },
];
```

In `src/lib/panel-prefs.ts` line 20:

```ts
const DISPLAY_MODES: readonly DisplayMode[] = ['both', 'ko'];
```

- [ ] **Step 4: Sweep for stragglers**

Run: `grep -rn "'en'" src entrypoints` — fix any remaining DisplayMode-related hit (comments included). Hits unrelated to DisplayMode (none are known) stay.

- [ ] **Step 5: Gates**

Run: `npx tsc --noEmit` (0), `npx vitest run` (all pass — expect 369: 370 − 2 removed + 1 added), `npm run build` (ok).

- [ ] **Step 6: Commit**

```bash
git add src/components/TranscriptList.tsx src/components/TranscriptList.test.ts entrypoints/sidepanel/App.tsx src/lib/panel-prefs.ts src/lib/panel-prefs.test.ts
git commit -m "feat(panel): drop source-only display mode, neutral two-option labels"
```
