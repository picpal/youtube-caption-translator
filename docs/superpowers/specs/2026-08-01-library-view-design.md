# 라이브러리 — 저장한 영상 목록 · 검색 · 삭제

2026-08-01

## 1. 문제

지금까지 만든 번역본은 IndexedDB에 남아 있지만, **그 영상을 다시 열기 전에는
존재조차 보이지 않는다.** 무엇을 번역했는지 목록으로 볼 방법이 없고, 실패했거나
중간에 끊긴 기록을 지울 방법도 없다. 쌓인 데이터가 사용자 눈에 전혀 드러나지
않는 상태다.

사이드패널에 목록 화면을 하나 더해 이 세 가지를 해결한다: **찾기 · 검색 ·
정리.**

## 2. 범위

**한다**

- 사이드패널 헤더에 아이콘 하나(내려받기 왼쪽) → 라이브러리 뷰로 전환
- 번역 기록이 있는 영상을 최신순 목록으로 표시 (실패·미완료 포함)
- 영상 제목 **또는** 요약 키워드로 즉시 검색
- 항목 클릭 → 그 영상으로 이동
- 항목별 삭제 (번역 + 요약), 인라인 2단계 확인
- 목록 하단에 저장 사용량 한 줄
- README에 "폴더를 옮기면 번역본을 잃는다"를 명시

**하지 않는다** (모두 의도적 제외)

- 채널명·자막 본문 검색 — 요청된 검색 기준은 제목과 키워드 둘뿐이다
- 정렬 옵션, 페이지네이션, 가상 스크롤 — §5의 측정치가 필요 없다고 말한다
- 일괄 삭제, 태그, 메모
- 백업/복원(JSON 내보내기·가져오기)
- 매니페스트 `key` 고정 — §10에 위험과 대가를 기록만 해둔다
- 새 권한, 새 의존성, 새 서페이스(패널 + Options 둘 유지)

## 3. 화면

패널에 최상위 뷰 상태 `'video' | 'library'` 하나를 둔다. 헤더는 그대로 있고
본문만 교체된다.

```
[YouTube Caption Translator]        [준비됨] [☰] [⤓] [⚙]
                                             ↑ 새 아이콘
──────────────────────────────────────────────────────────
 ←  저장한 영상                                       12편
 ┌──────────────────────────────────────────────────────┐
 │ 제목이나 키워드로 검색                                │
 └──────────────────────────────────────────────────────┘
──────────────────────────────────────────────────────────
 ▢  Attention Is All You Need 해설                    [🗑]
 64×36  어떤채널 · 22:14 · 한국어 · 7월 29일
──────────────────────────────────────────────────────────
 ▢  Rust 비동기 런타임 뜯어보기                       [🗑]
     어떤채널 · 1:06:03 · 한국어 · 7월 31일
     tokio · executor                ← 키워드로 매치됐을 때만
──────────────────────────────────────────────────────────
 ▢  Kubernetes 네트워킹              ● 실패          [🗑]
     어떤채널 · 41:02 · 7월 25일
──────────────────────────────────────────────────────────
 영상 12편 · 2.1 MB / 10.2 GB
```

**헤더 아이콘의 표시 조건**: API 키가 등록돼 있으면(`present`) 항상 보인다.
유튜브 watch 페이지일 필요는 없다 — 라이브러리의 주 용도가 "지금 보고 있지 않은
영상 찾기"라서, 유튜브가 아닌 탭에서도 열려야 한다.

**라이브러리 뷰일 때 헤더**: 그 아이콘 자리가 ←(뒤로)로 바뀌고, 내려받기는
숨는다(대상 영상이 없다). 상태 뱃지와 톱니는 그대로.

**뷰 전환은 조건부 렌더링이다.** 라이브러리를 열면 `ReadyBody`가 언마운트되고,
닫으면 새로 마운트된다. 이 선택의 근거와 대가는 §11에 있다.

**행 구성**: 썸네일 64×36, 제목 최대 2줄 말줄임, 그 아래 `채널 · 길이 · 언어 ·
날짜`. `status`가 `done`이 아닐 때만 상태 뱃지를 붙인다 —
`failed`는 `tone="error"`로 `실패`, `analyzing`/`translating`은 `tone="warn"`으로
`진행 중`, 나머지는 `tone="muted"`로 `미완료`.

행의 표기 규칙(모두 `src/lib/library.ts`의 순수 함수로, 테스트 가능하게):

- 길이 — 기존 `formatTimestamp`(`src/lib/transcript-parse.ts`)를 쓴다.
  `durationSeconds`가 `null`이면 그 조각을 통째로 뺀다(`0:00`으로 꾸며내지 않는다 —
  `VideoMeta.durationSeconds`의 `null` 규약이 명시적으로 금지한다).
- 언어 — 기존 `TARGET_LANG_LABELS`.
- 날짜 — `updatedAt`을 `M월 D일`로, 올해가 아니면 `YYYY년 M월 D일`로.
- 채널 — `channelName`이 `null`이면 그 조각을 뺀다.

**헤더 오른쪽 편수**: 검색 중이 아니면 `12편`, 검색 중이면 `3 / 12편`.

**빈 상태**

- 기록이 하나도 없을 때: `아직 저장한 영상이 없어요` + `유튜브 영상에서 AI 자막을
  만들면 여기에 쌓입니다`
- 검색 결과가 없을 때: `검색 결과가 없어요`

## 4. 데이터

### 4.1 목록 항목

`src/types/library.ts` (신규):

```ts
export interface LibraryEntry {
  videoId: string;
  /** VideoMeta가 없으면 videoId를 그대로 쓴다 (제목 없는 행을 만들지 않는다). */
  title: string;
  channelName: string | null;
  thumbnailUrl: string;
  durationSeconds: number | null;
  status: TranslationStatus;
  /** record.targetLang ?? 'ko' — 언어 일반화 이전 레코드 규약을 그대로 따른다. */
  targetLang: TargetLang;
  segmentCount: number;
  /** 요약이 없으면 빈 배열. 검색 대상이다. */
  keywords: string[];
  hasSummary: boolean;
  /** 정렬 키 (내림차순). */
  updatedAt: string;
  /** 지금 background에서 번역이나 요약 잡이 도는 중 — 삭제 금지 신호. */
  inFlight: boolean;
}
```

### 4.2 메시지

패널이 IndexedDB를 직접 읽지 않는 기존 규율을 지킨다. `src/types/message.ts`에
둘을 추가한다.

| 메시지 | 응답 |
| --- | --- |
| `GET_LIBRARY` | `LibraryEntry[]` — `updatedAt` 내림차순, 동률이면 `videoId` 오름차순 |
| `DELETE_LIBRARY_ENTRY { videoId }` | `{ ok: true }` \| `{ ok: false; error: string }` |

`DELETE_LIBRARY_ENTRY`의 `error`는 다른 핸들러들과 같은 규약을 따른다 — 원문
영어 사유를 돌려주고 한국어 문구는 패널이 만든다.

### 4.3 목록을 만드는 경로

background가 세 스토어를 조인해 §4.1의 투영을 만든다.

1. `listTranslationDigests()` — `translations`를 **커서로** 순회하며 레코드당
   `{ videoId, status, segmentCount, targetLang, updatedAt }`만 남기고 버린다.
   `segments` 배열은 `length`만 취한다.
2. `getAllVideos()` — 제목·채널·썸네일·길이. 작다.
3. `getAllSummaries()` — `keywords`와 `hasSummary`. 작다.
4. `inFlightTranslations`(background.ts) 또는 `inFlightSummaries`에 있으면
   `inFlight: true`.

**목록의 기준 스토어는 `translations`다.** `videos`를 기준으로 삼으면 안 된다 —
그 스토어는 watch 페이지를 방문하기만 해도 채워지므로(`background.ts`의
`VIDEO_DETECTED` 핸들러), 번역한 적 없는 영상이 목록에 섞인다. `videos`는 제목과
썸네일을 붙이기 위해 조인만 한다. `videos`에 짝이 없는 번역 기록(메타가 정리됐거나
아직 안 쓰인 경우)은 `videoId`를 제목으로, 유도된 URL을 썸네일로 써서 **행을 빠뜨리지
않는다.**

**썸네일 유도**: 지금은 `src/lib/video-meta.ts:556`에
`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` 식으로 인라인돼 있다. 이를
`src/lib/youtube.ts`에 `thumbnailUrlFor(videoId: string): string`로 뽑아
`video-meta.ts`가 그것을 쓰게 한다. background가 `video-meta.ts`를 import하면
DOM 파싱 코드 전체가 서비스 워커 번들에 딸려 들어오는데, 문자열 하나 때문에 그럴
이유가 없다 — `youtube.ts`는 이미 URL만 다루는 순수 모듈이다.

### 4.4 커서를 쓰는 이유 (측정)

dev 프로필의 실제 레코드 4편(322·142·84·36구간, 합계 339 KB)으로 잰 값:

| | 시간 | 결과 크기 |
| --- | --- | --- |
| `getAll` (값 전체) | 1.6 ms | 339 KB |
| 커서 투영 | 2.6 ms | **0.3 KB** |
| `getAllKeys` | 0.3 ms | — |

**커서가 읽기 자체는 오히려 느리다** (레코드마다 왕복이 생긴다). 커서를 쓰는
이유는 읽기 속도가 아니라 **패널로 건너가는 양**이다. 영상 100편이면
`getAll`을 그대로 전달할 때 약 18 MB가 `sendMessage`의 구조화 복제를 통과하는데,
투영하면 약 8 KB다. 이 차이가 유일한 근거이며, 스펙은 "메모리 피크"를 근거로 삼지
않는다.

## 5. 규모 (측정)

같은 프로필에서 잰 값과 그 외삽:

| 규모 | 저장 용량 | 목록 조회 |
| --- | --- | --- |
| 현재 4편 | 339 KB | 1.6~2.6 ms |
| 100편 | 약 18 MB | 약 40~65 ms |
| 500편 | 약 90 MB | 약 0.2~0.3 초 |

완료 레코드는 **자막 구간당 약 594 B**(원문 + 번역 + 타임스탬프), 1시간 영상
1편이 약 186 KB다. 확장 오리진의 쿼터는 **10.2 GB**로 측정됐다 — 100편이 그
0.18%다.

조회는 **라이브러리를 열 때 한 번**이고 패널을 열 때마다가 아니다. 이 수치들이
페이지네이션·가상 스크롤·목록 전용 인덱스 스토어를 §2의 비범위로 보낸 근거다.
느려진다면 그때 다시 재고 도입한다.

## 6. 검색

`src/lib/library.ts` (신규)의 순수 함수로 분리한다. 이 저장소에는 훅 렌더
하니스가 없어서(`playback-sync.ts`, `summary.ts`가 같은 이유로 분리돼 있다) 결정
로직을 컴포넌트 안에 두면 검증할 수 없다.

```ts
export function filterLibrary(entries: LibraryEntry[], query: string): LibraryEntry[]
export function matchedKeywords(entry: LibraryEntry, query: string): string[]
```

- 공백만 있거나 빈 질의는 **전체를 그대로** 돌려준다.
- 질의와 대상 모두 `trim()` + `toLowerCase()` 후 **부분 문자열** 비교.
- `title`이 맞거나 `keywords` 중 하나가 맞으면 통과 (OR).
- 입력 즉시 필터한다. 디바운스하지 않는다 — 대상이 로컬 배열 수십 건이다.
- `matchedKeywords`는 **키워드로 매치된 행에만** 칩을 그리기 위한 것이다. 최대
  3개까지 표시한다. 이게 없으면 제목과 무관해 보이는 결과가 이유 없이 튀어나온
  것처럼 읽힌다.

## 7. 삭제

### 7.1 지우는 것

`translations` + `summaries`의 해당 `videoId` 레코드, **한 트랜잭션 안에서.**
원자성이 필요한 이유는 분명하다 — 번역만 지워지고 요약이 남으면 목록에서 사라진
영상의 요약이 영원히 고아로 남는다.

`videos`의 메타는 **남긴다.** 제목·썸네일 캐시일 뿐이고 그 영상을 다시 방문하면
어차피 덮어써진다. 목록 기준이 `translations`이므로 행은 정상적으로 사라진다.

### 7.2 진행 중이면 거부한다

`inFlightTranslations` 또는 `inFlightSummaries`에 있는 `videoId`는 삭제하지
않는다. 이유가 실재한다: 번역 도중 레코드를 지우면 다음 `upsertBatch`가 레코드
부재를 보고 트랜잭션을 abort시키고(`src/lib/db.ts:154`), 파이프라인이 사용자에게는
이유 없는 에러로 죽는다. 요약 잡이 도는 중에 지우면 잡이 끝나면서 요약이 다시
쓰여 좀비가 남는다.

**두 겹으로 막는다.**

- UI: `inFlight`인 행은 trash 버튼이 `disabled`이고 `title`이 `진행 중에는 지울 수
  없어요`다.
- background: `DELETE_LIBRARY_ENTRY` 핸들러도 독립적으로 검사하고
  `{ ok: false, error: 'job in flight' }`로 거부한다. 패널이 들고 있는 `inFlight`는
  목록을 읽은 시점의 스냅샷이라 낡을 수 있다 — 진짜 방어선은 이쪽이다.

### 7.3 확인

trash를 누르면 **그 행이 확인 상태로 바뀐다**: `이 영상의 자막을 지울까요?
[삭제] [취소]`. 별도 모달을 띄우지 않는다(400 px 패널에 맞지 않는다).

- 확인 상태 진입 시 포커스는 **[취소]로** 간다. [삭제]에 두면 엔터 연타로 지워진다.
- Escape로 취소된다.
- 한 번에 한 행만 확인 상태다 — 다른 행의 trash를 누르면 이전 확인은 닫힌다.
- 확인 없이 지우지 않는다. 되돌릴 수 없고, 재생성에 5~8분과 Gemini 호출이 다시 든다.

### 7.4 삭제 후

응답이 `ok`면 패널의 로컬 배열에서 그 항목만 제거한다(전체 재조회 없음).
실패하면 목록은 그대로 두고 행에 사유를 표시한다.

**현재 보고 있는 영상을 지운 경우**도 별도 배관이 필요 없다. 뷰 전환이
재마운트이므로(§3), 돌아가면 `useTranslation`/`useSummary`가 새로 조회하고 패널은
"AI 자막 생성" 이전 상태로 정확히 돌아간다.

## 8. 항목 클릭

활성 탭의 URL이 youtube.com이면 `chrome.tabs.update(tabId, { url })`로 그 탭을
해당 영상으로 옮기고, 아니면 `chrome.tabs.create({ url })`로 새 탭을 연다. 그
다음 뷰를 `'video'`로 되돌린다. 패널은 활성 탭을 따라가므로 자연히 그 영상 화면이
된다.

**둘 다 새 권한이 필요 없다.** `tabs.update`/`tabs.create`는 무권한으로 동작하고,
활성 탭의 URL을 읽는 것은 이미 있는 `youtube.com` host_permission으로 충족된다
(유튜브가 아닌 탭에서는 `url`이 `undefined`로 오는데, 그 경우도 새 탭 경로로
가므로 동작이 옳다).

## 9. 저장 사용량

목록 하단에 한 줄: `영상 12편 · 2.1 MB / 10.2 GB`.

패널에서 `navigator.storage.estimate()`를 직접 부른다 — 사이드패널은 확장과 같은
오리진이라 background를 경유할 이유가 없다. 호출이 거부되거나 `quota`/`usage`가
`undefined`면 **편수만** 표시한다.

`usage`는 이 확장 오리진 전체의 사용량이라 번역본 외의 것도 포함한다. 문구를
"영상 N편이 M MB"가 아니라 위 형태로 두는 이유가 이것이다 — 편수와 용량을 인과로
묶지 않는다.

## 10. 데이터 보존 (기록용, 이번 범위 밖)

확인된 사실:

- **크롬의 「인터넷 사용 기록 삭제」는 이 데이터를 지우지 않는다.** 그 기능은
  웹사이트 오리진만 대상으로 하고 `chrome-extension://`는 범위 밖이다.
- `navigator.storage.persisted()`가 `false`로 측정됐다 — best-effort 스토리지라
  디스크가 극단적으로 찰 때 축출 대상이 될 수 있다. 현실적 위험은 낮다.
- **매니페스트에 `key`가 없다.** 압축해제 확장의 ID는 폴더 경로에서 유도되므로,
  폴더를 옮기거나 이름을 바꾸면 ID가 바뀌고 = 오리진이 바뀌고 = 기존 번역본에
  접근할 수 없게 된다(디스크에는 남지만 고아).

세 번째가 가장 큰 실제 위험이다. `key`를 박으면 사라지지만, **도입하는 순간 ID가
바뀌어 지금 저장된 데이터가 고아가 된다** — ID는 key의 해시에서 나오므로 현재
ID를 유지하는 key를 만들 수는 없다. 이번 범위에서는 다루지 않고, README 문구만
고친다(§12).

## 11. 트레이드오프 하나

뷰 전환을 조건부 렌더링(언마운트/재마운트)으로 하기 때문에, **번역이 도는 중에
라이브러리를 열었다 돌아오면 진행률 퍼센트가 다음 progress 이벤트까지 최대 ~15초
비어 보일 수 있다**(청크 하나가 약 15초). "번역 중"이라는 상태 자체는 즉시
복원된다 — `shouldResume`(`useTranslation.ts:141`)이 저장된 레코드의
`analyzing`/`translating`을 읽고, Port가 재연결되며, 다시 보낸
`START_TRANSLATION`은 background의 `inFlightTranslations` 중복 방지에 걸려 잡을
새로 시작하지 않는다.

이걸 없애려면 `ReadyBody`를 언마운트하지 않고 CSS로 숨겨야 하는데, 그러면 §7.4가
공짜로 얻는 삭제 반영을 위해 브로드캐스트 배관을 새로 깔아야 한다. 15초 공백보다
그 배관이 비싸다고 판단했다. §13의 검증 항목에 이 시나리오를 넣어 실제 동작을
확인한다.

## 12. 파일

| 파일 | 역할 |
| --- | --- |
| `src/types/library.ts` (신규) | `LibraryEntry` |
| `src/lib/library.ts` (신규) | `filterLibrary`, `matchedKeywords`, 행 표시 포맷 |
| `src/lib/db.ts` (수정) | `listTranslationDigests`, `getAllVideos`, `getAllSummaries`, `deleteVideoData` |
| `src/lib/youtube.ts` (수정) | `thumbnailUrlFor` 추가 |
| `src/lib/video-meta.ts` (수정) | 556행의 인라인 URL을 `thumbnailUrlFor` 호출로 |
| `src/types/message.ts` (수정) | 메시지 2개 + 응답 2개 |
| `entrypoints/background.ts` (수정) | 핸들러 2개 (조인·투영, 삭제) |
| `src/components/LibraryView.tsx` (신규) | 검색창 + 목록 + 행 + 확인 + 빈 상태 + 사용량 |
| `entrypoints/sidepanel/App.tsx` (수정) | 뷰 상태, 헤더 아이콘 |
| `README.md` (수정) | 폴더 이동 경고 |

`App.tsx`는 이미 1003줄이다. 라이브러리 마크업은 한 줄도 그쪽에 넣지 않는다 —
`App.tsx`의 변경은 뷰 상태 하나, 헤더 아이콘 버튼 하나, 본문 분기 한 줄로 끝난다.

아이콘은 헤더의 `GearIcon`/`DownloadIcon`과 같은 방식의 인라인 SVG로 만든다.
아이콘 라이브러리를 추가하지 않는다.

**README 변경**: 설치 §2의 "나중에 폴더를 지우거나 옮기면 확장 프로그램이
사라집니다"를, 확장뿐 아니라 **지금까지 만든 번역본과 요약을 통째로 잃는다**는
뜻이라고 고쳐 쓴다.

## 13. 테스트와 검증

### 단위 테스트 (vitest)

- `filterLibrary` — 빈 질의는 전체 통과 / 제목 부분일치 / 키워드 일치 / 대소문자
  무시 / 어느 쪽도 안 맞으면 제외 / 공백만 있는 질의
- `matchedKeywords` — 맞은 키워드만, 최대 3개, 제목만 맞은 행은 빈 배열
- `db.deleteVideoData` — 두 스토어가 함께 사라지고 `videos`는 남는다
- `db.listTranslationDigests` — `segments` 배열이 결과에 포함되지 않는다
- `GET_LIBRARY` 핸들러 — `videos`에만 있고 번역이 없는 영상은 목록에 없다 /
  번역은 있는데 `videos`에 없는 영상은 `videoId`를 제목으로 포함된다 /
  `updatedAt` 내림차순 / 진행 중이면 `inFlight: true`
- `DELETE_LIBRARY_ENTRY` 핸들러 — 진행 중이면 거부하고 **아무것도 지우지 않는다**

기존 424개가 모두 통과해야 한다.

### 실제 크롬 검증 (CDP)

1. 아이콘 클릭 → 목록이 뜨고 저장된 영상이 전부 보인다
2. 제목 일부로 검색 → 해당 행만 남는다
3. **제목에 없는 요약 키워드**로 검색 → 그 영상이 나오고 키워드 칩이 보인다
4. trash → 확인 → 취소 → IndexedDB가 그대로다
5. trash → 확인 → 삭제 → 행이 사라지고, `translations`·`summaries`에서 함께
   사라지고, `videos`는 남아 있다
6. 진행 중인 영상(CDP `Fetch` 인터셉트로 잡을 고정) → trash가 비활성이고,
   background에 직접 `DELETE_LIBRARY_ENTRY`를 보내도 거부되며 레코드가 남는다
7. 항목 클릭 → 활성 유튜브 탭이 그 영상으로 이동하고 패널이 그 영상 화면이 된다
8. 번역 진행 중 라이브러리를 열었다 돌아오면 "번역 중" 상태가 유지된다 (§11)
9. 삭제한 영상으로 돌아가면 패널이 "AI 자막 생성" 이전 상태다
10. `geminiApiKeySavedAt`과 `permissions`가 불변이다
