import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveApiKey, getApiKeyStatus, deleteApiKey, maskKey, getApiKey } from './storage';

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
        remove: vi.fn((keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete store[k];
          return Promise.resolve();
        }),
      },
    },
  };
});

describe('maskKey', () => {
  it('returns bullets plus last four characters', () => {
    expect(maskKey('AIzaSyABCDEFG12345')).toBe('••••2345');
  });

  it('returns bullets alone for short keys', () => {
    expect(maskKey('abc')).toBe('••••');
  });
});

describe('saveApiKey', () => {
  it('rejects empty keys', async () => {
    await expect(saveApiKey('')).rejects.toThrow(/empty/i);
    await expect(saveApiKey('   ')).rejects.toThrow(/empty/i);
  });

  it('stores trimmed key with savedAt timestamp', async () => {
    const before = Date.now();
    const result = await saveApiKey('  AIzaSyABCDEFG12345  ');
    expect(store.geminiApiKey).toBe('AIzaSyABCDEFG12345');
    expect(result.maskedKey).toBe('••••2345');
    expect(new Date(result.savedAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('getApiKeyStatus', () => {
  it('reports absent when nothing stored', async () => {
    const status = await getApiKeyStatus();
    expect(status).toEqual({ present: false });
  });

  it('reports present with masked key when stored', async () => {
    store.geminiApiKey = 'AIzaSyABCDEFG12345';
    store.geminiApiKeySavedAt = '2026-07-25T00:00:00.000Z';
    const status = await getApiKeyStatus();
    expect(status).toEqual({
      present: true,
      maskedKey: '••••2345',
      savedAt: '2026-07-25T00:00:00.000Z',
    });
  });
});

describe('deleteApiKey', () => {
  it('removes both key and timestamp', async () => {
    store.geminiApiKey = 'AIzaSyABCDEFG12345';
    store.geminiApiKeySavedAt = '2026-07-25T00:00:00.000Z';
    await deleteApiKey();
    expect(store.geminiApiKey).toBeUndefined();
    expect(store.geminiApiKeySavedAt).toBeUndefined();
  });
});

describe('getApiKey', () => {
  it('returns null when nothing stored', async () => {
    const key = await getApiKey();
    expect(key).toBeNull();
  });

  it('returns the stored key when present', async () => {
    store.geminiApiKey = 'AIzaSyABCDEFG12345';
    const key = await getApiKey();
    expect(key).toBe('AIzaSyABCDEFG12345');
  });
});
