# 패널 본문 글자 크기 조절

2026-08-05

## 1. 문제

사이드패널은 `chrome-extension://` 문서다. 탭의 페이지 줌(Ctrl +/−)은 탭 콘텐츠의
오리진에만 걸리므로, 사용자가 YouTube를 확대해도 **패널만 원래 크기 그대로 남는다.**
자막을 오래 읽는 화면인데 12~13px에 고정돼 있고, 사용자는 그것을 키울 방법이 없다.

그렇다고 루트 폰트 크기를 키우는 흔한 해법도 이 코드베이스에선 통하지 않는다.
본문 타이포그래피가 `text-[13px]`·`text-[12.5px]` 같은 **px 임의값**으로 박혀 있어
`html { font-size }`를 올려도 여백(rem 기반 Tailwind 스페이싱)만 벌어지고 글자는
그대로다. 크기 조절 수단을 새로 만들어야 한다.

## 2. 범위

**한다**

- 헤더에 `Aa` 버튼 하나 → 팝오버에서 `A−` / 현재 배율 / `A+`, `기본값으로`
- 6단계 배율 `90 / 100 / 115 / 130 / 150 / 175%`, 기본 100%
- 배율을 `chrome.storage.local`에 영속화 — 패널을 닫았다 열어도 유지
- 확대 대상은 **읽는 본문**: 스크립트 원문·번역문·타임코드, 요약 본문·소제목·
  섹션 라벨·키워드 칩, 노트 인용문
- 타임코드 고정폭 컬럼을 `em`으로 바꿔 배율이 올라가도 정렬이 깨지지 않게 한다

**하지 않는다** (모두 의도적 제외)

- **패널 전체 줌**(`zoom`/`transform: scale`) — 좁은 패널에서 버튼·헤더까지 커지면
  가로 여유가 먼저 죽는다. 사용자가 원한 것은 읽는 글자다
- **헤더·탭바·버튼·영상 카드·라이브러리 목록·빈 상태 안내문** — 크기 고정. 컨트롤
  레이아웃은 배율과 무관하게 안정적이어야 한다
- **내보내기 문서**(`ExportDocument`) — 별도 문서이고 인쇄 대상이라 패널 배율과
  무관하다
- **Options 페이지 항목** — 조절은 읽는 자리에서 즉시 일어나야 한다. 설정창을
  왕복하면 피드백 루프가 끊긴다
- **키보드 단축키(Ctrl +/−)** — M3 백로그의 별도 shortcut 항목과 겹친다. 그때 이
  배율도 함께 묶는다
- **자유 입력 슬라이더** — 단계가 6개면 충분하고, 임의값은 타임코드 폭 검증 대상만
  늘린다
- 새 권한, 새 의존성, 새 서페이스 (패널 + Options 둘 유지)

## 3. 화면

### 3.1 헤더의 `Aa` 버튼

헤더는 이미 상태 뱃지·라이브러리·내려받기·설정 넷을 달고 있다. `A−`/`A+` 두 개를
상시 노출하면 제목이 `truncate`로 먹힌다. 그래서 **트리거 하나(`Aa`) + 팝오버**로
간다. 설정(⚙) 아이콘 **앞**, 내려받기(⤓) **뒤**에 놓는다.

```
┌──────────────────────────────┐
│ YouTube Caption…  ●준비됨 ⬚ ⤓ Aa ⚙ │
└────────────────────────────┬─┘
                    ┌────────┴──────┐
                    │ 글자 크기       │
                    │  A−   130%  A+ │
                    │   기본값으로     │
                    └───────────────┘
```

버튼은 패널 상태와 무관하게 **항상** 보인다. `DownloadMenu`처럼 준비 상태에
묶으면, 자막을 불러오는 동안에는 크기를 못 바꾸는 이상한 규칙이 생긴다.

`A−`는 최소 단계에서, `A+`는 최대 단계에서 `disabled`. `기본값으로`는 100%일 때
`disabled`. 현재 배율은 `130%`처럼 퍼센트로 읽는다.

### 3.2 팝오버 동작

`DownloadMenu`가 이미 확립한 패턴을 그대로 재사용한다. 새로 발명하지 않는다.

- 열릴 때 첫 항목으로 포커스, 닫힐 때 트리거로 복원 (`wasOpenRef` 포함)
- 바깥 `pointerdown` / `Escape`로 닫기, 리스너는 열려 있을 때만 등록
- 항목 선택으로는 **닫히지 않는다** — `A−`/`A+`는 연속으로 누르는 컨트롤이다.
  이 점만 `DownloadMenu`(선택 즉시 닫힘)와 다르다

## 4. 메커니즘

### 4.1 CSS 변수 하나 + 본문 전용 클래스

`:root`의 `--panel-font-scale` 하나만 갱신하면 본문 전체가 따라 움직인다.
React 상태를 본문 컴포넌트까지 흘려보내지 않으므로, 배율을 바꿔도 스크립트
600행이 리렌더되지 않는다.

```css
/* globals.css */
:root { --panel-font-scale: 1; }

.body-2xs { font-size: calc(10px   * var(--panel-font-scale)); }
.body-xs  { font-size: calc(10.5px * var(--panel-font-scale)); }
.body-sm  { font-size: calc(11px   * var(--panel-font-scale)); }
.body-md  { font-size: calc(12px   * var(--panel-font-scale)); }
.body-lg  { font-size: calc(12.5px * var(--panel-font-scale)); }
.body-xl  { font-size: calc(13px   * var(--panel-font-scale)); }
```

기존 px 임의값과 **1:1로 대응하는 사다리**다. 배율 100%에서는 지금 화면과 픽셀
단위로 동일하고, 이번 변경이 타이포그래피를 재설계하지 않는다는 점이 코드로
보장된다.

`leading-relaxed`는 배수(unitless)라 폰트 크기를 따라 자동으로 늘어난다. 줄간격을
따로 손댈 필요가 없다.

이 클래스들은 `@tailwind utilities` 뒤에 오는 평범한 CSS라 같은 특정도에서 나중에
선언된 쪽이 이긴다. 그래도 치환할 자리에서 기존 `text-[…]`·`text-xs`는 **지운다** —
두 규칙이 공존하면 나중에 읽는 사람이 어느 쪽이 이기는지 다시 따져야 한다.

### 4.2 클래스 → 적용처

| 클래스 | 기존 값 | 적용처 |
|---|---|---|
| `.body-2xs` | `text-[10px]` | `SummaryPanel` 핵심 주장 앞 인덱스 |
| `.body-xs` | `text-[10.5px]` | `SummaryPanel` 섹션 라벨(`SECTION_LABEL`) |
| `.body-sm` | `text-[11px]` | 타임코드(`TranscriptList`·`NotesPanel`), 요약 흐름 타임코드, 키워드 칩 |
| `.body-md` | `text-xs` / `text-[12px]` | 자막 원문(`SegmentTexts`), 요약 보조 문구 |
| `.body-lg` | `text-[12.5px]` | 요약 본문·소제목·오류 문구 |
| `.body-xl` | `text-[13px]` | 자막 번역문·단일 텍스트(`SegmentTexts`), 노트 인용문 |

`SegmentTexts`는 Transcript 행과 Notes 행이 공유하는 유일한 타이포그래피 자리라,
여기 한 번 고치면 두 화면이 함께 따라온다.

`SummaryPanel`의 `다시 시도`·`요약 생성` 버튼(`text-[12.5px]`)은 **건드리지 않는다.**
버튼은 §2에서 고정하기로 한 컨트롤이다.

### 4.3 타임코드 컬럼 폭 — 이번 변경의 진짜 리스크

타임코드는 고정폭 컬럼 안에 있다. 175%에서 `1:23:45`가 컬럼을 넘치면 본문이
밀려 정렬이 무너진다.

| 자리 | 기존 | 변경 | 근거 |
|---|---|---|---|
| `TranscriptList` 행 | `w-12` (48px) | `w-[4.4em]` | 48 / 11 ≈ 4.36 |
| `NotesPanel` 행 | `w-12` (48px) | `w-[4.4em]` | 위와 같은 마크업 |
| `SummaryPanel` 흐름 | `w-[38px]` | `w-[3.5em]` | 38 / 11 ≈ 3.45 |

`width`의 `em`은 **그 요소 자신의 폰트 크기**를 기준으로 하므로, `.body-sm`이 커지면
컬럼도 같은 비율로 커진다. 별도 계산식이 필요 없다.

## 5. 데이터

### 5.1 `src/lib/font-scale.ts` (신규, 순수)

시계·난수·storage를 읽지 않는다. 단계 계산만 한다.

```ts
export const FONT_SCALE_STEPS = [0.9, 1, 1.15, 1.3, 1.5, 1.75] as const;
export const DEFAULT_FONT_SCALE = 1;

normalizeFontScale(raw: unknown): number   // 단계 목록에 없으면 DEFAULT
stepFontScale(current: number, dir: 1 | -1): number  // 경계에서 그대로
formatFontScale(scale: number): string     // 1.15 → "115%"
```

`normalizeFontScale`이 **가장 가까운 단계로 반올림하지 않고 기본값으로 떨어지는** 이유:
단계 목록이 나중에 바뀌면 저장된 옛 값은 의미를 잃는다. 조용히 근처 값으로 끌어다
붙이는 것보다 기본값으로 되돌리는 편이 예측 가능하다.

### 5.2 `src/lib/panel-prefs.ts` (확장)

세 번째 flat 키 `panelFontScale`을 더한다. 기존 두 키와 같은 규칙 — 각자 자기 키만
쓰고(read-modify-write 없음), 한 키가 오염돼도 다른 키를 끌어내리지 않는다.

```ts
export interface PanelPrefs {
  displayMode: DisplayMode;
  lastTab: PanelTab;
  fontScale: number;      // 추가
}
export async function savePanelFontScale(scale: number): Promise<void>;
```

`loadPanelPrefs`는 `chrome.storage.local.get`에 키를 하나 더 넣고, `fontScale`은
`normalizeFontScale`로 통과시킨다.

### 5.3 상태가 사는 곳

`Aa` 버튼은 헤더 = **App 루트**에 있고, `displayMode`/`lastTab`은 `ReadyBody`가
들고 있다. 그래서 `fontScale`은 App 루트가 자기 effect에서 `loadPanelPrefs()`로
읽는다. `ReadyBody`도 같은 함수를 부르므로 `storage.local.get`이 한 번 더 나가지만,
로컬 스토리지 읽기 한 번이고 두 컴포넌트의 생명주기가 다르므로 이 중복이
프롭 드릴링보다 싸다.

App 루트는 `fontScale`이 바뀔 때마다:

```ts
document.documentElement.style.setProperty('--panel-font-scale', String(fontScale));
```

로드가 async라 첫 프레임은 100%로 그려졌다가 저장값으로 튈 수 있다. 패널은 이미
로딩 상태를 거쳐 본문에 도달하므로(자막 로드가 훨씬 길다) 실사용에서 이 전환은
본문이 나타나기 전에 끝난다. 깜빡임을 막겠다고 렌더를 막지 않는다.

## 6. 파일 변경

| 파일 | 변경 |
|---|---|
| `src/lib/font-scale.ts` | 신규 — 단계·정규화·포맷 |
| `src/lib/font-scale.test.ts` | 신규 |
| `src/lib/panel-prefs.ts` | `panelFontScale` 키, `fontScale` 필드, `savePanelFontScale` |
| `src/lib/panel-prefs.test.ts` | 라운드트립·필드별 폴백 케이스 추가 |
| `src/styles/globals.css` | `--panel-font-scale` + `.body-*` 6종 |
| `src/components/FontSizeMenu.tsx` | 신규 — `Aa` 트리거 + 팝오버 |
| `entrypoints/sidepanel/App.tsx` | `fontScale` 상태·로드·CSS 변수 적용, 헤더에 `<FontSizeMenu>` |
| `src/components/TranscriptList.tsx` | `SegmentTexts`·타임코드 클래스 치환, 컬럼 폭 `em` |
| `src/components/NotesPanel.tsx` | 인용문·타임코드 클래스 치환, 컬럼 폭 `em` |
| `src/components/SummaryPanel.tsx` | 본문·라벨·칩·흐름 타임코드 클래스 치환, 컬럼 폭 `em` |

## 7. 테스트

**유닛 (vitest)**

- `font-scale.test.ts`
  - `stepFontScale`이 최소/최대 단계에서 경계를 넘지 않는다
  - `normalizeFontScale`이 숫자 아닌 값·목록에 없는 값·`NaN`을 기본값으로 떨어뜨린다
  - `formatFontScale(1.15) === '115%'` (부동소수 잔재가 문자열에 새지 않는지)
- `panel-prefs.test.ts`
  - `fontScale` 라운드트립
  - `panelFontScale`만 오염됐을 때 `displayMode`/`lastTab`은 살아남는다
  - `savePanelFontScale`이 자기 키만 쓴다

**실제 확인 (dev 프로필 + CDP)**

`runtime.reload()`로 서비스워커를 갱신한 뒤(확장 재로드만으론 교체되지 않음) 패널에서:

1. 90% / 175%에서 타임코드가 컬럼을 넘치지 않고 본문 좌측 정렬이 유지되는가
2. 요약·노트 탭에서도 같은 배율이 적용되는가
3. 헤더·탭바·버튼·영상 카드가 **변하지 않는가**
4. 패널을 닫았다 열었을 때 배율이 유지되는가
5. 팝오버가 `A±` 연타 중에는 열려 있고, 바깥 클릭·`Escape`로 닫히며 포커스가
   `Aa`로 돌아오는가
