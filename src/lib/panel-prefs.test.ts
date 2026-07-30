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
