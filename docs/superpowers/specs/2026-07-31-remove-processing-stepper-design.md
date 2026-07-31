# 처리 단계(ProcessingStepper) 제거 설계

날짜: 2026-07-31 · 상태: 승인됨 (사용자: "처리단계제거를 먼저하고 검토해보자")
선행: display-mode 2택 머지(`e26c294`).

## 1. 목표 · 근거

패널의 처리 단계 스텝퍼 섹션(1→2→3→4 단계 표시 + 캡션)을 제거한다.
TranslateButton이 이미 같은 정보를 커버한다: 단계별 라벨(추출/분석/번역 + phase·청크·
경과시간), 진행 중 펄스, 실패 시 에러 문구 + 다시 시도, 완료 시 다시 생성.
수용하는 손실(사용자 확인): 실패 단계의 시각적 위치 표시, idle 안내 문구
("약 40초 소요 · 처리 중에도 영상은 계속 재생됩니다").

보너스: M2 기술부채 2건이 코드와 함께 소멸 — ① completeness pass 중 스텝퍼 100%
정지 증상 ② failed 아닐 때도 `record.error.step` 우선하는 activeStep 버그.

## 2. 제거 경계

**`entrypoints/sidepanel/App.tsx`:**
- ReadyBody의 `<ProcessingStepper …/>` 렌더 1줄
- `ProcessingStepper` 컴포넌트 + doc 주석 전체
- 스텝퍼 전용 헬퍼: `STEP_LABELS`, `StepVisualState`, `STEP_TEXT_CLASS`,
  `stepVisualState`, `stepperCaption`
- unused가 되는 import: `Fragment`(스텝퍼 전용), `progressPercent`, `stepForStatus`,
  `type ProcessingStep`
- TranslateButton doc 주석의 스텝퍼/percent 언급 정정

**`src/features/translation/progress-display.ts`(+`.test.ts`):**
- `ProcessingStep` 타입, `stepForStatus`, `progressPercent` — App.tsx 외 소비자 없음
  (grep 확인: pipeline.ts는 주석 언급뿐) → 함수·타입·해당 테스트 블록 제거.
  pipeline.ts:314 주석의 progressPercent 언급도 정정.
- **유지**: `formatElapsedTime`, `translatePhaseLabel` (TranslateButton의
  `processingLabel`이 사용).

**무변경:** `useElapsedSeconds`(버튼이 사용), `TranslationProgressState`,
TranslationRecord의 `error.step` 필드(영속 데이터 스키마 — 지금 소비자가 없어져도
레코드 타입은 건드리지 않는다), 파이프라인의 progress 이벤트 발행(버튼 라벨이 소비).

## 3. 검증

- tsc 0 · vitest 전체(스텝퍼 관련 테스트 제거로 감소) · build.
- `grep -rn "ProcessingStepper\|stepVisualState\|stepperCaption\|STEP_LABELS\|stepForStatus\|progressPercent" src entrypoints` → 0 히트.
- 실 Chrome(CDP): ① 패널에 "처리 단계" 텍스트 부재 ② done 상태에서 번역 완료 버튼 +
  Transcript/Summary 탭 정상 렌더(회귀 없음) ③ savedAt 불변.

## 4. 비범위

언어 일반화 사이클(타깃 언어 선택 + 소스 일반화 — 백로그 7), TranslateButton 개선,
idle 안내 문구의 다른 위치 이식(요청 시 별도).
