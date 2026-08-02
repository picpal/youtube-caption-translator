import type { DisplayMode } from '~/components/TranscriptList';

// The side panel's two persisted user choices (spec 2026-07-30-panel-prefs).
// Flat keys in the same chrome.storage.local namespace as the API key —
// deliberately NOT nested under one object so each save can write its own
// key without a read-modify-write cycle (and without ever clobbering the
// other preference).
const DISPLAY_MODE_KEY = 'panelDisplayMode';
const LAST_TAB_KEY = 'panelLastTab';

export type PanelTab = 'transcript' | 'summary' | 'notes';

export interface PanelPrefs {
  displayMode: DisplayMode;
  lastTab: PanelTab;
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = { displayMode: 'both', lastTab: 'transcript' };

const DISPLAY_MODES: readonly DisplayMode[] = ['both', 'ko'];
const PANEL_TABS: readonly PanelTab[] = ['transcript', 'summary', 'notes'];

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
