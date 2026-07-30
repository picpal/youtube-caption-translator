# 자막 표시 2택 축소 — '영어' 모드 제거 + 라벨 중립화 설계

날짜: 2026-07-31 · 상태: 승인됨 (사용자: "A만 먼저" — B(다국어 소스 지원)는 별도 사이클)
선행: panel-prefs 머지(`5c3e4ee`) — displayMode가 `chrome.storage.local`에 영속화됨.

## 1. 목표

원문-only(`'en'`) 표시 모드를 제거한다. 근거: 원문 자막은 YouTube 플레이어가 이미
보여주고, 패널에서의 원문 확인은 동시 모드가 커버한다 — 원문→원문 표시는 사용
가치가 없다. 동시에 라벨을 언어 중립으로 바꿔 향후 다국어 소스(B 사이클)를 준비한다.

- `DisplayMode`: `'both' | 'ko' | 'en'` → **`'both' | 'ko'`**
- 버튼: 3개 → **2개**, 라벨 `영한 동시`→**`원문+한국어`**, `한국어`→**`한국어만`**
- UI 형태는 세그먼트 버튼 유지 (select box 불채택 — 모드는 언어와 무관하게 2개 고정,
  1클릭 전환·상태 상시 가시가 우선)

## 2. 변경 지점

- `src/components/TranscriptList.tsx`: `DisplayMode` 유니온 축소, `visibleTexts`의
  `'en'` 분기 제거 (`'ko'` 분기가 마지막 return이 됨). `'en'`을 언급하는 doc 주석
  정리 + "Session-local only … M3" 주석은 이미 낡았으므로(영속화 완료) 함께 정정.
- `entrypoints/sidepanel/App.tsx`: `DISPLAY_MODE_OPTIONS` 2개 항목 + 새 라벨.
- `src/lib/panel-prefs.ts`: `DISPLAY_MODES` → `['both', 'ko']`.
- 테스트: TranscriptList.test.ts의 `mode: 'en'` 블록 제거; panel-prefs.test.ts의
  `'en'` 사용을 `'ko'`로 교체하고 **레거시 마이그레이션 테스트 추가** — 저장된
  `'en'`(이전 버전 사용자)이 `'both'`로 폴백하는 것을 명시적으로 고정.

## 3. 마이그레이션

없음(자동). panel-prefs의 필드별 리터럴 검증이 저장된 `'en'`을 invalid로 판정해
`'both'`로 폴백한다 — 스토리지 정리 코드 불필요.

## 4. 검증

- vitest 전체 + tsc 0 + build. `'en'`이 소스에서 완전히 사라졌는지 grep.
- 실 Chrome(CDP): ① 버튼 2개·새 라벨 렌더 ② `한국어만` 클릭 → 저장·재오픈 복원
  ③ 스토리지에 `'en'` 주입 후 패널 오픈 → `원문+한국어`(both) 선택 상태로 폴백
  ④ API 키 savedAt 불변.

## 5. 비범위

다국어 소스 지원(프롬프트 일반화, keepEnglish 시맨틱, MERGE_TARGET_CHARS 재검토) —
B 사이클. 백로그에 이미 등록됨.
