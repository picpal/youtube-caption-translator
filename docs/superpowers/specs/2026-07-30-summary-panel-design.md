# Summary 패널 — 핵심 요약 생성·표시 설계

날짜: 2026-07-30 · 상태: 승인됨 (A안: bg 단일 호출 + 별도 summaries 스토어)
선행: playback-sync 머지(`533bba8`) — 발표 흐름 시크가 `usePlaybackSync.seek`를 재사용한다.
디자인 레퍼런스: `docs/design/side-panel.dc.html` (Summary 5개 섹션 · 520px 변형의 탭 전환)

## 1. 목표

번역 완료(done)된 영상에 대해 버튼 1회로 한국어 요약을 생성·캐시하고, 패널의 Summary 탭에
디자인이 정의한 5개 섹션(문제·핵심 주장·발표 흐름·키워드·결론)으로 렌더한다. 발표 흐름의
타임스탬프 행을 클릭하면 영상이 해당 시점으로 시크한다.

성공 기준(실 Chrome): done 레코드에서 `요약 생성` → 요약 렌더 실측, 패널 재열기 시 캐시 즉시
로드, 발표 흐름 행 클릭 → `video.currentTime` 점프, 429/키 부재 시 한국어 에러 표시.

범위 결정(사용자 확정): 요약 생성+표시만. 학습 노트·북마크·내보내기는 별도 사이클.
트리거는 수동 버튼만(파이프라인 무변경). UI는 Transcript | Summary 탭 전환.

## 2. 데이터 모델 · 저장 (`src/lib/db.ts`, `src/types/summary.ts`)

- IndexedDB `youtube-play-assistant` **버전 2→3**: `summaries` 스토어 신설
  (`keyPath: 'videoId'`). 기존 upgrade 패턴(`objectStoreNames.contains` 가드) 그대로 확장 —
  기존 videos/translations 데이터 무손실.
- 새 타입 `VideoSummary`:
  `{ videoId: string; purpose: string; mainArguments: string[]; sections: { startSec: number; title: string }[]; keywords: string[]; conclusion: string; model: string; createdAt: number }`
- db.ts에 `putSummary(summary)` / `getSummary(videoId)` 추가 (기존 put/get 패턴 복제).
- 번역 레코드는 무변경. 재생성은 같은 키 덮어쓰기(put)로 충분 — 버전 해시 무효화는 비범위.

## 3. 메시지 · background (`src/types/message.ts`, `entrypoints/background.ts`)

`AppMessage` union + `AppResponseMap`에 2건 추가:

- `{ type: 'GENERATE_SUMMARY'; payload: { videoId: string } }` →
  `{ ok: true; summary: VideoSummary } | { ok: false; error: string }`
  - bg 처리 순서: ① translations 레코드 로드, status `done` + segments 비어있지 않음 검증
    (아니면 `{ok:false}`) ② 타임스탬프 붙은 영어 원문으로 프롬프트 구성 ③ Gemini 1회 호출
    (§4) ④ 응답 검증·정규화(§4) ⑤ `putSummary` 영속 ⑥ 응답.
  - 호출 동안 기존 refcount keepalive(getPlatformInfo)를 잡는다 — 파이프라인과 동일 패턴.
- `{ type: 'GET_SUMMARY'; payload: { videoId: string } }` → `{ summary: VideoSummary | null }`

동시성: 같은 videoId에 대해 GENERATE_SUMMARY가 진행 중이면 bg가 in-flight Promise를 공유
(중복 호출 방지, 파이프라인의 진행 중 가드와 동일한 모듈-레벨 Map).

## 4. Gemini 호출 (`src/lib/gemini.ts`)

- `generateSummary(apiKey, input)` 추가 — `analyzeGlossary`와 동일 골격: `MODEL_ID`
  (`gemini-3.5-flash-lite`), `responseMimeType: 'application/json'` + `responseSchema`
  (SUMMARY_SCHEMA: purpose/mainArguments/sections{startSec,title}/keywords/conclusion),
  기존 `classifyGeminiError`/`parseRetryDelayMs` 지수 백오프 재사용.
- 입력: `[startSec] sourceText` 라인 포맷의 영어 원문 전체(322행 기준 ~70k chars — Flash
  컨텍스트에 단일 호출 여유). 출력 언어는 한국어.
- 프롬프트 가드레일(PRD §7.5): 영상 내용 근거만, AI 개인 의견·확장 해설 금지, 섹션 제목은
  발표 흐름 순서를 따르고 startSec은 입력에 존재하는 타임스탬프 범위 내여야 한다.
- 응답 검증(순수 함수, TDD): 필수 필드 존재·비어있지 않음, `sections[].startSec`을
  `[0, 마지막 세그먼트 startSec]`으로 클램프, startSec 오름차순 정렬. malformed JSON은
  1회 재시도 후 `{ok:false, reason:'bad_json'}`.

## 5. 패널 UI (`entrypoints/sidepanel/App.tsx`, `src/components/SummaryPanel.tsx`, `src/features/summary/useSummary.ts`)

- **탭**: ReadyBody에서 `showTranscriptList`일 때 `Transcript | Summary` 탭 노출(기본
  Transcript, 로컬 useState). 재생 하이라이트·자동 스크롤은 Transcript 탭에서만 —
  `usePlaybackSync`는 ReadyBody 레벨에 있으므로 Summary 탭에서도 시크는 동작한다.
- **useSummary({ videoId, enabled })**: 마운트/videoId 변경 시 `GET_SUMMARY`로 캐시 로드;
  `generate()`가 `GENERATE_SUMMARY` 전송. 상태 `idle | loading | generating | done | failed`.
  패널 안전 타임아웃(180s — bg 최악 경로인 `GEMINI_FETCH_TIMEOUT_MS` 120s + bad_json 재시도
  여유보다 길게) 후 `GET_SUMMARY` 재조회로 수렴: 캐시 발견 → done, null → failed. failed의
  `다시 시도`는 bg의 in-flight 공유(§3) 덕에 진행 중 호출에 합류할 뿐 중복 과금이 없다.
- **SummaryPanel 렌더 상태**: 캐시 없음 → 빈 상태 카피 + `요약 생성` 버튼 · generating →
  스피너 + 경과초(`useElapsedSeconds` 재사용) + "요약 생성 중…" · done → 5개 섹션 렌더 ·
  failed → `error-display` 한국어 매핑 + `다시 시도`.
- **5개 섹션**(디자인 마크업 준수): 이 영상이 다루는 문제 / 핵심 주장(01·02·… 번호) /
  발표 흐름(타임스탬프 `mm:ss` + 제목, 행 클릭 → `onSeekSection(startSec)` →
  `playback.seek`) / 주요 키워드 칩 / 결론.
- 요약이 있으면 헤더 우측에 작은 `다시 생성` 액션(같은 generate(), 덮어쓰기).
- UI 문구 한국어. `mm:ss` 포맷터는 TranscriptList의 기존 포맷터를 공용 헬퍼로 재사용.

### 5a. 탭 UX 추가분 (사용자 요청 2026-07-30)

- **탭 바 상단 고정**: 스크롤 시 Transcript|Summary 탭 바는 패널 뷰포트 상단에 sticky로 고정
  (불투명 배경, 라이트/다크 모두).
- **탭 전환 = 항상 콘텐츠 최상단**: 탭별 스크롤 위치를 기억하지 않는다. `activeTab` 변경 시
  탭 섹션이 뷰포트 상단에 오도록 즉시 스크롤.
- **맨 위로 플로팅 버튼**: 일정 스크롤(~300px) 이후 우측 하단에 ↑ 버튼 노출, 클릭 시 패널 최상단
  이동. `aria-label="맨 위로"`. 탭 유무와 무관하게 동작.
- **다시 시도는 cache-aware** (최종 리뷰 I4): 안전 타임아웃 후 뒤늦게 영속된 요약이 있으면
  `다시 시도`는 GET_SUMMARY 선조회로 그것을 집어오고 재호출하지 않는다. `다시 생성`만 의도적
  덮어쓰기.

## 6. 에러 · 엣지

- API 키 부재: 기존 매핑("API key not set" → 설정 안내) 재사용. 429 → 백오프 후 실패 시
  rate-limit 한국어 안내. 네트워크/unknown → 기존 매핑.
- Summary 탭은 번역이 `done`일 때만 노출된다 — 게이트는 `showSummaryTab = showTranscriptList && status === 'done'`
  (정정 2026-07-30, 최종 리뷰 I1: `showTranscriptList`는 failed도 참이므로 단독으로는 게이트가 아니다.
  failed 번역은 탭 바 없이 기존 transcript 목록만 보인다).
- SW 중도 evict: 요약은 영속 후 응답하므로, 패널 타임아웃 재조회가 캐시를 발견하면 done으로
  수렴. 미발견이면 failed + 다시 시도.
- sections가 빈 배열로 오면 검증 실패(재시도 1회 → 실패) — 발표 흐름 없는 요약은 불허.

## 7. 검증

- vitest(TDD, `src/lib/`): 프롬프트 빌더(라인 포맷·가드레일 포함), 응답 검증·클램프·정렬,
  db v3 마이그레이션(fake-indexeddb 기존 테스트 패턴). 기존 게이트 유지(tsc 0 · 전체 테스트
  · build).
- 실 Chrome(CDP): ① done 레코드에서 `요약 생성` → 5개 섹션 렌더 실측 ② 패널 재열기 →
  Gemini 재호출 없이 캐시 로드 ③ 발표 흐름 행 클릭 → `video.currentTime` 점프 실측
  ④ 키 상태(savedAt) 불변.

## 8. 비범위

- 학습 노트 생성, 북마크, Markdown/SRT 내보내기, 자막 버전 해시 기반 요약 무효화,
  요약 다국어(한국어 고정), 요약 자동 생성(수동 버튼만).
