# M2 계획서 — 자막 추출 + Gemini 번역 파이프라인

- 마일스톤: **M2** (IMPLEMENTATION_PLAN §3 / §5, PRD §7.2·7.3·§12)
- 선행: M1 완료 (`v0.1.0-m1`, HEAD 계열 7460a72) — 영상 인식·SPA 추종·미지원 배너·패널 카드
- 작성일: 2026-07-28
- 실행 방식: `superpowers:subagent-driven-development` — 아래 Task 1부터 순서대로
- 태그(완료 시): `v0.1.0-m2` (m0/m1과 동일 `v0.1.0-mN` 관례)

---

## 0. 목표 / 완료 정의(DoD)

**목표**: 사용자가 패널의 `AI 자막 생성`을 누르면, 현재 영상의 영어 자막을 추출해
한국어로 번역하고, 진행 단계를 실시간으로 보여주며, 결과를 IndexedDB에 캐시하고,
패널에 `[타임스탬프 | 영어 | 한국어]` 리스트로 렌더한다. 재방문 시 즉시 로드된다.

**DoD (실제 Chrome에서 모두 확인)**:
1. 픽스처(카파시, 1시간, ASR 전용, 1162 세그먼트)에서 `AI 자막 생성` → 추출→용어분석→번역→적용 4단계가 실제 진행률로 구동
2. 완료 후 패널에 번역된 transcript 리스트 표시(EN/KO), 콘솔에도 덤프
3. 같은 영상 재방문 → 파이프라인 재실행 없이 캐시에서 즉시 로드
4. 번역 중 패널을 닫았다가 다시 열면 마지막 완료 배치부터 재개(처음부터 다시 안 함)
5. 429(rate limit) 발생 시 지수 백오프로 회복(실제 또는 주입 시뮬레이션으로 관찰)
6. 자막 패널 없는 영상 → "자막 없음/미지원" 폴백(M1 게이트 재사용), 크래시 없음
7. 저장된 API 키 `savedAt` 불변, `AI 자막 생성`은 키 있을 때만 활성
8. GitHub main push + `v0.1.0-m2` 태그

---

## 1. 확정된 설계 결정 (실측 근거 포함)

### 1.1 자막 소스 — **DOM 트랜스크립트 패널 스크래핑 단일 방식**
`youtube.com/api/timedtext` 직접 fetch는 **폐기**. Chrome 150(2026-07)에서 실측:
`ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`
는 존재하나(en/asr 1트랙), 해당 baseUrl을 youtube.com same-origin에서
`fmt=json3/srv3/srv1/vtt/기본xml` 어떤 형식으로 fetch해도 **HTTP 200 + 빈 본문(len 0)**.
원인: YouTube가 ASR timedtext를 **PoToken(pot) 게이팅** — baseUrl에 `pot=` 없음.
→ "통과했는데 실제로는 안 됨" 함정. **직접 fetch 방식 금지.**

**채택 방식(실측 성공)**: content script가 유튜브 자체 **트랜스크립트 engagement 패널**을 열고
(`스크립트`/`Show transcript` 버튼 클릭 또는
`ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]`
를 `visibility=ENGAGEMENT_PANEL_VISIBILITY_EXPANDED`로 강제), 렌더된
`ytd-transcript-segment-renderer` 행(`.segment-timestamp` + `.segment-text`)을 스크래핑.
픽스처에서 **1162행 전량 수집 확인**, 실제 원문 텍스트 검증됨.
InnerTube `get_transcript` 폴백은 **구현 안 함**(사용자 결정) — 패널 없으면 자막 없음 폴백.

### 1.2 작업 durability — **패널 Port keepalive + 배치 영속화 + 재개**
긴 영상(수백 세그먼트=Gemini 다수 호출)은 MV3 SW 30초 eviction 대상.
- 패널이 `chrome.runtime.connect` **Port**로 background에 연결 → 연결 유지 동안 SW 활성.
- 각 번역 배치 완료 **즉시 IndexedDB에 영속화**(idempotent, 배치 인덱스 기준 upsert).
- 패널 닫힘 → Port disconnect → **일시정지**. 재개(재연결) 시 `completedBatches` 다음부터.
- eviction이 나도 손실은 진행 중이던 배치 1개뿐. UX 카피: **"번역 중에는 패널을 열어두세요."**
- `chrome.alarms` 기반 완전 백그라운드 잡은 **구현 안 함**(사용자 결정, 개인용 단순성 우선).

### 1.3 M2 범위 경계 — **파이프라인 + 진행 + 캐시 + 패널 리스트 렌더**
포함: 추출 → 용어집 → 배치 번역 → 용어 일관성 → IndexedDB 캐시 → 진행 스트리밍 →
패널에 `[타임스탬프|영어|한국어]` **단순 리스트** 렌더 + 콘솔 덤프.
**제외(→M3)**: 유튜브 플레이어 자막 오버레이, 가상 스크롤(react-window),
재생 위치 동기화·자동 스크롤·클릭 시크. M2 리스트는 정적(동기화 없음)이며 M3에서 교체됨.
**제외(→M4)**: Summary, 북마크, 검색.

---

## 2. 아키텍처

```
[Content Script (youtube.com)]                 [Background SW]                 [Side Panel]
 - openTranscriptPanel()                        - API 키(격리)                   - AI 자막 생성 클릭
 - scrape ytd-transcript-segment-renderer       - Gemini 호출(용어집/번역)        - Port 연결(keepalive)
 - rows -> raw {tsText, text}[]                  - 파이프라인 오케스트레이션        - 진행 스텝퍼(실측%)
        │  REQUEST_TRANSCRIPT (bg→content)       - 배치별 IndexedDB 영속화          - 완료: EN/KO 리스트
        └──────────────►  raw rows  ────────────►- 진행 이벤트 스트리밍  ──Port──► - 실패: 원문+재시도
                                                  - 캐시 조회/저장
                                                        │
                                                 IndexedDB 'ypa'
                                                  - videos (M1)
                                                  - translations (M2 신규)
```

- **API 키는 background에만** — content/panel은 메시지로만. (M1 원칙 유지)
- 진행 스트리밍·keepalive는 **Port**(`chrome.runtime.connect`), 단발 조회는 기존 `sendMessage`.
- content의 스크래핑은 **bg가 REQUEST로 트리거**(패널은 bg에만 말함, content에 직접 안 함).

---

## 3. 데이터 모델 (PRD §10)

`src/types/transcript.ts` (신규):
```ts
// PRD §10 TranscriptSegment — isBookmarked 필드 없음(북마크는 M4 별도 테이블)
export interface TranscriptSegment {
  segmentId: string;         // `${videoId}:${index}`
  videoId: string;
  index: number;             // 원본 순서(배치·재개 기준 키)
  startSec: number;
  endSec: number;            // 다음 세그먼트 start(마지막 = 영상 duration)
  sourceText: string;        // 문장 재구성·중복 제거 후 영어
  translatedText: string | null;  // 미번역 = null
}
export interface GlossaryEntry { term: string; translation: string; keepEnglish: boolean; }
export type TranslationStatus = 'idle' | 'extracting' | 'analyzing' | 'translating' | 'done' | 'failed';
export interface TranslationRecord {
  videoId: string;           // key
  captionHash: string;       // sourceText 전체 해시 — 캐시 무효화 기준(§12 캐시 키)
  sourceLang: string;        // 'en'
  status: TranslationStatus;
  segments: TranscriptSegment[];
  glossary: GlossaryEntry[];
  completedBatches: number;  // 재개 지점
  totalBatches: number;
  error?: { step: TranslationStatus; reason: string };
  createdAt: string; updatedAt: string;
}
export interface TranslationProgress {  // bg→panel Port 이벤트
  videoId: string; status: TranslationStatus;
  done: number; total: number;          // 세그먼트 기준 진행률
  step: 1 | 2 | 3 | 4;                  // 추출/용어분석/번역/적용
}
```

IndexedDB: 기존 `ypa` DB **버전 올림**, `translations` 스토어 추가(keyPath `videoId`).
M1 `videos` 스토어는 그대로. 마이그레이션은 `onupgradeneeded`에서 store 생성만(파괴적 X).

---

## 4. 파이프라인 설계 (PRD §12 AI 처리 파이프라인)

```
1) 추출     content 스크랩 → raw rows → 문장 재구성·중복 제거(pure lib) → segments(sourceText)
2) 용어분석  Gemini 1회: 전체(또는 압축) 원문 → 주제 + GlossaryEntry[]
3) 번역     segments를 5~10개 배치로, 동시성 ≤3, 각 배치에 glossary 컨텍스트 주입
            └ 429 → 지수 백오프(예: 1s,2s,4s,최대 3~4회), 배치 완료마다 IndexedDB 영속화
4) 일관성   동일 원어 용어 → glossary 번역으로 통일(post-process pure lib, 추가 호출 없이)
5) 적용     status=done, 패널에 리스트 렌더 + 콘솔 덤프, 캐시 확정
```

**번역 규칙(§7.3, 프롬프트에 명시)**: 코드·명령어·URL·라이브러리명 미번역, 기술 용어 국내 관례
우선(필요 시 영어 병기), 동일 용어 영상 내 일관, **AI 해설·의견 삽입 금지**, 타임스탬프 보존.
**ASR 특성**: 구두점 없음·롤링 중복·~6초 청크 → 추출 단계 문장 재구성이 번역 품질·호출 수 좌우.

**모델**: `gemini-2.5-flash`(기존 `src/lib/gemini.ts` 재사용·확장). 무료 티어 RPM/TPM 상한 →
동시성 상한 + 백오프로 준수. 배치 크기·동시성은 상수로 두고 실측으로 조정.

---

## 5. 픽스처 & 함정

**픽스처**:
- 주 픽스처: `https://www.youtube.com/watch?v=zjkBMFhNj_g` (카파시, ~1h, **ASR 전용, 1162행**) —
  긴 영상·자동자막·문장 재구성·재개·백오프 스트레스 테스트 전부 커버.
- 보조: 수동(제작자) 자막이 있는 짧은 영상 1개(Task 1에서 선정) — 제작자 자막 경로/짧은 영상 완주.
- 음성: 트랜스크립트 패널이 **없는** 영상 1개 — 자막 없음 폴백 검증.

**함정(반드시 인지)**:
1. **timedtext 직접 fetch는 죽었다**(pot 게이팅, 200+빈본문). §1.1 방식만 사용.
2. **확장 리로드가 열린 패널을 닫는다**(M1과 동일). 리로드는 Task 단위로 묶고, 패널 필요 시
   NEEDS_CONTEXT로 멈춰 사람에게 클릭 요청. `chrome.sidePanel.open()` CDP 합성 거부, OS 클릭 흉내 금지.
3. **SW 30초 eviction** — 배치별 영속화 + Port keepalive로만 견딤(§1.2). "한 번에 다 될 것"이라 가정 금지.
4. **트랜스크립트 패널 가상화** — 픽스처는 1162행 전량 렌더됐으나, 더 긴 영상은 스크롤로만
   렌더될 수 있음. Task 1에서 전량 수집 방법(패널 스크롤/강제 렌더) 실측 확정.
5. **`Page.navigate`로 SPA 검증 불가**(M1과 동일) — 관련영상 앵커 실제 `.click()`.

---

## 6. 제약 (M0/M1에서 확립 — 전부 유지)

**아키텍처/권한**: 서페이스는 사이드 패널 + Options 둘뿐. `action.default_popup` 되살리기 금지.
`tabs` 권한 추가 금지. host_permissions는 youtube.com + generativelanguage.googleapis.com만.

**보안(가장 중요)**: dev 프로필의 실제 API 키
`{"present":true,"maskedKey":"••••IaDg","savedAt":"2026-07-26T16:19:11.169Z"}` 상태 끝까지 유지.
dev 프로필에 `SAVE_API_KEY`/`DELETE_API_KEY` 전송 금지. 저장소 루트 `.env.local` 읽기·출력·삭제 금지.
`.env.local`·`.chrome-dev-profile/`·`.chrome-dev-output/`·`.superpowers/` 커밋 금지.
**번역 원문·번역문은 로컬(IndexedDB) 저장만, 외부 전송은 Gemini 호출뿐**(PRD §14 ToS).

**기술 게이트(각 Task)**: `pnpm tsc --noEmit` 0 · `pnpm test` 전체 통과 · `pnpm wxt build` 성공.
UI 문구 한국어 / 코드·주석·커밋 영어. Conventional Commits, **태스크 마지막 스텝에서만 커밋**.
`src/lib/` 순수 로직은 **TDD**(실패 테스트 → RED 확인 → 구현 → GREEN).

**워크플로**: 컨트롤러는 코드·설정·lockfile 직접 편집 안 함. 구현/검토/수정을 **각각 별도
서브에이전트**로 분리. 구현자 → 리뷰어 → (필요 시) fixer → 재리뷰. 실제 Chrome 검증은 CDP 읽기
전용(9222) + 사람 클릭 요청 방식. 각 Task 완료마다 `.superpowers/sdd/.../progress.md` 원장에 append.

---

## 7. 태스크 (11개)

각 태스크는 파일/인터페이스/스텝/게이트를 명시. 실제 Chrome 검증이 필요한 태스크는 명시.

### Task 1 — 트랜스크립트 DOM 계약 실측
- **산출물**: `docs/youtube-transcript-findings.md`. 코드 없음, 실측 계약만.
- 픽스처 ASR + 보조 수동자막 + 무자막, 3영상에서 측정:
  스크립트 버튼/engagement-panel 셀렉터, 행 셀렉터(`.segment-timestamp`/`.segment-text`),
  타임스탬프 포맷(`m:ss`/`h:mm:ss`), **가상화 여부**(전량 렌더 vs 스크롤 필요) 및 전량 수집법,
  패널 부재 신호(→ 자막 없음), ASR 롤링 중복 패턴 샘플, 수동자막과의 구조 차이.
- 측정값 vs 추론 분리 표(M1 Task 1 관례). SPA 이동 후 패널 stale 여부도 확인.

### Task 2 — 타입 + 메시지 스키마
- **수정/생성**: `src/types/transcript.ts`(§3 타입), `src/types/message.ts` 확장.
- 메시지: `REQUEST_TRANSCRIPT`(bg→content, raw rows 반환), `START_TRANSLATION`(panel→bg),
  `GET_TRANSLATION`(panel→bg, 캐시 반환), Port 채널명 `translation-progress`(bg→panel 스트림).
  기존 discriminated-union·exhaustive `handle<T>()` 유지, 새 변형 추가 시 tsc가 빨개지는지 확인(붙일 것).
- 게이트: tsc(의도적 RED→구현 후 GREEN).

### Task 3 — IndexedDB `translations` 스토어
- **수정**: `src/lib/db.ts`. DB 버전 올림 + `translations`(keyPath `videoId`) 추가, `videos` 보존.
- API: `getTranslation(videoId)`, `putTranslation(rec)`, `upsertBatch(videoId, batchIdx, segs)`(idempotent).
- **TDD**(fake-indexeddb): 마이그레이션(기존 videos 유지), 배치 upsert 멱등성, captionHash 무효화.

### Task 4 — 자막 스크래퍼 (순수 파서 + content script)
- **순수 lib** `src/lib/transcript-parse.ts`: `parseTimestamp`, `rowsToSegments`(start/end 계산),
  `reconstructSentences`(ASR 롤링 중복 제거·문장 병합), `captionHash`. **TDD**(픽스처 raw 샘플 기반).
- **content script** `entrypoints/content.ts`: `openTranscriptPanel()` + `scrapeRows()` +
  `REQUEST_TRANSCRIPT` 핸들러(bg 트리거 → raw rows 반환, 패널 부재 시 `{unavailable:true}`).
- **실제 Chrome**: 픽스처 스크랩 → 1162행 → 문장 재구성 후 세그먼트 수·샘플 stdout 붙일 것.

### Task 5 — Gemini 번역 클라이언트
- **수정**: `src/lib/gemini.ts`. `analyzeGlossary(fullText)` 프롬프트+파서, `translateBatch(segs, glossary)`
  프롬프트+파서. §7.3 규칙 프롬프트에 명시. 에러 분류 401/429/network/unknown 재사용.
- **TDD**: 프롬프트 빌더 스냅샷, 응답 파싱(정상/부분/깨진 JSON), 에러 매핑. 실호출 아님(mock fetch).

### Task 6 — 파이프라인 오케스트레이터 (background)
- **수정**: `entrypoints/background.ts`(+ `src/features/translation/pipeline.ts`).
  용어분석 1회 → 배치 번역(동시성 ≤3, 429 지수 백오프) → 일관성 post-process → 배치별
  `upsertBatch` 영속화 → 진행 이벤트 방출. `completedBatches`에서 **재개 가능**.
- **TDD**: mock gemini로 배치 분할·동시성 상한·백오프·재개(부분 완료 후 이어서)·일관성 검증.

### Task 7 — Port keepalive + 진행 스트리밍
- **수정**: `background.ts`(Port 수신·잡 구동·disconnect 시 일시정지), `src/features/translation/useTranslation.ts`(패널 훅: connect/재개/진행 구독).
- **실제 Chrome**: 잡 시작 → 진행률 관찰 → **패널 닫고 다시 열기 → last-batch부터 재개** 확인(로그 붙일 것).

### Task 8 — 패널: AI 버튼 활성 + 실측 스텝퍼
- **수정**: `entrypoints/sidepanel/App.tsx`(ReadyBody). `AI 자막 생성` 활성(키 present + watch일 때만),
  클릭 → `useTranslation` 시작. `처리 단계` 스텝퍼 → 실측 %/배치. §9 상태(초기/처리중/완료/실패+재시도).
- **실제 Chrome**: 픽스처에서 클릭 → 4단계 진행 시각 확인. AI 버튼은 키 없으면 여전히 disabled.

### Task 9 — 패널: 번역 리스트 렌더
- **생성/수정**: `src/components/TranscriptList.tsx`, `App.tsx`. 완료 시 `[타임스탬프|영어|한국어]`
  **단순 리스트**(가상스크롤·동기화 없음). 실패 → 원문(영어)만이라도 표시 + 재시도. 콘솔 덤프.
- **실제 Chrome**: 픽스처 완주 → 리스트에 한국어 세그먼트 렌더 + 원문 대조 stdout.

### Task 10 — 캐시 히트 + SPA 리셋 + 재방문
- **수정**: `useTranslation`/`App.tsx`. 재방문 → `GET_TRANSLATION` 히트 → 파이프라인 스킵 즉시 로드.
  SPA로 새 영상 이동 → 번역 상태·버튼·리스트 리셋. captionHash 불일치 시 재생성.
- **실제 Chrome**: 픽스처 번역 후 재방문 즉시 로드, 관련영상 `.click()` 후 상태 리셋 확인.

### Task 11 — 실제 Chrome 인수 + 전체 리뷰 + push/tag
- 전 파이프라인 픽스처 완주(추출→용어→번역→렌더→캐시), 재방문 즉시, 패널 닫기→재개,
  429 백오프 관찰(실제/주입), 무자막 폴백, API 키 `savedAt` 불변, AI 버튼 게이팅, SPA 리셋 —
  **7 DoD 전부 stdout 원문으로**.
- opus **전체 브랜치 리뷰** → Important 이상 즉시 fix(구현자→리뷰어 분리).
- `git push origin main` + annotated `git tag v0.1.0-m2 -m "M2: caption extraction + translation"` + push tag.

---

## 8. 완료 조건

Task 11까지 체크, `v0.1.0-m2` 태그 origin 존재, §0의 DoD 8개 실제 Chrome 확인,
§6 보안 제약(키 불변·`.env.local` 미접근·금지 커밋 없음·no-tabs·no-popup) 전부 유지.
