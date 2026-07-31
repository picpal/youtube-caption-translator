# Remove Processing Stepper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the 처리 단계 stepper section from the side panel, plus the code that only it consumed.

**Architecture:** Pure deletion in `entrypoints/sidepanel/App.tsx` and `src/features/translation/progress-display.ts(+.test.ts)`. TranslateButton (kept) already surfaces per-step labels, live progress, errors, and retry.

**Tech Stack:** WXT + React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-remove-processing-stepper-design.md`

## Global Constraints

- Deletion only — no behavior change to TranslateButton, `processingLabel`, `useElapsedSeconds`, pipeline progress events, or any persisted type (`TranslationRecord.error.step` stays in the types).
- Keep `formatElapsedTime` and `translatePhaseLabel` (and their tests) — TranslateButton's `processingLabel` uses them.
- After the change, `grep -rn "ProcessingStepper\|stepVisualState\|stepperCaption\|STEP_LABELS\|stepForStatus\|progressPercent" src entrypoints` must return 0 hits (comments included).
- Gates before commit: `npx tsc --noEmit` (0 errors), `npx vitest run` (all pass), `npm run build` (succeeds).

---

### Task 1: Delete the stepper and its dead dependencies

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx` (imports line 1 + 12-18, ReadyBody render line ~584, helper/component block lines ~847-968, TranslateButton doc comment ~695-697)
- Modify: `src/features/translation/progress-display.ts` (remove `ProcessingStep`, `stepForStatus`, `progressPercent`)
- Modify: `src/features/translation/progress-display.test.ts` (remove the `stepForStatus` and `progressPercent` describe blocks)
- Modify: `src/features/translation/pipeline.ts:314` (comment mentions `progressPercent` — reword to describe the guard without naming the deleted function)

**Interfaces:**
- Consumes: nothing new.
- Produces: `progress-display.ts` exports exactly `formatElapsedTime` and `translatePhaseLabel` afterward.

- [ ] **Step 1: Delete the App.tsx stepper code**

Remove, in `entrypoints/sidepanel/App.tsx`:

1. The render line in ReadyBody (~line 584):
```tsx
      <ProcessingStepper status={status} progress={progress} record={record} elapsedSeconds={elapsedSeconds} />
```
2. The entire block from `const STEP_LABELS = […]` (~line 847) through the end of the `ProcessingStepper` function (~line 968), including `StepVisualState`, `STEP_TEXT_CLASS`, `stepVisualState`, `stepperCaption`, and both functions' doc comments.
3. From the `react` import (line 1): drop `Fragment` (stepper-only). Keep the rest.
4. From the `~/features/translation/progress-display` import (lines 12-18): drop `progressPercent`, `stepForStatus`, `type ProcessingStep`. Keep `formatElapsedTime`, `translatePhaseLabel`.
5. In the TranslateButton doc comment (~695-697), the bullet ending "…`translating` additionally shows the live, divide-by-zero-safe percent via `progressPercent`." — replace that sentence's tail so the bullet just says the label is step-aware with phase/chunk/elapsed detail while processing, e.g.:
```
// - `extracting`/`analyzing`/`translating`: disabled with a step-aware
//   label (phase, chunk, and elapsed-time detail while translating).
```
6. Check whether `TranslationRecord` (type import) is still referenced in App.tsx after deleting the stepper's props — it is used elsewhere (`record` handling in ReadyBody); leave imports that still have uses, remove any that now have none (tsc will confirm).

- [ ] **Step 2: Delete the dead exports in progress-display**

In `src/features/translation/progress-display.ts`: remove the `ProcessingStep` type, `stepForStatus` (with its doc comment), and `progressPercent` (with its doc comment). `formatElapsedTime` and `translatePhaseLabel` stay untouched.

In `src/features/translation/progress-display.test.ts`: remove the `describe('stepForStatus', …)` and `describe('progressPercent', …)` blocks and drop the two names from the import line.

In `src/features/translation/pipeline.ts` (~line 314): reword the comment that names `progressPercent` so it describes the divide-by-zero guard behavior without referencing the deleted function.

- [ ] **Step 3: Sweep**

Run: `grep -rn "ProcessingStepper\|stepVisualState\|stepperCaption\|STEP_LABELS\|stepForStatus\|progressPercent" src entrypoints` — must be 0 hits; fix any straggler (comments included).

- [ ] **Step 4: Gates**

Run: `npx tsc --noEmit` (0 errors — this also proves no import went stale), `npx vitest run` (all pass; count drops below 369 by however many tests Step 2 removed), `npm run build` (ok).

- [ ] **Step 5: Commit**

```bash
git add entrypoints/sidepanel/App.tsx src/features/translation/progress-display.ts src/features/translation/progress-display.test.ts src/features/translation/pipeline.ts
git commit -m "feat(panel): remove 처리 단계 stepper — TranslateButton already covers progress"
```
