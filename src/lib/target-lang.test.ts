import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TARGET_LANG,
  TARGET_LANG_LABELS,
  TARGET_LANG_NAMES,
  TARGET_LANGS,
  getTargetLang,
  saveTargetLang,
} from './target-lang';

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

describe('getTargetLang', () => {
  it('returns ko when nothing is stored', async () => {
    expect(await getTargetLang()).toBe('ko');
  });
  it('returns each stored valid value', async () => {
    for (const lang of ['ko', 'en', 'ja', 'zh']) {
      store.translationTargetLang = lang;
      expect(await getTargetLang()).toBe(lang);
    }
  });
  it('falls back to ko on invalid values', async () => {
    store.translationTargetLang = 'fr';
    expect(await getTargetLang()).toBe('ko');
    store.translationTargetLang = 42;
    expect(await getTargetLang()).toBe('ko');
  });
});
describe('saveTargetLang', () => {
  it('writes only its own key and round-trips', async () => {
    store.panelDisplayMode = 'ko';
    await saveTargetLang('ja');
    expect(store.translationTargetLang).toBe('ja');
    expect(store.panelDisplayMode).toBe('ko');
    expect(await getTargetLang()).toBe('ja');
  });
});
describe('label tables', () => {
  it('cover every TargetLang', () => {
    for (const lang of TARGET_LANGS) {
      expect(TARGET_LANG_LABELS[lang]).toBeTruthy();
      expect(TARGET_LANG_NAMES[lang]).toBeTruthy();
    }
  });
});
