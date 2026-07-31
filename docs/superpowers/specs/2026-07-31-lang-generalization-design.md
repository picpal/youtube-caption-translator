# 언어 일반화 — 소스 언어 일반화 + 타깃 언어 선택 설계

날짜: 2026-07-31 · 상태: 초안 (사용자 결정 반영: 캐시 ① targetLang 태그 + 패널 select
+ Options 기본 번역 언어 설정)
선행: 처리 단계 제거 머지(`8ee65ba`), panel-prefs 영속화, displayMode 2택.

## 1. 목표

1. **소스 일반화**: 영어 전제 제거 — 일본어·유럽어 등 어떤 언어의 영상이든 번역·용어
   분석·요약이 동작한다. (추출 경로는 이미 언어 무관 — YouTube 대본 패널 스크랩)
2. **타깃 선택**: 번역 목적지 언어를 한국어(기본)/영어/일본어/중국어 중에서 선택.
   전역 설정 1개, 편집 지점 2곳 — Options(기본 번역 언어)와 패널 select(즉석 변경)가
   **같은 storage 키**를 읽고 쓴다.

성공 기준(실 Chrome): ① 패널·Options 어느 쪽에서 바꿔도 서로 반영 ② 언어 변경 후
기존 캐시 영상에 불일치 배너 노출, 다시 생성 시 새 언어로 교체 ③ 일본어 소스 영상
번역 실측 ④ 요약도 선택 언어로 생성 ⑤ savedAt 불변.

## 2. 타깃 언어 설정 (`src/lib/target-lang.ts` — 신규)

```ts
export type TargetLang = 'ko' | 'en' | 'ja' | 'zh';
export const DEFAULT_TARGET_LANG: TargetLang = 'ko';
export const TARGET_LANG_LABELS: Record<TargetLang, string> = {
  ko: '한국어', en: '영어', ja: '일본어', zh: '중국어',
};
// 프롬프트용 영문 언어명
export const TARGET_LANG_NAMES: Record<TargetLang, string> = {
  ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese (Simplified)',
};
export async function getTargetLang(): Promise<TargetLang>;   // 키 'translationTargetLang', invalid → 'ko'
export async function saveTargetLang(lang: TargetLang): Promise<void>;
```

panel-prefs와 같은 패턴(리터럴 검증·단일 키 set). panel-prefs에 넣지 않는 이유:
이 값은 표시 선호가 아니라 **background 파이프라인이 소비하는 번역 설정**이다.

## 3. 프롬프트 일반화 (`src/lib/gemini.ts`, `src/lib/summary.ts`)

- `buildTranslateBatchPrompt(segs, glossary, targetLang)`: "You are translating
  YouTube transcript segments into {Name}. The source may be in any language."
  TRANSLATION_RULES의 "established Korean convention" → "{Name} convention",
  "add the English term in parentheses" → "add the original term in parentheses".
- **glossary**: `analyzeGlossary` 프롬프트를 "prepare a {Name}-translation glossary"로,
  `keepEnglish` → **`keepOriginal`** (스키마 필드·타입·프롬프트·검증 함수 일괄 개명 —
  "원어 유지" 시맨틱). `buildGlossaryBlock`: "keep in original language".
- `buildSummaryPrompt(…, targetLang)`: 출력 언어를 {Name}으로. 5개 섹션 구조·가드레일
  무변경. **요약은 선택 언어를 따른다** (한국어 UI 카피와 별개 — 콘텐츠 언어만 변경).
- 엣지: 소스 언어 == 타깃 언어(한국어 영상 + ko)는 사실상 복사 — 모델에 맡기고 막지
  않는다(사용자 선택 존중).

## 4. 레코드 스탬프 · 캐시 정책 ①

- `TranslationRecord`에 `targetLang?: TargetLang` 추가(optional). `VideoSummary`도 동일.
  **레거시 레코드(필드 없음)는 'ko'로 간주** — 마이그레이션 코드 없음, DB 버전 무변경.
- background가 작업 시작 시(`START_TRANSLATION` 처리, `runSummaryGeneration`)
  `getTargetLang()`을 1회 읽어 파이프라인에 넘기고 결과 레코드에 스탬프.
  작업 도중 설정이 바뀌어도 진행 중 작업은 시작 시점 언어로 완주.
- 영상당 캐시 1개 유지. 재생성은 같은 키 덮어쓰기.

## 5. UI

**패널** (`entrypoints/sidepanel/App.tsx`):
- 자막 표시 옆에 `번역 언어` select(4개 언어, `TARGET_LANG_LABELS`). 변경 시
  `saveTargetLang` — 즉시 재번역하지 않는다(배너 + 다시 생성 흐름).
- displayMode 라벨 중립화: `원문+한국어`→**`원문+번역`**, `한국어만`→**`번역만`**.
- `processingLabel`의 "한국어 번역 중…" → "번역 중…" (언어 중립).
- **불일치 배너**: done 상태에서 `record.targetLang ?? 'ko' !== 현재 설정`이면
  transcript 위에 안내 배너 — "이 번역은 {한국어}본입니다 · 현재 설정 {일본어} —
  다시 생성으로 교체할 수 있어요". 기존 `다시 생성` 버튼 재사용, 배너에 액션 없음.
- **Summary 탭**: 동일 패턴 — `summary.targetLang ?? 'ko' !== 설정`이면 배너 +
  기존 `다시 생성`. 기존 요약은 계속 표시.
- storage.onChanged 구독으로 Options에서의 변경도 열린 패널에 반영
  (useApiKey의 key-filtered onChanged 패턴 재사용).

**Options** (`entrypoints/options/App.tsx`):
- API 키 섹션 아래 `번역 설정` 섹션: `기본 번역 언어` select + 짧은 설명
  ("새 번역·요약이 이 언어로 생성됩니다. 사이드패널에서도 바꿀 수 있어요").
  저장 즉시 반영(별도 저장 버튼 없음, select onChange → saveTargetLang).

## 6. 검증

- vitest: target-lang 모듈(검증·폴백), 프롬프트 빌더 3종의 targetLang 파라미터화
  (언어명 삽입·규칙 문구), keepOriginal 개명 후 glossary 검증, 불일치 판정 순수 함수,
  레거시 레코드 'ko' 간주.
- 실 Chrome(CDP): §1 성공 기준 ①②④⑤ + 패널·Options 동기화. ③(일본어 영상)은
  일본어 기술 영상 1개로 번역 실측 — 영상 선정은 검증 단계에서.
- 게이트: tsc 0 · vitest 전체 · build.

## 7. 비범위

영상별 언어 오버라이드, 언어별 캐시(②안 — 플립이 실제 패턴이 되면 승격), 패널 UI
언어 변경(UI 카피는 한국어 고정), 소스 언어 자동 감지 결과의 UI 표기, SRT/내보내기.
