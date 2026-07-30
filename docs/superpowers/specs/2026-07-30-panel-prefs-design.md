# 패널 선호 영속화 — displayMode + 탭 선택 설계

날짜: 2026-07-30 · 상태: 승인됨 (사용자: displayMode 영속화 + 탭 선택도 같이)
선행: summary-panel 머지(`91a4a3a`) + 스크롤 UX 폴리시(`695e388`) — `activeTab`/스냅백 효과가 이미 존재한다.

## 1. 목표

사이드패널의 두 가지 사용자 선택을 `chrome.storage.local`에 영속화해 패널을 닫았다
열거나 브라우저를 재시작해도 유지한다:

1. **자막 표시 모드** (`영한 동시 | 한국어 | 영어`) — 현재 ReadyBody의 세션-로컬
   `useState<DisplayMode>('both')` (M2 Task R7이 M3로 미룬 항목).
2. **마지막 탭 선택** (`Transcript | Summary`) — 현재 세션-로컬
   `useState<'transcript' | 'summary'>('transcript')`.

둘 다 **전역 1건**(영상별 아님). 성공 기준(실 Chrome): `한국어` + `Summary` 선택 →
패널 닫고 재오픈 → 두 선택 모두 복원 실측, `chrome.runtime.reload()` 후에도 유지,
API 키 상태(savedAt) 불변.

## 2. 저장 모듈 (`src/lib/panel-prefs.ts` — 신규)

`storage.ts`(API 키 전용)와 분리한 새 모듈. 키는 API 키와 같은
`chrome.storage.local` 네임스페이스에 평면 키 2개:

- `panelDisplayMode` → `'both' | 'ko' | 'en'`
- `panelLastTab` → `'transcript' | 'summary'`

API:

```ts
import type { DisplayMode } from '~/components/TranscriptList'; // type-only — 단일 출처 유지

export type PanelTab = 'transcript' | 'summary';
export interface PanelPrefs {
  displayMode: DisplayMode;
  lastTab: PanelTab;
}
export const DEFAULT_PANEL_PREFS: PanelPrefs = { displayMode: 'both', lastTab: 'transcript' };

export async function loadPanelPrefs(): Promise<PanelPrefs>;
export async function savePanelDisplayMode(mode: DisplayMode): Promise<void>;
export async function savePanelLastTab(tab: PanelTab): Promise<void>;
```

- `loadPanelPrefs`: 두 키를 한 번의 `get`으로 읽고, 값이 없거나 허용 리터럴이
  아니면 **필드별로** 기본값 폴백 (한 필드가 오염돼도 다른 필드는 살린다).
- `save*`: 해당 키 하나만 `set` — 서로를 클로버하지 않는다.
- 호출부는 fire-and-forget (`void savePanel…(…)`) — 저장 실패가 UI를 막지 않는다.

## 3. 패널 배선 (`entrypoints/sidepanel/App.tsx` ReadyBody)

**쓰기는 사용자 클릭에서만.** 자동 전환은 절대 저장하지 않는다:

- 자막 표시 버튼 onClick: `setDisplayMode(mode)` + `void savePanelDisplayMode(mode)`.
- 탭 버튼 onClick: `setActiveTab(tab)` + `void savePanelLastTab(tab)`.
- 기존 스냅백 효과(`!showSummaryTab → setActiveTab('transcript')`)는 **무변경·비저장**.
  이 효과가 저장까지 하면, 패널을 열 때마다 record 로드 전 gate가 잠시 닫힌 사이
  저장된 `'summary'`가 `'transcript'`로 덮어써진다 — 이 레이스가 이 기능의 유일한 함정.

**복원:**

- 마운트 1회 `loadPanelPrefs()` (cancelled 가드 포함).
  - `displayMode`: 로드 즉시 적용. 단, 로드 완료 전에 사용자가 이미 버튼을 눌렀으면
    적용하지 않는다 (`displayModeTouchedRef` — 클릭 시 true).
  - `lastTab`: 즉시 적용하지 않고 state(`storedLastTab: PanelTab | null`,
    null = 미로드)에 보관.
- **lastTab 적용 시점 = `showSummaryTab`이 true이고 prefs가 로드된 최초 순간, 1회만**
  (`lastTabRestoredRef` 가드):

```ts
useEffect(() => {
  if (!showSummaryTab || lastTabRestoredRef.current || storedLastTab === null) return;
  lastTabRestoredRef.current = true;
  if (storedLastTab === 'summary') setActiveTab('summary');
}, [showSummaryTab, storedLastTab]);
```

  - gate가 prefs보다 먼저 열려도(`storedLastTab === null`) 소비되지 않고 대기 —
    양방향 순서 모두 안전.
  - 세션 중 재시도로 gate가 닫혔다 다시 열려도 재적용 없음 (1회 가드) — 스냅백이
    이긴다.
- 복원이 늦게 `'summary'`로 전환하면 기존 탭-전환 효과가 최상단 스크롤을 수행 —
  의도된 동작(Summary는 항상 최상단), 추가 배선 불필요.
- `displayMode` 기본값 1프레임 플래시: storage 읽기(~ms)가 IndexedDB record 로드보다
  먼저 끝나므로 실질 없음 — 허용.
- **Rules of Hooks**: 추가되는 모든 훅은 기존 훅들과 같이 no-metadata early return
  (`if (!loading && video === null)`) **위**에 배치.

## 4. 검증

- vitest (`src/lib/panel-prefs.test.ts`, storage.test.ts의 chrome mock 패턴 재사용):
  미저장 → 기본값 / 저장값 반환 / 필드별 invalid 폴백 / save가 올바른 키만 set /
  두 save가 서로 클로버하지 않음. 기존 게이트 유지 (tsc 0 · 전체 vitest · build).
- 실 Chrome (CDP, 컨트롤러 수행): ① `한국어` + `Summary` 클릭 → storage 키 실측
  ② 패널 타깃 닫고 재오픈 → aria-pressed/aria-selected로 복원 실측
  ③ `chrome.runtime.reload()` 후 재확인 ④ 키 상태 savedAt 불변.

## 5. 비범위

- 탭별 스크롤 위치 기억 (기존 결정 유지: 전환은 항상 최상단/활성 행 복원 로직)
- Options 페이지 노출, 영상별 선호, `chrome.storage.sync`, 기존 `activeTab`
  스냅백·스크롤 효과 변경
