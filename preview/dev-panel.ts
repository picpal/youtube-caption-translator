// Harness-only "DEV PREVIEW" state switcher.
//
// Rendered as a fixed-position overlay appended directly to `document.body`
// on every preview page — never part of the popup/options/sidepanel React
// trees, and styled distinctly (dark amber chrome) so it can never be
// mistaken for real product UI.
//
// Lets the developer flip mock state without touching production code:
//   - API key present / absent      -> live update (fires storage.onChanged)
//   - Current fake tab               -> reloads the page to re-run the
//                                        popup's one-shot chrome.tabs.query
//   - Next TEST_API_KEY result       -> read fresh on the next test click
//   - Light / dark theme             -> live update (toggles `.dark` on <html>)

import { deleteApiKey, getApiKeyStatus, saveApiKey } from '~/lib/storage';
import { addStorageListener, readMeta, writeMeta, type TabKind, type TestResultKind } from './state';

const PANEL_ID = '__ypa_preview_panel__';
const THEME_KEY = '__ypa_preview_theme__';
const MOCK_KEY_VALUE = 'AIzaPreviewMockKey00000000000000000';

type Theme = 'light' | 'dark';

export function applyStoredTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  setTheme(stored === 'dark' ? 'dark' : 'light', false);
}

function setTheme(theme: Theme, persist = true): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  if (persist) localStorage.setItem(THEME_KEY, theme);
}

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

const TAB_KINDS: TabKind[] = ['watch', 'home', 'other'];
const TAB_LABELS: Record<TabKind, string> = {
  watch: 'YouTube 시청',
  home: 'YouTube 홈',
  other: '유튜브 아님',
};

const RESULT_KINDS: TestResultKind[] = ['ok', 'unauthorized', 'rate_limit', 'network', 'unknown'];
const RESULT_LABELS: Record<TestResultKind, string> = {
  ok: 'ok · 정상',
  unauthorized: 'unauthorized · 401',
  rate_limit: 'rate_limit · 429',
  network: 'network · 오류',
  unknown: 'unknown · 기타',
};

export async function mountDevPanel(): Promise<void> {
  if (document.getElementById(PANEL_ID)) return;

  injectStyles();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  document.body.appendChild(panel);

  const render = async () => {
    const meta = readMeta();
    const status = await getApiKeyStatus();
    panel.innerHTML = renderHtml(meta.tabKind, meta.nextTestResult, status.present, currentTheme());
    wireEvents(panel, render);
  };

  // Keep the "API 키" indicator live if it changes from elsewhere (e.g. the
  // real Options/Popup UI saving or deleting a key while the panel is open).
  addStorageListener(() => {
    void render();
  });

  await render();
}

function wireEvents(panel: HTMLElement, render: () => Promise<void>): void {
  panel.querySelector('[data-action="collapse"]')?.addEventListener('click', () => {
    panel.classList.toggle('ypa-collapsed');
  });

  panel.querySelector('[data-action="key-present"]')?.addEventListener('click', () => {
    void saveApiKey(MOCK_KEY_VALUE).then(render);
  });
  panel.querySelector('[data-action="key-absent"]')?.addEventListener('click', () => {
    void deleteApiKey().then(render);
  });

  panel.querySelectorAll<HTMLButtonElement>('[data-tab-kind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      writeMeta({ tabKind: btn.dataset.tabKind as TabKind });
      location.reload();
    });
  });

  const select = panel.querySelector<HTMLSelectElement>('[data-action="next-result"]');
  select?.addEventListener('change', () => {
    writeMeta({ nextTestResult: select.value as TestResultKind });
  });

  panel.querySelector('[data-action="theme-light"]')?.addEventListener('click', () => {
    setTheme('light');
    void render();
  });
  panel.querySelector('[data-action="theme-dark"]')?.addEventListener('click', () => {
    setTheme('dark');
    void render();
  });
}

function renderHtml(
  tabKind: TabKind,
  nextResult: TestResultKind,
  keyPresent: boolean,
  theme: Theme,
): string {
  const tabButtons = TAB_KINDS.map(
    (kind) => `
      <button type="button" data-tab-kind="${kind}" class="ypa-btn ${tabKind === kind ? 'ypa-btn-active' : ''}">
        ${TAB_LABELS[kind]}
      </button>`,
  ).join('');

  const resultOptions = RESULT_KINDS.map(
    (kind) => `<option value="${kind}" ${nextResult === kind ? 'selected' : ''}>${RESULT_LABELS[kind]}</option>`,
  ).join('');

  return `
    <div class="ypa-header">
      <span class="ypa-badge">DEV PREVIEW</span>
      <button type="button" class="ypa-collapse" data-action="collapse" aria-label="접기/펼치기">−</button>
    </div>
    <div class="ypa-body">
      <div class="ypa-row">
        <span class="ypa-label">API 키</span>
        <div class="ypa-group">
          <button type="button" data-action="key-present" class="ypa-btn ${keyPresent ? 'ypa-btn-active' : ''}">있음</button>
          <button type="button" data-action="key-absent" class="ypa-btn ${!keyPresent ? 'ypa-btn-active' : ''}">없음</button>
        </div>
      </div>
      <div class="ypa-row">
        <span class="ypa-label">현재 탭 <em>(새로고침)</em></span>
        <div class="ypa-group">${tabButtons}</div>
      </div>
      <div class="ypa-row">
        <span class="ypa-label">TEST_API_KEY 결과</span>
        <select data-action="next-result" class="ypa-select">${resultOptions}</select>
      </div>
      <div class="ypa-row">
        <span class="ypa-label">테마</span>
        <div class="ypa-group">
          <button type="button" data-action="theme-light" class="ypa-btn ${theme === 'light' ? 'ypa-btn-active' : ''}">라이트</button>
          <button type="button" data-action="theme-dark" class="ypa-btn ${theme === 'dark' ? 'ypa-btn-active' : ''}">다크</button>
        </div>
      </div>
      <div class="ypa-row ypa-nav">
        <a href="./index.html">런처</a>
        <a href="./popup.html">Popup</a>
        <a href="./options.html">Options</a>
        <a href="./sidepanel.html">Sidepanel</a>
      </div>
    </div>
  `;
}

function injectStyles(): void {
  if (document.getElementById(`${PANEL_ID}-style`)) return;
  const style = document.createElement('style');
  style.id = `${PANEL_ID}-style`;
  style.textContent = `
    /* src/styles/globals.css sets the html/body background via a raw
       "@media (prefers-color-scheme: dark)" query, which tracks the real
       OS/browser setting rather than our .dark class toggle. Some surfaces
       (e.g. entrypoints/sidepanel/App.tsx's root <div>) have no background
       of their own and rely on that body background showing through, so
       without this override the theme switcher would only affect
       component-level dark: classes and not the page behind them. This is a
       harness-only override (!important, scoped to html/body) — production
       CSS in src/styles/globals.css is untouched. */
    html.dark body { background-color: #0a0a0a !important; color: #f5f5f5 !important; }
    html:not(.dark) body { background-color: #fafafa !important; color: #171717 !important; }

    #${PANEL_ID} {
      all: initial;
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 2147483647;
      width: 236px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      line-height: 1.4;
      color: #fbead0;
      background: #1c1305;
      border: 1px solid #8a5a12;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    #${PANEL_ID} * { box-sizing: border-box; font-family: inherit; }
    #${PANEL_ID} .ypa-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid #4a2f09;
    }
    #${PANEL_ID} .ypa-badge {
      font-weight: 700;
      letter-spacing: 0.06em;
      font-size: 10px;
      color: #1c1305;
      background: #f2a900;
      padding: 2px 6px;
      border-radius: 4px;
    }
    #${PANEL_ID} .ypa-collapse {
      margin-left: auto;
      background: transparent;
      border: 1px solid #6b4712;
      color: #fbead0;
      border-radius: 4px;
      width: 18px;
      height: 18px;
      cursor: pointer;
      line-height: 1;
    }
    #${PANEL_ID}.ypa-collapsed .ypa-body { display: none; }
    #${PANEL_ID} .ypa-body { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    #${PANEL_ID} .ypa-row { display: flex; flex-direction: column; gap: 4px; }
    #${PANEL_ID} .ypa-label { color: #d8b073; font-size: 10px; }
    #${PANEL_ID} .ypa-label em { font-style: normal; opacity: 0.7; }
    #${PANEL_ID} .ypa-group { display: flex; gap: 4px; flex-wrap: wrap; }
    #${PANEL_ID} .ypa-btn {
      flex: 1 1 auto;
      cursor: pointer;
      border: 1px solid #6b4712;
      background: #2b1c07;
      color: #fbead0;
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 10.5px;
    }
    #${PANEL_ID} .ypa-btn:hover { background: #3a2609; }
    #${PANEL_ID} .ypa-btn-active { background: #f2a900; color: #1c1305; font-weight: 700; border-color: #f2a900; }
    #${PANEL_ID} .ypa-select {
      width: 100%;
      background: #2b1c07;
      color: #fbead0;
      border: 1px solid #6b4712;
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 10.5px;
    }
    #${PANEL_ID} .ypa-nav { flex-direction: row; flex-wrap: wrap; gap: 8px; border-top: 1px solid #4a2f09; padding-top: 6px; }
    #${PANEL_ID} .ypa-nav a { color: #f2c869; text-decoration: underline; font-size: 10px; }
  `;
  document.head.appendChild(style);
}
