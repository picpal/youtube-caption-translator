# 패널 본문 글자 크기 조절 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드패널 헤더의 `Aa` 버튼으로 본문(자막·요약·노트) 글자 크기를 6단계로 조절하고, 그 선택을 `chrome.storage.local`에 영속화한다.

**Architecture:** `:root`의 CSS 변수 `--panel-font-scale` 하나를 App 루트가 갱신하고, 본문 텍스트는 `calc(<기존 px> * var(--panel-font-scale))`로 정의된 `.body-*` 클래스 6종을 쓴다. 배율 상태는 React가 들되 본문 컴포넌트로는 내려보내지 않으므로, 배율을 바꿔도 스크립트 수백 행이 리렌더되지 않는다. 배율 계산은 순수 모듈(`font-scale.ts`)로 분리해 단위 테스트로 고정한다.

**Tech Stack:** WXT + React 18 + TypeScript + Tailwind 3 (px 임의값 위주) + vitest(jsdom) + pnpm

**Spec:** `docs/superpowers/specs/2026-08-05-panel-font-scale-design.md`

## Global Constraints

- 배율 단계는 정확히 `[0.9, 1, 1.15, 1.3, 1.5, 1.75]`, 기본값 `1`.
- 확대 대상은 **본문뿐**: 스크립트 원문·번역문·타임코드, 요약 본문·소제목·섹션 라벨·키워드 칩·흐름 타임코드, 노트 인용문. 헤더·탭바·버튼(`다시 시도`/`요약 생성` 포함)·영상 카드·라이브러리 목록·노트 빈 상태 안내문·`ExportDocument`는 **건드리지 않는다.**
- 배율 100%에서 렌더 결과는 변경 전과 픽셀 단위로 동일해야 한다 (`.body-*`의 base px는 기존 값과 1:1).
- 새 npm 의존성·새 권한·새 서페이스를 추가하지 않는다.
- 키보드 단축키(Ctrl +/−)는 이번 범위 밖이다.
- 주석은 한국어, 기존 파일의 주석 밀도·톤을 따른다.
- 테스트 실행은 `pnpm test`(= `vitest run`), 빌드는 `pnpm build`.

---

### Task 1: 배율 계산 순수 모듈

**Files:**
- Create: `src/lib/font-scale.ts`
- Test: `src/lib/font-scale.test.ts`

**Interfaces:**
- Consumes: 없음 (이 계획의 첫 작업)
- Produces:
  - `FONT_SCALE_STEPS: readonly [0.9, 1, 1.15, 1.3, 1.5, 1.75]`
  - `DEFAULT_FONT_SCALE: number` (= 1)
  - `normalizeFontScale(raw: unknown): number`
  - `stepFontScale(current: number, dir: 1 | -1): number`
  - `formatFontScale(scale: number): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/font-scale.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STEPS,
  formatFontScale,
  normalizeFontScale,
  stepFontScale,
} from './font-scale';

describe('normalizeFontScale', () => {
  it('keeps a value that is one of the steps', () => {
    expect(normalizeFontScale(1.3)).toBe(1.3);
  });

  it('falls back to the default for a number outside the ladder', () => {
    expect(normalizeFontScale(1.2)).toBe(DEFAULT_FONT_SCALE);
  });

  it('falls back for non-numbers, undefined and NaN', () => {
    expect(normalizeFontScale('1.3')).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(undefined)).toBe(DEFAULT_FONT_SCALE);
    expect(normalizeFontScale(Number.NaN)).toBe(DEFAULT_FONT_SCALE);
  });
});

describe('stepFontScale', () => {
  it('moves one step up and down the ladder', () => {
    expect(stepFontScale(1, 1)).toBe(1.15);
    expect(stepFontScale(1.15, -1)).toBe(1);
  });

  it('stays put at both boundaries', () => {
    const min = FONT_SCALE_STEPS[0];
    const max = FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1];
    expect(stepFontScale(min, -1)).toBe(min);
    expect(stepFontScale(max, 1)).toBe(max);
  });

  it('treats a corrupt current value as the default before stepping', () => {
    expect(stepFontScale(99, 1)).toBe(1.15);
  });
});

describe('formatFontScale', () => {
  it('renders whole percents without floating point residue', () => {
    expect(formatFontScale(0.9)).toBe('90%');
    expect(formatFontScale(1.15)).toBe('115%');
    expect(formatFontScale(1.75)).toBe('175%');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test src/lib/font-scale.test.ts`
Expected: FAIL — `Failed to resolve import "./font-scale"`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/lib/font-scale.ts`:

```ts
/**
 * 패널 본문 배율 (spec 2026-08-05). 시계·난수·storage를 읽지 않는 순수 모듈 —
 * 단계 계산과 표시 문자열만 책임진다.
 */
export const FONT_SCALE_STEPS = [0.9, 1, 1.15, 1.3, 1.5, 1.75] as const;

export const DEFAULT_FONT_SCALE = 1;

const STEPS: readonly number[] = FONT_SCALE_STEPS;

/**
 * 저장된 값을 단계 목록 안의 값으로 좁힌다. 가장 가까운 단계로 반올림하지 않는
 * 이유는 spec §5.1 — 단계 목록이 나중에 바뀌면 저장된 옛 값은 의미를 잃는다.
 * 조용히 근처 값으로 끌어다 붙이는 것보다 기본값으로 되돌리는 편이 예측 가능하다.
 */
export function normalizeFontScale(raw: unknown): number {
  return STEPS.includes(raw as number) ? (raw as number) : DEFAULT_FONT_SCALE;
}

/** 한 단계 위(`1`)/아래(`-1`). 경계에서는 현재 값을 그대로 돌려준다. */
export function stepFontScale(current: number, dir: 1 | -1): number {
  const index = STEPS.indexOf(normalizeFontScale(current));
  const next = index + dir;
  return next >= 0 && next < STEPS.length ? STEPS[next] : STEPS[index];
}

/** 1.15 → "115%". 0.1 + 0.05 류의 부동소수 잔재가 문자열로 새지 않도록 반올림한다. */
export function formatFontScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm test src/lib/font-scale.test.ts`
Expected: PASS (10 assertions, 3 describe 블록)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/font-scale.ts src/lib/font-scale.test.ts
git commit -m "Add the panel font scale ladder as a pure module"
```

---

### Task 2: 배율 영속화 (`panel-prefs` 확장)

**Files:**
- Modify: `src/lib/panel-prefs.ts`
- Test: `src/lib/panel-prefs.test.ts` (기존 파일 수정 — 아래 Step 1의 기존 단언 갱신 포함)

**Interfaces:**
- Consumes: Task 1의 `DEFAULT_FONT_SCALE`, `normalizeFontScale`
- Produces:
  - `PanelPrefs`에 `fontScale: number` 필드 추가
  - `savePanelFontScale(scale: number): Promise<void>`
  - storage 키 문자열 `'panelFontScale'`

**주의:** 기존 테스트 두 개가 깨진다 — `loads both keys in a single get call`(get 인자 배열)과 `returns defaults when nothing is stored`(`toEqual` 객체). 두 곳을 이 태스크에서 함께 갱신한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/panel-prefs.test.ts`의 import에 `savePanelFontScale`을 더한다:

```ts
import {
  DEFAULT_PANEL_PREFS,
  loadPanelPrefs,
  savePanelDisplayMode,
  savePanelFontScale,
  savePanelLastTab,
} from './panel-prefs';
```

기존 두 단언을 세 키 기준으로 갱신한다:

```ts
  it('loads both keys in a single get call', async () => {
    await loadPanelPrefs();
    expect(chrome.storage.local.get).toHaveBeenCalledOnce();
    expect(chrome.storage.local.get).toHaveBeenCalledWith([
      'panelDisplayMode',
      'panelLastTab',
      'panelFontScale',
    ]);
  });

  it('returns defaults when nothing is stored', async () => {
    expect(await loadPanelPrefs()).toEqual({
      displayMode: 'both',
      lastTab: 'transcript',
      fontScale: 1,
    });
    expect(DEFAULT_PANEL_PREFS).toEqual({
      displayMode: 'both',
      lastTab: 'transcript',
      fontScale: 1,
    });
  });
```

기존 `returns stored values when both are valid` / `falls back per field ...` 세 테스트의 `toEqual` 객체에도 각각 `fontScale: 1`을 더한다 (그 테스트들은 `panelFontScale`을 저장하지 않으므로 기본값이 나와야 한다).

그리고 새 describe 블록을 파일 끝에 더한다:

```ts
describe('panel font scale', () => {
  it('round-trips a stored scale', async () => {
    await savePanelFontScale(1.3);
    expect(store.panelFontScale).toBe(1.3);
    expect((await loadPanelPrefs()).fontScale).toBe(1.3);
  });

  it('writes only its own key', async () => {
    await savePanelFontScale(1.5);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ panelFontScale: 1.5 });
  });

  it('never persists a value outside the ladder', async () => {
    await savePanelFontScale(4);
    expect(store.panelFontScale).toBe(1);
  });

  it('falls back per field when only the scale is corrupt', async () => {
    store.panelDisplayMode = 'ko';
    store.panelLastTab = 'summary';
    store.panelFontScale = 'huge';
    expect(await loadPanelPrefs()).toEqual({
      displayMode: 'ko',
      lastTab: 'summary',
      fontScale: 1,
    });
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test src/lib/panel-prefs.test.ts`
Expected: FAIL — `savePanelFontScale is not a function` 및 `toEqual` 불일치

- [ ] **Step 3: 최소 구현을 쓴다**

`src/lib/panel-prefs.ts`를 이렇게 고친다 (변경 지점만 표시, 나머지 줄은 그대로 둔다):

import에 한 줄 추가:

```ts
import { DEFAULT_FONT_SCALE, normalizeFontScale } from '~/lib/font-scale';
```

키 상수 아래에 한 줄 추가:

```ts
const FONT_SCALE_KEY = 'panelFontScale';
```

인터페이스와 기본값:

```ts
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
```

`loadPanelPrefs`:

```ts
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
```

파일 끝에 저장 함수 추가:

```ts
// 저장 시점에도 정규화한다 — 읽기만 막으면 목록 밖 값이 storage에 남아 다음
// 버전에서 되살아난다.
export async function savePanelFontScale(scale: number): Promise<void> {
  await chrome.storage.local.set({ [FONT_SCALE_KEY]: normalizeFontScale(scale) });
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm test src/lib/panel-prefs.test.ts`
Expected: PASS (기존 테스트 + 새 4개)

- [ ] **Step 5: 전체 회귀를 돌린다**

Run: `pnpm test`
Expected: PASS — 특히 `useExportData`/`export-doc` 계열이 `loadPanelPrefs`의 새 필드로 깨지지 않는지 확인 (`DownloadMenu`는 `{ displayMode }`만 구조분해하므로 영향 없음)

- [ ] **Step 6: 커밋**

```bash
git add src/lib/panel-prefs.ts src/lib/panel-prefs.test.ts
git commit -m "Persist the panel font scale alongside the other panel prefs"
```

---

### Task 3: CSS 사다리 + 스크립트·노트 본문 치환

**Files:**
- Modify: `src/styles/globals.css`
- Modify: `src/components/TranscriptList.tsx` (타임코드 `span`, `SegmentTexts`)
- Modify: `src/components/NotesPanel.tsx` (타임코드 `span`, 발췌 인용문)

**Interfaces:**
- Consumes: 없음 (CSS는 Task 5·6이 값을 넣기 전까지 `var()` 폴백 없이 `:root` 기본값 `1`로 동작)
- Produces: 전역 클래스 `.body-2xs .body-xs .body-sm .body-md .body-lg .body-xl`, CSS 변수 `--panel-font-scale`

- [ ] **Step 1: CSS 사다리를 추가한다**

`src/styles/globals.css`의 `@tailwind utilities;` 아래, `html, body` 규칙 앞에 넣는다:

```css
/* 패널 본문 배율 (spec 2026-08-05). 본문 타이포그래피가 px 임의값으로 박혀 있어
   `html { font-size }`로는 글자가 커지지 않는다 — 그래서 본문이 쓰는 크기만
   사다리로 뽑고, App 루트가 이 변수 하나를 갱신한다. base px는 치환 전 값과
   1:1이라 배율 100%에서는 이전과 픽셀 단위로 동일하다.
   `leading-relaxed`는 배수라 폰트 크기를 따라 자동으로 늘어난다. */
:root {
  --panel-font-scale: 1;
}

.body-2xs { font-size: calc(10px * var(--panel-font-scale)); }
.body-xs  { font-size: calc(10.5px * var(--panel-font-scale)); }
.body-sm  { font-size: calc(11px * var(--panel-font-scale)); }
.body-md  { font-size: calc(12px * var(--panel-font-scale)); }
.body-lg  { font-size: calc(12.5px * var(--panel-font-scale)); }
.body-xl  { font-size: calc(13px * var(--panel-font-scale)); }
```

- [ ] **Step 2: 스크립트 행을 치환한다**

`src/components/TranscriptList.tsx`

타임코드 `span` (약 244행) — `w-12`(48px)를 `em`으로 바꾸는 이유는 spec §4.3(48 / 11 ≈ 4.36):

```tsx
              <span className="body-sm w-[4.4em] flex-none text-right font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
                {formatTimestamp(segment.startSec)}
              </span>
```

`SegmentTexts` (약 326~351행) 전체를 이렇게 바꾼다 — 클래스만 바뀌고 구조·주석은 그대로다:

```tsx
export function SegmentTexts({ texts }: { texts: VisibleTexts }) {
  if (texts.kind === 'dual') {
    return (
      <>
        <span className="body-md leading-relaxed text-neutral-500 dark:text-neutral-400">
          {texts.secondaryText}
        </span>
        <span className="body-xl leading-relaxed text-neutral-900 dark:text-neutral-100">
          {texts.primaryText}
        </span>
      </>
    );
  }
  if (texts.kind === 'secondary-only') {
    return (
      <span className="body-md leading-relaxed text-neutral-500 dark:text-neutral-400">
        {texts.text}
      </span>
    );
  }
  return (
    <span className="body-xl leading-relaxed text-neutral-900 dark:text-neutral-100">
      {texts.text}
    </span>
  );
}
```

`SegmentTexts` 위의 JSDoc에 한 문장을 덧붙인다:

```
 * 컴포넌트를 공유하므로 두 화면의 타이포그래피는 구조적으로 갈라질 수 없다.
 * 크기는 `.body-*`(globals.css)를 거치므로 헤더 `Aa`의 배율을 함께 따른다.
```

- [ ] **Step 3: 노트 행을 치환한다**

`src/components/NotesPanel.tsx`

타임코드 `span` (약 61행):

```tsx
            <span className="body-sm w-[4.4em] flex-none text-right font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(bookmark.startSec)}
            </span>
```

발췌 인용문 (약 87행):

```tsx
      <span className="body-xl border-l-2 border-neutral-300 pl-2 leading-relaxed text-neutral-900 dark:border-neutral-700 dark:text-neutral-100">
        {bookmark.excerpt}
      </span>
```

빈 상태 문구(`text-sm`/`text-xs`가 붙은 두 `<p>`)와 삭제 버튼은 **건드리지 않는다** — spec §2에서 고정하기로 한 자리다.

- [ ] **Step 4: 잔재가 없는지 확인한다**

Run: `grep -n "text-\[13px\]\|text-\[11px\]\|text-xs\|w-12" src/components/TranscriptList.tsx src/components/NotesPanel.tsx`
Expected: `NotesPanel.tsx`의 빈 상태 `text-xs` 한 줄만 남는다. `text-[13px]`·`text-[11px]`·`w-12`은 0건.

- [ ] **Step 5: 회귀 테스트와 타입 확인**

Run: `pnpm test && pnpm build`
Expected: PASS / 빌드 성공 (`TranscriptList.test.ts`는 순수 로직이라 클래스 변경에 영향받지 않는다)

- [ ] **Step 6: 커밋**

```bash
git add src/styles/globals.css src/components/TranscriptList.tsx src/components/NotesPanel.tsx
git commit -m "Route transcript and notes body text through the scalable size ladder"
```

---

### Task 4: 요약 패널 본문 치환

**Files:**
- Modify: `src/components/SummaryPanel.tsx`

**Interfaces:**
- Consumes: Task 3의 `.body-*` 클래스
- Produces: 없음

- [ ] **Step 1: 라벨과 본문 클래스를 바꾼다**

`src/components/SummaryPanel.tsx`에서 다음을 정확히 치환한다.

라벨 상수 (약 8행):

```ts
const LABEL_CLS = 'body-xs font-semibold tracking-wide text-neutral-400 dark:text-neutral-500';
```

로딩 문구 (약 31행):

```tsx
    return <p className="body-md px-4 py-6 text-neutral-400 dark:text-neutral-500">요약 불러오는 중…</p>;
```

생성 중 문구 (약 38행):

```tsx
        <p className="body-md text-neutral-500 dark:text-neutral-400">
```

실패 문구 (약 48행):

```tsx
        <p className="body-lg leading-relaxed text-red-600 dark:text-red-400">
```

빈 상태 안내 (약 65행):

```tsx
        <p className="body-md leading-relaxed text-neutral-500 dark:text-neutral-400">
```

`다시 시도`(약 54행)와 `요약 생성`(약 73행) **버튼의 `text-[12.5px]`는 그대로 둔다.**

- [ ] **Step 2: 요약 본문 블록을 바꾼다**

문제 문단 (약 85행):

```tsx
      <p className="-mt-3 body-lg leading-relaxed text-neutral-800 dark:text-neutral-200">
```

핵심 주장 인덱스 (약 93행)와 본문 (약 96행):

```tsx
            <span className="body-2xs pt-[2px] font-mono text-neutral-400 dark:text-neutral-500">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="body-lg leading-relaxed text-neutral-800 dark:text-neutral-200">
              {arg}
            </span>
```

발표 흐름 타임코드(약 119행)와 제목(약 122행) — `w-[38px]`을 `em`으로 바꾸는 근거는 spec §4.3 (38 / 11 ≈ 3.45):

```tsx
            <span className="body-sm w-[3.5em] flex-none font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(section.startSec)}
            </span>
            <span className="body-lg text-neutral-800 dark:text-neutral-200">{section.title}</span>
```

키워드 칩 (약 133행):

```tsx
              className="body-sm rounded border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
```

결론 문단 (약 143행):

```tsx
        <p className="body-lg leading-relaxed text-neutral-800 dark:text-neutral-200">
```

- [ ] **Step 3: 잔재 확인**

Run: `grep -n "text-\[1[0-9.]*px\]" src/components/SummaryPanel.tsx`
Expected: 정확히 2건 — `다시 시도`·`요약 생성` 버튼의 `text-[12.5px]`

- [ ] **Step 4: 회귀 테스트와 빌드**

Run: `pnpm test && pnpm build`
Expected: PASS / 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add src/components/SummaryPanel.tsx
git commit -m "Route summary body text through the scalable size ladder"
```

---

### Task 5: `FontSizeMenu` 컴포넌트

**Files:**
- Create: `src/components/FontSizeMenu.tsx`

**Interfaces:**
- Consumes: Task 1의 `FONT_SCALE_STEPS`, `DEFAULT_FONT_SCALE`, `stepFontScale`, `formatFontScale`
- Produces: `FontSizeMenu({ scale, onChange }: { scale: number; onChange: (next: number) => void })` — 자기 상태는 팝오버 열림 여부뿐이고, 배율은 부모가 소유한다 (Task 6이 그 부모다)

- [ ] **Step 1: 컴포넌트를 쓴다**

`src/components/FontSizeMenu.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STEPS,
  formatFontScale,
  stepFontScale,
} from '~/lib/font-scale';

const MIN_SCALE = FONT_SCALE_STEPS[0];
const MAX_SCALE = FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1];

/**
 * 헤더의 `Aa` 버튼 (spec 2026-08-05 §3). 본문 배율만 바꾸고, 배율 값 자체는
 * 부모(App)가 소유한다 — 이 컴포넌트는 storage도 CSS 변수도 만지지 않는다.
 *
 * 열고 닫는 규칙은 `DownloadMenu`와 같지만 **항목 선택으로는 닫지 않는다**:
 * A−/A+는 원하는 크기가 나올 때까지 연달아 누르는 컨트롤이라, 한 번 누를 때마다
 * 닫히면 쓸 수 없다.
 */
export function FontSizeMenu({
  scale,
  onChange,
}: {
  scale: number;
  onChange: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 마운트 시(open이 처음부터 false) 트리거로 포커스를 되돌리지 않기 위한 추적 —
  // DownloadMenu와 같은 이유다.
  const wasOpenRef = useRef(false);

  // 열릴 때 첫 번째 '활성' 컨트롤로 포커스를 넣는다. 첫 항목을 고정으로 집으면
  // 최소 배율에서 A−가 disabled라 포커스가 들어가지 않는다.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      rootRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // 바깥 클릭 / Escape로 닫기. 열려 있을 때만 문서 리스너를 붙인다.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="글자 크기"
        aria-haspopup="true"
        aria-expanded={open}
        className="rounded px-1.5 py-1 text-[12px] font-semibold leading-none text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        Aa
      </button>

      {open && (
        <div
          role="group"
          aria-label="글자 크기"
          className="absolute right-0 z-10 mt-1 w-40 rounded-[7px] border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div className="flex items-center justify-between gap-2">
            <StepButton
              label="글자 작게"
              disabled={scale <= MIN_SCALE}
              onClick={() => onChange(stepFontScale(scale, -1))}
            >
              A−
            </StepButton>
            {/* 팝오버 자신은 배율을 따르지 않는다 — 컨트롤은 고정 크기(spec §2). */}
            <span
              aria-live="polite"
              className="min-w-[3.5em] text-center text-[12px] font-medium tabular-nums text-neutral-800 dark:text-neutral-200"
            >
              {formatFontScale(scale)}
            </span>
            <StepButton
              label="글자 크게"
              disabled={scale >= MAX_SCALE}
              onClick={() => onChange(stepFontScale(scale, 1))}
            >
              A+
            </StepButton>
          </div>
          <button
            type="button"
            disabled={scale === DEFAULT_FONT_SCALE}
            onClick={() => onChange(DEFAULT_FONT_SCALE)}
            className="mt-1.5 w-full rounded px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-300 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:disabled:text-neutral-700"
          >
            기본값으로
          </button>
        </div>
      )}
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 flex-1 rounded-[5px] border border-neutral-200 text-[12.5px] font-semibold text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:border-neutral-100 disabled:text-neutral-300 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900 dark:disabled:border-neutral-900 dark:disabled:text-neutral-700"
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: 타입과 빌드를 확인한다**

Run: `pnpm build`
Expected: 빌드 성공 (아직 어디서도 쓰이지 않지만 컴파일 대상에 들어간다)

- [ ] **Step 3: 커밋**

```bash
git add src/components/FontSizeMenu.tsx
git commit -m "Add the Aa font size popover to the panel component set"
```

---

### Task 6: App 배선 + README

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx` (import 블록, `App()` 상태부, 헤더 마크업)
- Modify: `README.md:96-108` (`## 사용하기` 절)

**Interfaces:**
- Consumes: Task 1의 `DEFAULT_FONT_SCALE`, Task 2의 `loadPanelPrefs().fontScale`·`savePanelFontScale`, Task 5의 `FontSizeMenu`
- Produces: 런타임에 `document.documentElement`의 `--panel-font-scale`이 저장된 배율로 설정된다

- [ ] **Step 1: import를 더한다**

`entrypoints/sidepanel/App.tsx` 상단:

```ts
import { FontSizeMenu } from '~/components/FontSizeMenu';
```

(기존 컴포넌트 import들 사이, `DownloadMenu` 다음 줄에 알파벳 순으로 넣는다.)

`panel-prefs` import 줄을 확장한다:

```ts
import {
  loadPanelPrefs,
  savePanelDisplayMode,
  savePanelFontScale,
  savePanelLastTab,
  type PanelTab,
} from '~/lib/panel-prefs';
```

`font-scale` import를 더한다 (`~/lib/bookmarks` import 다음 줄):

```ts
import { DEFAULT_FONT_SCALE } from '~/lib/font-scale';
```

- [ ] **Step 2: `App()`에 상태·로드·적용을 더한다**

`const [view, setView] = useState<'video' | 'library'>('video');` 아래에 넣는다:

```tsx
  // 본문 배율 (spec 2026-08-05 §5.3). 헤더가 이 컴포넌트에 있어 여기서 소유한다.
  // ReadyBody도 loadPanelPrefs를 부르므로 storage.local.get이 한 번 더 나가지만,
  // 로컬 읽기 한 번이 ReadyBody를 거치는 프롭 드릴링보다 싸다 — 게다가 ReadyBody는
  // 준비 상태에서만 마운트되는 반면 이 버튼은 항상 떠 있어야 한다.
  const [fontScale, setFontScale] = useState(DEFAULT_FONT_SCALE);

  useEffect(() => {
    let cancelled = false;
    void loadPanelPrefs()
      .then((prefs) => {
        if (!cancelled) setFontScale(prefs.fontScale);
      })
      .catch(() => {}); // 컨텍스트 무효화 등 — 기본 배율로 그냥 간다
    return () => {
      cancelled = true;
    };
  }, []);

  // 상태를 본문 컴포넌트로 내려보내지 않고 CSS 변수 하나로 흘린다 — 배율을 바꿔도
  // 스크립트 수백 행이 리렌더되지 않는다.
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-font-scale', String(fontScale));
  }, [fontScale]);

  const changeFontScale = (next: number) => {
    setFontScale(next);
    void savePanelFontScale(next).catch(() => {}); // displayMode 저장과 같은 규칙
  };
```

- [ ] **Step 3: 헤더에 버튼을 꽂는다**

`{ready && view === 'video' && <DownloadMenu />}` 와 설정(⚙) 버튼 사이에 한 줄:

```tsx
          {ready && view === 'video' && <DownloadMenu />}
          <FontSizeMenu scale={fontScale} onChange={changeFontScale} />
          <button
            type="button"
            onClick={() => chrome.runtime.openOptionsPage()}
```

`DownloadMenu`와 달리 `ready` 조건을 걸지 않는다 — 자막을 불러오는 동안에도 크기는 바꿀 수 있어야 한다 (spec §3.1).

- [ ] **Step 4: 빌드와 회귀 테스트**

Run: `pnpm test && pnpm build`
Expected: PASS / 빌드 성공

- [ ] **Step 5: README를 갱신한다**

`## 사용하기`의 5번 항목 아래에 6번을 더한다:

```markdown
6. 글씨가 작으면 헤더의 **Aa** 를 눌러 본문 글자 크기를 키울 수 있습니다
   (90~175%). 고른 크기는 다음에 열 때도 유지됩니다.
```

- [ ] **Step 6: 커밋**

```bash
git add entrypoints/sidepanel/App.tsx README.md
git commit -m "Wire the font size control into the panel header"
```

---

### Task 7: 실제 확장에서 확인

**Files:**
- Modify: 없음 (문제가 발견되면 해당 태스크의 파일로 되돌아간다)

**Interfaces:**
- Consumes: Task 1~6 전체
- Produces: 없음 (검증만)

- [ ] **Step 1: dev 프로필로 확장을 올린다**

Run: `pnpm build && pnpm dev:chrome`
Expected: dev 프로필 크롬이 뜨고 확장이 로드된다.

**주의:** `loadUnpacked`만으로는 살아 있는 서비스워커가 교체되지 않는다. 코드 변경 후에는 `chrome.runtime.reload()`를 거쳐야 새 번들이 돈다.

- [ ] **Step 2: 체크리스트를 눈으로 확인한다**

자막이 있는 영상에서 패널을 열고:

1. `Aa` → `A+`를 최대(175%)까지 연타 — 팝오버가 **닫히지 않고** 배율 표시가 따라 오른다
2. 175%에서 스크립트 타임코드(`1:23:45` 형태가 나오는 1시간 이상 영상)가 컬럼을 넘치지 않고, 본문 좌측 정렬이 유지된다
3. Summary 탭 — 본문·소제목·키워드 칩·흐름 타임코드가 같은 배율로 커지고, `다시 시도`/`요약 생성` 버튼은 **그대로**다
4. Notes 탭 — 인용문·타임코드가 커지고 빈 상태 안내문은 그대로다
5. 헤더·탭바·영상 카드·라이브러리 목록이 **모든 배율에서 변하지 않는다**
6. 90%로 내렸다가 `기본값으로` — 100%에서 버튼이 `disabled`가 된다
7. 패널을 닫았다 다시 열면 마지막 배율이 유지된다
8. 팝오버가 바깥 클릭·`Escape`로 닫히고, 닫힌 뒤 포커스가 `Aa`로 돌아온다

- [ ] **Step 3: 실패한 항목이 있으면 그 태스크로 돌아가 고치고 다시 확인한다**

체크리스트 2번이 깨지면 Task 3·4의 `em` 폭을, 3~5번이 깨지면 치환 범위를, 7번이 깨지면 Task 2·6의 저장/로드 경로를 본다.

- [ ] **Step 4: 최종 확인과 커밋**

Run: `pnpm test && pnpm build`
Expected: PASS / 빌드 성공

수정이 있었다면:

```bash
git add -A
git commit -m "Fix font scale issues found in live verification"
```

---

## 참고

- 스펙: `docs/superpowers/specs/2026-08-05-panel-font-scale-design.md`
- 팝오버 패턴 원본: `src/components/DownloadMenu.tsx`
- 기존 패널 설정 영속화 패턴: `src/lib/panel-prefs.ts` (flat 키, 필드별 폴백)
