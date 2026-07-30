# Panel Prefs Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the side panel's 자막 표시 mode (`both|ko|en`) and last tab selection (`transcript|summary`) to `chrome.storage.local`, restoring both on panel mount.

**Architecture:** New pure storage module `src/lib/panel-prefs.ts` (mirrors `storage.ts` patterns), wired into ReadyBody in `entrypoints/sidepanel/App.tsx`. Writes happen only on user clicks; the stored last tab is applied once, at the first moment the Summary tab gate (`showSummaryTab`) is open AND prefs have loaded — never earlier, so the existing snap-back effect can't clobber it.

**Tech Stack:** WXT + React 19 + TypeScript, vitest (jsdom), chrome.storage.local.

**Spec:** `docs/superpowers/specs/2026-07-30-panel-prefs-design.md`

## Global Constraints

- UI copy is Korean. No English user-facing strings.
- **Rules of Hooks:** every hook added to ReadyBody MUST sit above the no-metadata early return (`if (!loading && video === null)`) in `entrypoints/sidepanel/App.tsx`, alongside the existing hooks.
- Do not touch: manifest permissions, surfaces (side panel + Options only), `src/lib/storage.ts` API-key keys (`geminiApiKey`, `geminiApiKeySavedAt`), the existing snap-back effect body, the tab-switch scroll effect, `.env.local`, `.chrome-dev-profile/`.
- Automatic state changes never write to storage — only user clicks do.
- Gates before every commit: `npx tsc --noEmit` (0 errors), `npx vitest run` (all pass), and for Task 2 also `npm run build`.
- Storage keys are exactly `panelDisplayMode` and `panelLastTab`. Defaults are exactly `'both'` and `'transcript'`.

---

### Task 1: panel-prefs storage module

**Files:**
- Create: `src/lib/panel-prefs.ts`
- Test: `src/lib/panel-prefs.test.ts`

**Interfaces:**
- Consumes: `DisplayMode` type from `~/components/TranscriptList` (type-only import; union `'both' | 'ko' | 'en'`, already exported).
- Produces (Task 2 relies on these exact names/signatures):
  - `type PanelTab = 'transcript' | 'summary'`
  - `interface PanelPrefs { displayMode: DisplayMode; lastTab: PanelTab }`
  - `const DEFAULT_PANEL_PREFS: PanelPrefs`
  - `loadPanelPrefs(): Promise<PanelPrefs>`
  - `savePanelDisplayMode(mode: DisplayMode): Promise<void>`
  - `savePanelLastTab(tab: PanelTab): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/panel-prefs.test.ts` (chrome mock copied from `src/lib/storage.test.ts`'s beforeEach — same in-memory `store` fake):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PANEL_PREFS,
  loadPanelPrefs,
  savePanelDisplayMode,
  savePanelLastTab,
} from './panel-prefs';

type LocalStore = Record<string, unknown>;
let store: LocalStore;

beforeEach(() => {
  store = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn((keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: LocalStore = {};
          for (const k of arr) if (k in store) out[k] = store[k];
          return Promise.resolve(out);
        }),
        set: vi.fn((items: LocalStore) => {
          Object.assign(store, items);
          return Promise.resolve();
        }),
      },
    },
  };
});

describe('loadPanelPrefs', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await loadPanelPrefs()).toEqual({ displayMode: 'both', lastTab: 'transcript' });
    expect(DEFAULT_PANEL_PREFS).toEqual({ displayMode: 'both', lastTab: 'transcript' });
  });

  it('returns stored values when both are valid', async () => {
    store.panelDisplayMode = 'ko';
    store.panelLastTab = 'summary';
    expect(await loadPanelPrefs()).toEqual({ displayMode: 'ko', lastTab: 'summary' });
  });

  it('falls back per field when one value is invalid', async () => {
    store.panelDisplayMode = 'BOTH'; // wrong casing — not an allowed literal
    store.panelLastTab = 'summary';
    expect(await loadPanelPrefs()).toEqual({ displayMode: 'both', lastTab: 'summary' });
  });

  it('falls back per field on non-string garbage', async () => {
    store.panelDisplayMode = 'en';
    store.panelLastTab = 42;
    expect(await loadPanelPrefs()).toEqual({ displayMode: 'en', lastTab: 'transcript' });
  });
});

describe('save functions', () => {
  it('savePanelDisplayMode writes only its own key', async () => {
    store.panelLastTab = 'summary';
    await savePanelDisplayMode('en');
    expect(store.panelDisplayMode).toBe('en');
    expect(store.panelLastTab).toBe('summary');
  });

  it('savePanelLastTab writes only its own key', async () => {
    store.panelDisplayMode = 'ko';
    await savePanelLastTab('summary');
    expect(store.panelLastTab).toBe('summary');
    expect(store.panelDisplayMode).toBe('ko');
  });

  it('round-trips through loadPanelPrefs', async () => {
    await savePanelDisplayMode('ko');
    await savePanelLastTab('summary');
    expect(await loadPanelPrefs()).toEqual({ displayMode: 'ko', lastTab: 'summary' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/panel-prefs.test.ts`
Expected: FAIL — cannot resolve `./panel-prefs`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/panel-prefs.ts`:

```ts
import type { DisplayMode } from '~/components/TranscriptList';

// The side panel's two persisted user choices (spec 2026-07-30-panel-prefs).
// Flat keys in the same chrome.storage.local namespace as the API key —
// deliberately NOT nested under one object so each save can write its own
// key without a read-modify-write cycle (and without ever clobbering the
// other preference).
const DISPLAY_MODE_KEY = 'panelDisplayMode';
const LAST_TAB_KEY = 'panelLastTab';

export type PanelTab = 'transcript' | 'summary';

export interface PanelPrefs {
  displayMode: DisplayMode;
  lastTab: PanelTab;
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = { displayMode: 'both', lastTab: 'transcript' };

const DISPLAY_MODES: readonly DisplayMode[] = ['both', 'ko', 'en'];
const PANEL_TABS: readonly PanelTab[] = ['transcript', 'summary'];

// Per-field fallback: a corrupt/legacy value in one key must not take the
// other key's valid value down with it.
export async function loadPanelPrefs(): Promise<PanelPrefs> {
  const record = await chrome.storage.local.get([DISPLAY_MODE_KEY, LAST_TAB_KEY]);
  const rawMode = record[DISPLAY_MODE_KEY];
  const rawTab = record[LAST_TAB_KEY];
  return {
    displayMode: DISPLAY_MODES.includes(rawMode as DisplayMode)
      ? (rawMode as DisplayMode)
      : DEFAULT_PANEL_PREFS.displayMode,
    lastTab: PANEL_TABS.includes(rawTab as PanelTab)
      ? (rawTab as PanelTab)
      : DEFAULT_PANEL_PREFS.lastTab,
  };
}

export async function savePanelDisplayMode(mode: DisplayMode): Promise<void> {
  await chrome.storage.local.set({ [DISPLAY_MODE_KEY]: mode });
}

export async function savePanelLastTab(tab: PanelTab): Promise<void> {
  await chrome.storage.local.set({ [LAST_TAB_KEY]: tab });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/panel-prefs.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Gates + commit**

Run: `npx tsc --noEmit` (expect 0 errors) and `npx vitest run` (expect all pass, 368 total).

```bash
git add src/lib/panel-prefs.ts src/lib/panel-prefs.test.ts
git commit -m "feat(panel): panel-prefs storage module for displayMode and last tab"
```

---

### Task 2: Wire persistence into ReadyBody

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx` (ReadyBody only — state block around lines 306-465, displayMode buttons around line 498, tab buttons around line 552)

**Interfaces:**
- Consumes (from Task 1): `loadPanelPrefs(): Promise<PanelPrefs>`, `savePanelDisplayMode(mode: DisplayMode): Promise<void>`, `savePanelLastTab(tab: PanelTab): Promise<void>`, `type PanelTab`.
- Produces: nothing new for later tasks (this is the last code task).

- [ ] **Step 1: Add the import**

In `entrypoints/sidepanel/App.tsx`, next to the existing `~/` imports at the top:

```ts
import { loadPanelPrefs, savePanelDisplayMode, savePanelLastTab, type PanelTab } from '~/lib/panel-prefs';
```

- [ ] **Step 2: Add restore state + load effect in ReadyBody**

Directly below the existing line `const [displayMode, setDisplayMode] = useState<DisplayMode>('both');` (line ~311), add:

```ts
  // Panel prefs persistence (M3 spec 2026-07-30-panel-prefs). Both restored
  // values come from one mount-time load; WRITES happen only in the two
  // onClick handlers below — automatic transitions (the snap-back effect
  // further down) must never persist, or reopening the panel would clobber
  // a stored 'summary' with 'transcript' during the moment the gate is
  // still closed while the translation record loads.
  //
  // displayMode is applied as soon as the load resolves — unless the user
  // already clicked a mode button in that ~ms window (touched ref wins).
  // lastTab is NOT applied here: it's parked in state and applied by the
  // gate-keyed effect below, because restoring 'summary' before
  // showSummaryTab is true would be immediately snapped back to
  // 'transcript' by the existing effect.
  const displayModeTouchedRef = useRef(false);
  const [storedLastTab, setStoredLastTab] = useState<PanelTab | null>(null); // null = not loaded yet
  useEffect(() => {
    let cancelled = false;
    void loadPanelPrefs().then((prefs) => {
      if (cancelled) return;
      if (!displayModeTouchedRef.current) setDisplayMode(prefs.displayMode);
      setStoredLastTab(prefs.lastTab);
    });
    return () => {
      cancelled = true;
    };
  }, []);
```

- [ ] **Step 3: Add the one-shot lastTab restore effect**

Directly below the existing snap-back effect (the `useEffect` ending `if (!showSummaryTab) setActiveTab('transcript'); }, [showSummaryTab]);`, line ~408-410) — leaving that effect itself completely unchanged — add:

```ts
  // One-shot restore of the persisted tab, at the first moment BOTH are
  // true: the Summary gate is open and prefs have loaded. Keyed on both so
  // either arrival order works — if the gate opens before storage resolves
  // (or vice versa), the restore simply waits for the other. The ref makes
  // it once-per-mount: a mid-session retry that closes and reopens the gate
  // gets the snap-back's 'transcript', not a surprise jump back to Summary.
  const lastTabRestoredRef = useRef(false);
  useEffect(() => {
    if (!showSummaryTab || lastTabRestoredRef.current || storedLastTab === null) return;
    lastTabRestoredRef.current = true;
    if (storedLastTab === 'summary') setActiveTab('summary');
  }, [showSummaryTab, storedLastTab]);
```

Both hooks in Steps 2-3 MUST sit above the no-metadata early return (`if (!loading && video === null)`) — see Global Constraints.

- [ ] **Step 4: Persist on user clicks**

In the 자막 표시 button (line ~498), change:

```ts
                onClick={() => setDisplayMode(mode)}
```

to:

```ts
                onClick={() => {
                  displayModeTouchedRef.current = true;
                  setDisplayMode(mode);
                  void savePanelDisplayMode(mode);
                }}
```

In the tab button (line ~552), change:

```ts
                    onClick={() => setActiveTab(tab)}
```

to:

```ts
                    onClick={() => {
                      setActiveTab(tab);
                      void savePanelLastTab(tab);
                    }}
```

- [ ] **Step 5: Update the stale comment**

The ReadyBody doc comment (line ~304-305) says the 자막 표시 selector is "session-local state only, per the brief; persisting the choice across sessions is M3." Replace that trailing clause so it reads that the selection is persisted to `chrome.storage.local` via `panel-prefs` (M3, spec 2026-07-30-panel-prefs) and restored on mount.

- [ ] **Step 6: Gates**

Run: `npx tsc --noEmit` (0 errors), `npx vitest run` (all pass), `npm run build` (succeeds).

- [ ] **Step 7: Commit**

```bash
git add entrypoints/sidepanel/App.tsx
git commit -m "feat(panel): persist displayMode and last tab across panel sessions"
```

---

### Task 3 (controller-run): Real-Chrome CDP verification

Not a subagent task — the controller runs this with the existing scratchpad CDP helpers, per the spec §4: deploy build (`Extensions.loadUnpacked` + SW `chrome.runtime.reload()`), click `한국어` + `Summary`, assert `panelDisplayMode`/`panelLastTab` in storage, close and reopen the panel target, assert `aria-pressed`/`aria-selected` restored, verify again after `runtime.reload()`, and confirm the API key savedAt is unchanged.
