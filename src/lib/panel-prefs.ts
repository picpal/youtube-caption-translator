import type { DisplayMode } from '~/components/TranscriptList';
import { DEFAULT_FONT_SCALE, normalizeFontScale } from '~/lib/font-scale';

// The side panel's persisted user choices (spec 2026-07-30-panel-prefs,
// extended by 2026-08-05-panel-font-scale). Flat keys in the same
// chrome.storage.local namespace as the API key — deliberately NOT nested
// under one object so each save can write its own key without a
// read-modify-write cycle (and without ever clobbering the other
// preferences).
const DISPLAY_MODE_KEY = 'panelDisplayMode';
const LAST_TAB_KEY = 'panelLastTab';
const FONT_SCALE_KEY = 'panelFontScale';

export type PanelTab = 'transcript' | 'summary' | 'notes';

export interface PanelPrefs {
  displayMode: DisplayMode;
  lastTab: PanelTab;
  fontScale: number;
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  displayMode: 'both',
  lastTab: 'transcript',
  fontScale: DEFAULT_FONT_SCALE,
};

const DISPLAY_MODES: readonly DisplayMode[] = ['both', 'ko'];
const PANEL_TABS: readonly PanelTab[] = ['transcript', 'summary', 'notes'];

// Per-field fallback: a corrupt/legacy value in one key must not take the
// other key's valid value down with it.
export async function loadPanelPrefs(): Promise<PanelPrefs> {
  const record = await chrome.storage.local.get([DISPLAY_MODE_KEY, LAST_TAB_KEY, FONT_SCALE_KEY]);
  const rawMode = record[DISPLAY_MODE_KEY];
  const rawTab = record[LAST_TAB_KEY];
  return {
    displayMode: DISPLAY_MODES.includes(rawMode as DisplayMode)
      ? (rawMode as DisplayMode)
      : DEFAULT_PANEL_PREFS.displayMode,
    lastTab: PANEL_TABS.includes(rawTab as PanelTab)
      ? (rawTab as PanelTab)
      : DEFAULT_PANEL_PREFS.lastTab,
    // 정규화는 font-scale 모듈이 단독으로 안다 — 단계 목록이 바뀌어도 이 파일은
    // 그대로다.
    fontScale: normalizeFontScale(record[FONT_SCALE_KEY]),
  };
}

export async function savePanelDisplayMode(mode: DisplayMode): Promise<void> {
  await chrome.storage.local.set({ [DISPLAY_MODE_KEY]: mode });
}

export async function savePanelLastTab(tab: PanelTab): Promise<void> {
  await chrome.storage.local.set({ [LAST_TAB_KEY]: tab });
}

// 저장 시점에도 정규화한다 — 읽기만 막으면 목록 밖 값이 storage에 남아 다음
// 버전에서 되살아난다.
export async function savePanelFontScale(scale: number): Promise<void> {
  await chrome.storage.local.set({ [FONT_SCALE_KEY]: normalizeFontScale(scale) });
}
