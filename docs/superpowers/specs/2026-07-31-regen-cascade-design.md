# 다시 생성 캐스케이드 — 요약 자동 갱신 + Summary 탭 재생성 버튼 제거 설계

날짜: 2026-07-31 · 상태: 승인됨 (사용자 A안: "자막표시 부분의 다시생성으로 transcript·Summary 모두 생성, Summary 탭 내 다시생성 제거")
선행: lang-generalization 머지(`8f5a55c`). 배경: 동일 라벨 `다시 생성` 2개(번역/요약)의
혼용 + 번역을 새 언어로 재생성해도 요약이 따라오지 않는 혼란(실사용 리포트).

## 1. 동작 모델

- **번역 `다시 생성`(자막표시 영역) = 이 영상의 산출물 전체 갱신**: 번역 파이프라인이
  `done`으로 끝나면, background가 **이 영상의 요약이 이미 존재할 때만** 요약을 자동
  재생성한다(현재 설정 언어로). 요약이 없던 영상은 안 만든다 — 요약은 여전히 옵트인.
- **Summary 탭 헤더의 `다시 생성` 제거.** 빈 상태 `요약 생성`과 실패 상태 `다시 시도`는
  유지(각각 캐시-어웨어 generate 경로).
- 번역이 `failed`로 끝나면 캐스케이드는 실행하지 않는다.
- 수용 트레이드오프(사용자 확인): 요약만 단독 재생성 불가 — 전체 `다시 생성` 경유.

## 2. background (`entrypoints/background.ts`)

- `startSummaryJob(videoId)` 헬퍼 추출: 기존 GENERATE_SUMMARY 핸들러의 single-flight
  Map get-or-create + `runSummaryGeneration(videoId).finally(delete)` 로직을 함수로.
  핸들러와 캐스케이드가 공유 — 진행 중 요약 작업과의 중복 호출은 기존 Map이 흡수.
- `START_TRANSLATION`의 fire-and-forget 체인에 캐스케이드 단계 삽입: 파이프라인 settle
  후, `getTranslation(videoId)`가 `done`이고 `getSummary(videoId)`가 존재하면
  `await startSummaryJob(videoId)`. **기존 keepalive 해제(.finally)는 캐스케이드까지
  settle한 뒤에** 실행되도록 체인 순서를 유지한다(요약 중 SW eviction 방지 —
  runSummaryGeneration 자체 keepalive도 있으므로 이중 안전).
- 캐스케이드 실패는 번역 결과에 영향 없음(로그만). 요약 언어는 기존대로
  `runSummaryGeneration`이 `getTargetLang()`을 읽는다.

## 3. 패널

- `src/components/SummaryPanel.tsx`: done 상태 헤더의 `다시 생성` 액션 제거,
  `onRegenerate` prop 제거.
- `src/features/summary/useSummary.ts`: `regenerate` 제거(사용처 소멸 — YAGNI).
  generate(캐시-어웨어)·안전 타임아웃 로직 무변경.
- `entrypoints/sidepanel/App.tsx`: `onRegenerate` 전달 제거. **요약 불일치 배너 카피
  변경**: "…현재 설정 {언어} — 다시 생성으로 교체할 수 있어요" →
  "…현재 설정 {언어} — 다시 생성 시 함께 갱신됩니다" (이제 버튼은 번역 쪽 하나뿐).
  번역 배너 카피는 무변경.
- ~~반영 타이밍: 탭 재진입 시 GET_SUMMARY 재조회로 수렴.~~ **정정 (최종 리뷰 C1):**
  이 전제가 틀렸다 — `useSummary`는 ReadyBody 레벨(deps `[videoId, enabled]`)이라 탭
  재진입은 재조회를 일으키지 않고, done 상태 SummaryPanel엔 이제 갱신 수단이 없다.
  **수정**: 캐스케이드가 요약을 성공 저장하면 background가
  `{ type: 'SUMMARY_REFRESHED', payload: { videoId } }`를 `chrome.runtime.sendMessage`로
  브로드캐스트하고(수신자 없으면 무시), `useSummary`가 runtime.onMessage 리스너로
  videoId 일치 시 GET_SUMMARY를 재조회해 done으로 갱신한다. 패널이 닫혀 있으면
  다음 마운트의 캐시 로드가 커버.

## 4. 검증

- vitest(`src/background.test.ts`, 기존 mock 패턴): ① done + 기존 요약 존재 →
  파이프라인 settle 후 generateSummary 호출·새 요약 put ② 요약 없음 → generateSummary
  미호출 ③ 파이프라인 failed → 미호출.
- 실 Chrome: 일본어 영상(ko 번역+ko 요약 캐시)에서 `다시 생성` → 번역 완료 후 요약
  createdAt 갱신 실측, Summary 탭 헤더에 다시 생성 부재, savedAt 불변.
- 게이트: tsc 0 · vitest 전체 · build.

## 5. 비범위

요약 자동 생성(요약 없던 영상), 캐스케이드 진행 표시 UI, 요약 단독 재생성 복원.
