// Shared mock state for the local preview harness (mock-chrome.ts + dev-panel.ts).
//
// Two kinds of state live here, both backed by `localStorage` so they survive
// a page reload:
//
//  1. A `chrome.storage.local` stand-in (readStorage/storageGet/storageSet/
//     storageRemove + a listener registry) — this is what `mock-chrome.ts`
//     wires up as `chrome.storage.local` / `chrome.storage.onChanged`.
//  2. "Meta" harness state that has no equivalent in the real extension
//     (which fake tab is "current", which canned result TEST_API_KEY should
//     return next) — this only exists to drive the dev panel switcher.

export type TabKind = 'watch' | 'home' | 'other';
export type TestResultKind = 'ok' | 'unauthorized' | 'rate_limit' | 'network' | 'unknown';

export interface PreviewMeta {
  tabKind: TabKind;
  nextTestResult: TestResultKind;
}

const META_KEY = '__ypa_preview_meta__';
const DEFAULT_META: PreviewMeta = { tabKind: 'watch', nextTestResult: 'ok' };

export function readMeta(): PreviewMeta {
  try {
    return { ...DEFAULT_META, ...JSON.parse(localStorage.getItem(META_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_META };
  }
}

export function writeMeta(patch: Partial<PreviewMeta>): PreviewMeta {
  const next = { ...readMeta(), ...patch };
  localStorage.setItem(META_KEY, JSON.stringify(next));
  return next;
}

export function tabUrlFor(kind: TabKind): string {
  switch (kind) {
    case 'watch':
      return 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    case 'home':
      return 'https://www.youtube.com/';
    case 'other':
      return 'https://example.com/';
  }
}

// ---------------------------------------------------------------------------
// chrome.storage.local mock backing store

const STORAGE_KEY = '__ypa_preview_storage_local__';

export type StorageChange = { oldValue?: unknown; newValue?: unknown };
export type ChangeListener = (changes: Record<string, StorageChange>, area: string) => void;

const listeners = new Set<ChangeListener>();

export function addStorageListener(listener: ChangeListener): void {
  listeners.add(listener);
}

export function removeStorageListener(listener: ChangeListener): void {
  listeners.delete(listener);
}

export function readStorage(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeStorage(store: Record<string, unknown>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function emit(changes: Record<string, StorageChange>): void {
  if (Object.keys(changes).length === 0) return;
  listeners.forEach((listener) => listener(changes, 'local'));
}

export function storageGet(
  keys?: string | string[] | Record<string, unknown> | null,
): Record<string, unknown> {
  const store = readStorage();
  if (keys == null) return { ...store };
  const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
  const result: Record<string, unknown> = {};
  for (const key of list) if (key in store) result[key] = store[key];
  return result;
}

export function storageSet(items: Record<string, unknown>): void {
  const store = readStorage();
  const changes: Record<string, StorageChange> = {};
  for (const [key, value] of Object.entries(items)) {
    changes[key] = { oldValue: store[key], newValue: value };
    store[key] = value;
  }
  writeStorage(store);
  emit(changes);
}

export function storageRemove(keys: string | string[]): void {
  const store = readStorage();
  const list = Array.isArray(keys) ? keys : [keys];
  const changes: Record<string, StorageChange> = {};
  for (const key of list) {
    if (key in store) {
      changes[key] = { oldValue: store[key], newValue: undefined };
      delete store[key];
    }
  }
  writeStorage(store);
  emit(changes);
}
