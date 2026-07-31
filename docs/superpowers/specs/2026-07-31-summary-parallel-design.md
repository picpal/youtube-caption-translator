# 요약을 번역과 병렬 실행 — 설계

## 1. 목표

`AI 자막 생성`을 누르면 요약도 같이 시작해서, 요약에 드는 3~4분을 번역의
7~8분 안에 감춘다. Gemini 요청 총량은 그대로 두고 벽시계 시간만 겹친다.
패널 UI는 바꾸지 않는다 — 번역이 끝나 Summary 탭이 나타나는 순간 요약이 이미
캐시에 있는 상태가 목표다.

## 2. 근거 — 요약은 번역 결과를 쓰지 않는다

`src/lib/summary.ts:26` `buildSummaryPrompt`는 `[startSec] ${s.sourceText}`만
사용한다. `translatedText`는 프롬프트에 들어가지 않는다.

그리고 `src/features/translation/pipeline.ts:552-570`에서, **번역이 시작되기
전에** 세그먼트 전체가 이미 영속된다:

```ts
record = { videoId, captionHash: hash, status: 'analyzing', segments, … };
await deps.putTranslation(record);      // ← 요약 입력이 이 시점에 완비
```

이후 단계(용어 분석 → 청크 번역)는 같은 세그먼트에 `translatedText`만 채운다.
즉 요약이 번역을 기다릴 이유가 원래 없었다.

현재 `entrypoints/background.ts`의 `runSummaryGeneration`에 있는
`record.status !== 'done'` 가드는 번역 결과가 필요해서가 아니라, 요약을 나중에
붙이면서 패널의 탭 노출 조건(`showSummaryTab`)에 방어적으로 맞춘 것이다.
그 주석도 "Defense-in-depth … the panel now gates the Summary tab on a done
record"라고 스스로 밝히고 있다.

**실측** (1:06:32 / 자막 322구간): 번역 7분 53초, 요약 3분 45초.
직렬 11분 38초 → 병렬 약 8분.

## 3. 트리거 지점

`pipeline.ts`는 건드리지 않는다. background가 이미 넘기고 있는 `onProgress`
콜백에서 **`status === 'analyzing'` 이벤트가 오는 순간** 요약 잡을 시작한다.
그 이벤트는 위 `putTranslation` 직후에 발생하므로(`pipeline.ts:583-589`),
"세그먼트가 디스크에 있다"가 보장되는 가장 이른 지점이다.

- 재개(resume) 실행에서도 같은 이벤트가 나오고, 그 경우 세그먼트는 기존
  레코드에 이미 있으므로 동일하게 안전하다.
- 추출이 실패하면 `analyzing` 이벤트 자체가 오지 않으므로 요약도 시작되지
  않는다 — 별도 가드가 필요 없다.
- 한 실행에서 두 번 시작되지 않도록 기존 `inFlightSummaries` 단일 비행 맵을
  그대로 쓴다(`startSummaryJob`).

**캐시 히트 보완 트리거.** `pipeline.ts:526-536`의 캐시 히트 조기 반환(자막
해시·언어가 모두 그대로이고 레코드가 이미 `done`)은 `status:'done'` 이벤트만
내보내고 `analyzing`은 건너뛴다 — 이 경로에서는 위 트리거가 아예 걸리지
않는다. 그래서 background는 이번 실행에서 `analyzing`을 본 적이 있는지를
로컬 플래그(`sawAnalyzingEvent`)로 기억해 두었다가, `done` 이벤트가 오면
**그 플래그가 여전히 false이고(순수 캐시 히트) 요약 캐시가 비어 있을 때만**
(`getSummary`로 확인) 같은 트리거를 한 번 더 건다. 두 조건 모두 필요하다:

- `analyzing`을 봤다면 그 실행이 이미 요약 잡을 띄운 것이므로, `done`에서
  또 부르면 그 잡이 실패했을 경우 조용한 재시도가 된다 — `summaryRetryPlan`이
  타임아웃 등을 일부러 재시도하지 않기로 한 결정(`src/lib/summary.ts`)을
  뒤에서 무력화한다.
- 요약이 이미 있다면 자막도 언어도 그대로인 이상 다시 만들 이유가 없다 —
  같은 입력에 Gemini 요청만 한 번 더 나간다.

즉 이 보완 트리거가 실제로 담당하는 경우는 정확히 하나, **"번역은 이미
있는데 요약이 없는 영상"**이다 — 이 기능이 들어오기 전에 이미 번역해 둔
영상 전부가 여기 해당하고, 자막이 그대로인 채로 누르는 `다시 생성`도
같은 경로를 탄다.

## 4. `다시 생성` 캐스케이드는 제거하고 이 경로로 흡수한다

지금은 `START_TRANSLATION` 핸들러의 `.then()`에서, 파이프라인이 `done`으로
정착한 **뒤에** 요약을 재생성한다 — 그것도 `이미 요약이 있을 때만`
(`if (rec?.status !== 'done' || !cached) return;`).

병렬 트리거를 넣으면서 이 블록을 그대로 두면 **한 번의 `다시 생성`이 요약을
두 번 호출**한다. 캐스케이드 블록을 삭제하고, 그 역할을 §3의 두 트리거
(`analyzing` 트리거 + 캐시 히트 보완 트리거)가 대신한다. 결과적으로 동작이
세 가지 바뀐다:

| | 이전 | 이후 |
| --- | --- | --- |
| 첫 번역 | 요약 없음 (사용자가 버튼을 눌러야 생성) | 자동 생성 |
| `다시 생성`, 자막이 바뀜 (또는 아직 요약이 없는 기존 번역) | 요약이 이미 있을 때만 갱신 | 항상 갱신 |
| `다시 생성`, 자막이 그대로이고 요약도 이미 있음 (캐시 히트) | 요약이 이미 있을 때만 갱신 | 아무 일도 하지 않음 (Gemini 호출 0회) |

가운데 행은 처음엔 "다시 생성 → 항상 갱신"으로 단순하게 적었으나, 실제로는
셋째 행의 캐시 히트 케이스가 별도로 존재한다 — 자막·언어가 그대로면 입력이
동일하므로 요약을 다시 만들 이유가 없고, §3의 두 조건(`analyzing`을 못
봤고 요약 캐시가 비어 있음)이 정확히 그 경계를 가른다. "항상 갱신"은
자막이 실제로 바뀌었을 때, 또는 이 기능 도입 전에 번역만 있고 요약은 없던
영상에만 해당한다.

첫 번역에서 자동 생성되는 것은 의도된 변경이다(사용자 결정). 영상 1편당
Gemini 요청이 9~10회에서 10~11회로 늘지만, 무료 티어 250회/일 기준 부담이
없고 `요약 생성` 버튼을 누를 일이 사라진다.

`SUMMARY_REFRESHED` 브로드캐스트는 **유지한다.** 캐스케이드 블록에서 새 경로로
옮긴다 — 이게 열려 있는 패널이 "요약이 방금 채워졌다"를 알 수 있는 유일한
수단이다(`useSummary.ts`의 `chrome.runtime.onMessage` 리스너).

## 5. `runSummaryGeneration` 변경

```ts
async function runSummaryGeneration(
  videoId: string,
  opts: { followRecordLang?: boolean } = {},
): Promise<AppResponseMap['GENERATE_SUMMARY']>
```

- **가드 완화**: `record.status !== 'done'` → `record === null || record.segments.length === 0`.
  실제 요구사항은 "원문 세그먼트가 있는가"뿐이다. `failed` 레코드도 원문은
  온전하므로 요약이 가능하다.
- **번역 언어**: 파이프라인 경로(`followRecordLang: true`)는
  `record.targetLang`을 쓴다 — 파이프라인이 스탬프한 `effectiveTargetLang`과
  반드시 일치해야 하기 때문이다(재개 실행은 설정값이 아니라 레코드에 박힌
  언어로 돈다). 패널이 직접 부르는 `GENERATE_SUMMARY` 경로는 지금처럼
  `getTargetLang()`을 읽는다 — 기존 동작(설정을 바꾼 뒤 요약만 다시 만들기)과
  `summaryLangMismatch` 배너의 전제를 깨지 않기 위해서다.
  `record.targetLang`이 없는 구버전 레코드는 `getTargetLang()`으로 폴백한다.
- **실패 격리**: 요약 실패는 번역 레코드에 어떤 흔적도 남기지 않는다. 잡을
  띄우는 쪽은 `void` + `.catch`로 삼키고 `console.warn`만 남긴다. 번역
  파이프라인의 성패와 완전히 독립이다.

## 6. 동시성 · 한도

- **SW keepalive**: `acquireKeepalive`가 이미 `RefCount` 기반이라 파이프라인과
  요약이 동시에 잡아도 안전하다(마지막 해제에서만 interval이 꺼진다). 변경 없음.
- **요청 동시성**: 동시 in-flight 요청이 1 → 2가 된다. 무료 티어 10 RPM
  기준, 번역 청크는 분당 약 1회이고 요약은 3~4분에 1회이므로 여유가 크다.
- 요약이 429를 받으면 기존 `summaryRetryPlan`이 서버가 지정한 지연으로
  재시도한다. 변경 없음.

## 7. 패널에서 보이는 것

UI 코드는 바꾸지 않는다. 두 가지 경로가 생긴다.

1. **요약이 번역보다 먼저 끝난 경우(정상)** — 번역이 `done`이 되어 탭이
   나타나고, `useSummary`가 `GET_SUMMARY`로 캐시를 즉시 읽어 렌더한다.
   사용자는 기다림을 겪지 않는다.
2. **요약이 아직 도는 중에 번역이 먼저 끝난 경우** — 탭이 나타나고 빈 상태
   (`요약 생성` 버튼)가 잠깐 보인다. 곧 §4의 `SUMMARY_REFRESHED`가 도착해
   채워진다. 그 사이 사용자가 버튼을 눌러도 `startSummaryJob`의 단일 비행
   맵이 진행 중인 잡에 합류시키므로 이중 과금이 없다.

## 8. 테스트

`src/background.test.ts`에 캐스케이드 전제로 쓰인 기존 테스트들이 있다
("does not dedup a second START_TRANSLATION while the cascade is still
running" 등). 삭제가 아니라 새 동작 기준으로 갱신한다.

새로 덮을 것:

- `analyzing` 진행 이벤트가 요약 잡을 정확히 한 번 시작한다.
- 추출 실패로 `analyzing`이 오지 않으면 요약 잡이 시작되지 않는다.
- 요약 실패가 번역 레코드의 상태·세그먼트에 영향을 주지 않는다.
- 파이프라인 경로는 `record.targetLang`으로, 패널 경로는 설정값으로 돈다.
- `done`이 아닌 레코드(예: `failed`)에서도 세그먼트만 있으면 요약이 가능하다.
- 한 번의 `START_TRANSLATION`이 요약을 두 번 호출하지 않는다(캐스케이드 제거
  회귀 방지).
- 캐시 히트(`analyzing` 없이 `done`만) + 요약 없음 → 보완 트리거가
  `generateSummary`를 정확히 1회 호출한다.
- 캐시 히트 + 요약 이미 있음 → `generateSummary`가 호출되지 않는다.
- 정상 실행(`analyzing` 발생) → `done`이 와도 요약 호출은 여전히 1회다
  (보완 트리거가 두 번째 호출을 만들지 않는다).
- `analyzing` 경로의 요약이 실패한 뒤 `done`이 와도 재시도되지 않는다
  (조용한 재시도 방지).

## 9. 범위 밖

- 청크 요약(map-reduce)과 퍼센트 진행률. 병렬화로 대기 시간이 가려지므로
  급하지 않다. 2시간 이상 초장편에서 요약 입력이 두 배가 될 때를 대비한
  안전장치로 남겨둔다.
- 요약 프롬프트에 용어집 반영. 프롬프트를 건드리면 출력 품질이 함께
  흔들리므로, 이번에는 **실행 시점만** 옮긴다.
- 요약 자동 생성 on/off 설정. 항상 자동으로 간다(사용자 결정).
