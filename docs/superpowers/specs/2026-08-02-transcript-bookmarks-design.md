# 기억한 문장 — Transcript 북마크와 Notes 탭

2026-08-02

## 1. 문제

번역된 스크립트는 600행이 넘는 벽이다. 그 안에서 "이 문장은 기억하고 싶다"고
느낀 순간, 지금은 **아무것도 할 수 없다.** 다시 찾으려면 영상을 다시 열고 그
행을 눈으로 찾아야 한다.

헤더의 ⬇ 내보내기는 전체 스크립트+요약을 통째로 뱉을 뿐이라, "내가 고른 문장"과
"자동으로 딸려온 나머지 599행"을 구분하지 못한다. 선별이 없으면 복습 자료가
아니라 원본 사본이다.

Transcript 행에서 **즉시 저장**하고, 같은 패널 안에서 **모아 보고**, 노트 앱으로
**발췌만 내보낸다.**

이 기능은 새 발명이 아니다. PRD §7.8(북마크)·§10(`Bookmark` 테이블)에 이미
설계돼 있고, `src/types/transcript.ts:8`의 주석이 *"bookmarks are a later M4
table, tracked separately by segmentId rather than denormalized here"*라고 자리를
비워두고 있다. 이 스펙은 그 예약된 자리를 채운다.

## 2. 범위

**한다**

- Transcript 행 우클릭 → 커스텀 메뉴에서 저장/해제
- 행 호버 시 나타나는 ☆ 토글 (저장된 행은 ★ 상시 표시)
- 행 안에서 드래그한 텍스트가 있으면 그 조각만 저장
- 패널에 세 번째 탭 `Notes` — 그 영상의 저장 문장을 `startSec` 순으로 조회·시크·삭제
- 탭 라벨에 저장 개수 뱃지
- ⬇ 메뉴에 세 번째 항목 `기억한 문장 (.md)`
- 라이브러리에서 자막을 지우면 북마크도 같은 트랜잭션으로 삭제

**하지 않는다** (모두 의도적 제외)

- **메모·태그** — 저장 마찰을 0으로 두는 것이 북마크의 생명선이다. §4.1에 나중에
  필드를 더할 때 마이그레이션이 필요 없는 이유를 적어둔다
- **여러 영상을 가로지르는 전역 북마크 목록** — 이 기능의 용도는 "이 영상 복습"으로
  한정한다. 헤더 라이브러리 아이콘에 북마크를 얹지 않는 이유는 §3.1
- **북마크 검색·필터·정렬 옵션** — 영상당 수십 개 규모에 필요 없다
- **PDF 내보내기** — 발췌 노트의 목적지는 노트 앱이라 Markdown이면 충분하다
- **재생 위치 동기화·활성 행 하이라이트** — Notes는 정적 목록이다
- **여러 행 범위 선택(Shift+클릭)** — 행 클릭=시크라는 기존 규칙과 충돌한다.
  드래그 선택이 같은 필요를 이미 덮는다
- 새 권한, 새 의존성, 새 서페이스 (패널 + Options 둘 유지)

## 3. 화면

### 3.1 목록이 사는 곳: 세 번째 탭

헤더의 📚 라이브러리 아이콘에 북마크를 얹지 **않는다.** 그 아이콘은 최상위
`view` 전환(`'video' | 'library'`)이고, 라이브러리를 열면 `ReadyBody`가
언마운트된다. 북마크를 거기 두면:

- 영상을 보면서 방금 저장한 문장을 확인하려면 화면을 통째로 떠났다 돌아와야 한다
- 재생 위치 동기화와 활성 행 하이라이트가 그때마다 죽었다 살아난다
- 계층이 틀리다 — 라이브러리는 **영상들**의 목록, 북마크는 **한 영상 안**의 문장들

대신 기존 탭바에 세 번째 탭을 더한다. `panel-prefs`의 `lastTab` 영속화,
sticky 탭바, 독립 스크롤을 전부 그대로 물려받는다.

```
[YouTube Caption Translator]        [준비됨] [☰] [⤓] [⚙]
──────────────────────────────────────────────────────────
 ▢ 영상 카드 / 선택자 / [다시 생성]
──────────────────────────────────────────────────────────
│ Transcript │  Summary  │  Notes 3 │        ← sticky
──────────────────────────────────────────────────────────
  12:04   Let's talk about attention…
          먼저 어텐션에 대해 얘기해 봅시다…            ← Notes 탭
 ──────────────────────────────────────────────────────
  28:41   > the key thing is the softmax    [🗑]
 ──────────────────────────────────────────────────────
  41:07   And then we normalize…
          그리고 정규화를 합니다…
```

**탭 라벨**은 `Notes`. 기존 `Transcript`/`Summary`가 영문이라 일관성을 맞춘다.
저장이 1개 이상일 때만 옆에 숫자를 붙인다. 0개일 때도 탭 자체는 보인다 —
**빈 상태 문구가 우클릭이라는 발견 어려운 인터랙션을 설명할 유일한 자리**이기
때문이다.

3탭 균등 분할(`flex-1`)이면 400px 패널에서 각 ~133px다. `Transcript`(10자)가
가장 길고 12px 폰트에서 넉넉히 들어간다.

**탭 복원 로직의 일반화.** `App.tsx`의 lastTab 복원 effect는 지금
`storedLastTab === 'summary'`를 하드코딩하고 있다. `'notes'`가 생기면 이 조건은
`storedLastTab !== 'transcript'`로 바뀌어야 한다 — 그러지 않으면 `'notes'`가
저장돼도 복원이 조용히 실패한다. 스냅백 effect(`if (!showSummaryTab)
setActiveTab('transcript')`)는 Notes 탭도 같은 게이트를 쓰므로(§8) 수정이
필요 없다.

### 3.2 Transcript 행

행 마크업을 셋으로 분해한다. 현재 `<div role="button">` **안에** ☆ 버튼을 넣으면
인터랙티브 요소 중첩이라 접근성이 깨진다.

```
<div ref={rowRefs} onContextMenu>              ← wrapper
  <div role="button" onClick={seek}>…</div>    ← 기존 시크 영역 (flex-1)
  <button onClick={toggle}>☆</button>          ← 호버 시 표시
</div>
```

`rowRefs`·`scrollIntoView` 대상과 active 배경은 wrapper로 올라간다. 시크 클릭
영역과 기존 키보드 핸들러(Enter/Space)는 안쪽 div에 그대로 남는다. ☆ 클릭이 시크를
트리거하지 않도록 `stopPropagation`.

☆는 기본 `opacity-0`, 행 호버/포커스 시 표시. **저장된 행은 호버와 무관하게 ★가
상시 보인다** — 어느 행을 이미 저장했는지가 Transcript에서 바로 읽혀야 한다.

**북마크 관련 props는 전부 선택적이다.** `TranscriptList`는 `onSeekRow`가 이미
그렇듯, 북마크 props(`bookmarks`, `onToggleBookmark`, `onSaveExcerpt`)가 없으면
☆도 우클릭 핸들러도 렌더하지 않고 **정확히 지금과 같은 화면**을 그린다. §8의
`failed` 영상 분기가 이 경로를 쓴다 — 그 분기는 `App.tsx`에서 이미 별도로
렌더되고 있으므로, props를 넘기지 않는 것만으로 조건 분기가 끝난다.

### 3.3 우클릭 메뉴

`chrome.contextMenus`가 아니라 `onContextMenu` + `preventDefault` + 커스텀
메뉴다. 새 권한이 0개이고, `DownloadMenu`가 이미 확립한 메뉴 패턴(바깥
`pointerdown`·`Escape`로 닫기, 열릴 때 첫 항목 포커스, 닫힐 때 트리거로 복귀)을
그대로 재사용한다.

| 조건 | 항목 |
| --- | --- |
| 항상 | `이 문장 기억하기` — 이미 저장돼 있으면 `기억 해제` |
| 행 안에 드래그 선택이 있을 때만 | `선택한 부분만 기억하기` |

`이 시점으로 이동`은 넣지 않는다 — 행 클릭이 이미 그 일을 한다.

메뉴는 `position: fixed`로 클릭 좌표에 띄우되, 뷰포트 오른쪽/아래를 넘으면 그
방향으로 뒤집는다. 패널이 400px로 좁아서 오른쪽 넘침은 예외가 아니라 기본이다.

### 3.4 Notes 탭 행

타임스탬프(클릭 = 시크) + 텍스트 + 휴지통. **정렬은 `startSec` 오름차순** —
저장한 순서가 아니라 영상 흐름 순이다. 복습은 영상의 시간축을 따라가는 것이
자연스럽고, 한 행에서 조각을 여러 개 저장하면 저장순은 오히려 뒤섞인다. 같은
`startSec`이 여럿이면(같은 행의 조각들) `createdAt` 오름차순으로 가른다.

- `kind === 'row'`는 `TranscriptList`가 이미 export하는 **`visibleTexts()` 순수
  함수를 재사용**해 `displayMode`(영한 동시 / 한국어)를 그대로 존중한다.
  그러려면 이 함수의 첫 인자 타입을 `TranscriptSegment`에서
  `{ sourceText: string; translatedText: string | null }`로 넓힌다 — 함수 본문이
  실제로 읽는 두 필드만 남기는 것이라 기존 호출부는 그대로 통과하고,
  `kind: 'row'`로 좁힌 `Bookmark`가 정확히 그 두 필드를 그 타입으로 가지므로
  어댑터 객체 없이 바로 넘어간다 (§4.1의 판별 유니온이 이걸 보장한다)
- `kind === 'excerpt'`는 한 줄, primary 스타일 + 왼쪽 인용 표시
- **삭제 확인 단계 없음.** 라이브러리 삭제는 재생성에 5~8분과 Gemini 재과금이 들어
  2단계 확인을 두지만, 북마크 해제는 되돌리기 비용이 사실상 0이고 해제 경로가
  Transcript의 ★로도 열려 있다

빈 상태:

```
아직 기억한 문장이 없어요
Transcript에서 문장을 우클릭하거나 ☆를 눌러 저장하세요
```

## 4. 데이터

### 4.1 Bookmark

```ts
// src/types/bookmark.ts (신규)
interface BookmarkBase {
  bookmarkId: string;   // crypto.randomUUID()
  segmentId: string;    // 출처 행. 중복 판정에만 쓰고 렌더에는 쓰지 않는다
  startSec: number;     // 시크 앵커
  createdAt: string;    // ISO
}

export type Bookmark =
  // 행 통째 — 원문은 반드시 있고, 번역은 아직 없을 수 있다
  | (BookmarkBase & { kind: 'row'; sourceText: string; translatedText: string | null })
  // 드래그 조각 — 사용자가 고른 텍스트 하나뿐. 원문/번역 구분을 하지 않는다
  | (BookmarkBase & { kind: 'excerpt'; excerpt: string });

// bookmarks 스토어의 레코드. keyPath: 'videoId'
export interface BookmarkRecord {
  videoId: string;
  bookmarks: Bookmark[];
}
```

**판별 유니온인 이유.** 네 필드를 전부 nullable로 늘어놓으면 `kind: 'row'`인데
`sourceText`가 `null`인 레코드가 타입상 합법이 된다. 유니온이면 그 조합이
컴파일 단계에서 불가능해지고, `kind`로 좁힌 뒤에는 옵셔널 체이닝 없이 필드를
바로 읽을 수 있다.

**영상당 레코드 1개(배열)로 두는 이유.** 북마크마다 레코드를 만들면 `videoId`
인덱스가 필요해지는데, `db.ts`의 서두 주석이 *"If a future schema needs cursors,
indexes, or more complex multi-store transactions, `idb` is worth revisiting
then"*이라고 그 선을 명시해뒀다. 배열이면 인덱스가 필요 없어 그 선을 건드리지
않는다. 덤으로 나머지 3스토어와 키 규칙(`videoId`)이 같아지고, 탭 뱃지 카운트는
`get` 하나, 삭제 캐스케이드는 기존 트랜잭션에 스토어 이름 하나 추가로 끝난다.

대가는 추가/삭제가 read-modify-write라는 점인데, `upsertBatch`가 이미 확립한
관용 — **단일 `readwrite` 트랜잭션 안에서 get → put, 사이에 `await` 없음** — 을
그대로 쓰면 동시 호출이 stale read로 서로를 덮어쓸 수 없다.

**참조가 아니라 스냅샷인 이유.**

1. 드래그 조각은 `segmentId`만으로 복원이 불가능하다
2. `다시 생성`이 세그먼트를 재분할하면 인덱스가 밀린다. 스냅샷은 사용자가 저장한
   그 문장을 지킨다
3. PRD §10 `Bookmark`가 이미 `sourceText`/`translatedText`를 들고 있다

**`note`를 지금 넣지 않는 이유.** IndexedDB는 레코드 스키마를 강제하지 않으므로
나중에 필드를 더해도 **버전 범프가 필요 없다** — 범프가 필요한 것은 새 스토어와
새 인덱스뿐이다. 즉 지금 비워두는 데 미래 비용이 붙지 않는다.

### 4.2 스토어

`DB_VERSION` 3 → 4. `BOOKMARKS_STORE = 'bookmarks'`를 `onupgradeneeded`에
`contains` 가드와 함께 추가한다. `createObjectStore`는 기존 스토어의 데이터를
건드리지 않으므로 비파괴 업그레이드이며, 이는 `db.test.ts`의 "v1 -> v2
migration" 스위트가 이미 검증하는 패턴 그대로다.

`db.ts`에 함수 4개:

| 함수 | 하는 일 |
| --- | --- |
| `getBookmarks(videoId)` | `Bookmark[]` (레코드 없으면 `[]`) |
| `addBookmark(videoId, bookmark)` | RMW로 배열에 push, 갱신된 배열 반환 |
| `deleteBookmark(videoId, bookmarkId)` | RMW로 제거, 갱신된 배열 반환. 없는 id는 no-op |

탭 뱃지용 count 함수는 두지 않는다 — 패널은 Notes 탭을 그리려고 어차피 전체
목록을 들고 있으므로 뱃지는 `bookmarks.length`다.

모든 트랜잭션에 `onerror`/`onabort`를 단다 — 요청 에러 없이 abort되면 프로미스가
영원히 pending으로 남는다는, `listTranslationDigests`가 이미 겪은 결함이다.

`deleteVideoData`의 트랜잭션 스토어 목록에 `BOOKMARKS_STORE`를 더해 번역·요약·
북마크를 원자적으로 지운다. 셋이 갈라지면 목록에서 사라진 영상의 북마크가 영원히
고아로 남는다(목록의 기준 스토어가 `translations`이므로 다시 보이지 않는다).

### 4.3 메시지

`db.ts`는 `background.ts`만 임포트한다는 기존 규율을 유지한다(확인함 — 패널은
100% 메시지 경유). `src/types/message.ts`에 3개 추가:

| 메시지 | payload | 응답 |
| --- | --- | --- |
| `GET_BOOKMARKS` | `{videoId}` | `{ok:true, bookmarks}` \| `{ok:false}` |
| `ADD_BOOKMARK` | `{videoId, bookmark}` | `{ok:true, bookmarks}` \| `{ok:false}` |
| `DELETE_BOOKMARK` | `{videoId, bookmarkId}` | `{ok:true, bookmarks}` \| `{ok:false}` |

**쓰기 응답이 갱신된 전체 목록을 되돌려준다.** 패널이 쓰기 후 재조회할 필요가
없고, 낙관적 업데이트를 롤백하는 상태 기계도 안 생긴다. 목록이 영상당 수십 개
규모라 페이로드가 문제되지 않는다(§5).

`ADD_BOOKMARK`의 `bookmark`는 패널에서 완성해 보낸다 — `bookmarkId`
(`crypto.randomUUID()`)와 `createdAt`도 패널이 만든다. background가 채우게 하면
응답을 받기 전까지 패널이 그 항목을 그릴 수 없다.

## 5. 규모

영상당 북마크는 수십 개 규모다. 한 건은 최대 두 문장 스냅샷(≈500B)이므로 50건이
25KB, `sendMessage`의 구조화 복제로 보내도 무시할 수 있다. 라이브러리
목록(`listTranslationDigests`)이 커서 투영으로 339KB → 0.3KB까지 줄여야 했던 것과
달리, 여기서는 전체를 그대로 주고받는다.

가상 스크롤·페이지네이션·인덱스는 이 규모에서 전부 불필요하다.

## 6. 저장 판정

### 6.1 드래그 선택

`window.getSelection()`이 비어 있지 않고 `anchorNode`가 그 행의 wrapper 안이면
(`wrapper.contains(anchorNode)`) `선택한 부분만 기억하기`를 메뉴에 넣는다.

선택이 여러 행에 걸쳐 있어도 **자르지 않고 `toString()` 그대로 저장한다.** 행
경계로 잘라내는 로직은 복잡도 대비 가치가 없고, 여러 행에 걸친 선택은 사용자가
의도한 범위다. `startSec`은 `anchorNode`가 속한 행의 값을 쓴다.

☆ 아이콘은 선택 여부와 무관하게 **항상 행 통째**를 저장한다. 아이콘 클릭 시
브라우저가 선택을 해제하는 타이밍이 일정하지 않아 "☆를 눌렀는데 조각이 저장됐다"가
재현 불가능한 형태로 섞이는 것을 막는다. 조각 저장의 경로는 우클릭 하나뿐이다.

### 6.2 중복

`kind === 'row'`이고 `segmentId`가 같으면 같은 북마크로 본다. 그 행의 ☆는 ★로
차 있고, 우클릭 메뉴는 `기억 해제`를 보여준다.

`kind === 'excerpt'`는 중복 판정을 하지 않는다 — 같은 행에서 서로 다른 조각을
여러 개 저장하는 것이 정상이다. 그래서 excerpt만 있는 행의 ☆는 비어 있다(그 행을
통째로는 아직 저장하지 않았으므로 정확한 표시다).

## 7. 내보내기

`DownloadMenu`에 세 번째 항목 `기억한 문장 (.md)`. 0개면 `disabled`이고 힌트
문구가 `기억한 문장이 없어요`로 바뀐다(기존 `hintFor` 확장).

`useExportData(open)`이 이미 video/record/summary를 읽으므로 bookmarks를 같은
훅에 더한다. 렌더는 `export-doc.ts`에 `renderBookmarksMarkdown(model)`을 새로
둔다 — 기존 `renderMarkdown`과 출력 구조가 달라 재사용이 아니라 형제 함수다.

파일명은 `${fileBaseName}-notes.md`.

```md
# {영상 제목}

> https://youtu.be/{videoId} · 기억한 문장 {N}개 · {YYYY-MM-DD}

## [12:04](https://youtu.be/{videoId}?t=724)

Let's talk about attention…

먼저 어텐션에 대해 얘기해 봅시다…

## [28:41](https://youtu.be/{videoId}?t=1721)

> the key thing is the softmax
```

타임스탬프를 **표시 텍스트와 링크 둘 다**로 두는 것은 export-doc의 I2 교훈이다 —
종이에 인쇄하면 링크가 죽으므로 `12:04`가 눈에 보여야 한다.

`displayMode`가 `'ko'`여도 내보내기는 **원문과 번역을 모두 담는다.** 패널의 표시
설정은 화면을 좁히는 선택이지 저장된 내용을 버리는 선택이 아니다. 번역이 `null`인
행은 원문만 나간다(export-doc의 I4가 남긴 규율: 빈 행을 만들지 않는다).

## 8. 엣지케이스

| 상황 | 처리 |
| --- | --- |
| 라이브러리에서 자막 삭제 | `deleteVideoData` 트랜잭션에 `BOOKMARKS_STORE` 추가 (§4.2) |
| `다시 생성`(재번역) | 북마크는 건드리지 않는다. 스냅샷이라 텍스트가 유효하고 `startSec` 시크도 유효하다. 자막 자체가 바뀌어 `segmentId`가 어긋나면 최악의 결과는 같은 문장이 두 번 저장될 수 있다는 것 — 허용한다. 자막이 같으면 병합도 결정론적이라 실무상 거의 발생하지 않는다 |
| `failed` 영상 | Notes 탭도 ☆도 **띄우지 않는다.** 현재 `showSummaryTab === false`면 탭바가 통째로 없는데(Fix round Important #1이 의도적으로 만든 구조), 여기만 예외를 뚫으면 "저장은 되는데 볼 곳이 없는" 상태가 생긴다. 번역이 완결되지 않은 영상은 복습 대상이 아니다 |
| 번역 진행 중 | 위와 같다. Notes 탭은 `showSummaryTab`이 참일 때만 존재한다 |
| 확장 컨텍스트 무효화 | 쓰기 거부 시 ★ 상태를 되돌리고 조용히 실패한다(기존 관용). 목록 로드 실패는 `LibraryView`처럼 "다시 시도" 버튼 |
| 저장 직후 영상 이동 | `useBookmarks(videoId)`가 videoId 변경 시 재조회한다. cancelled 플래그로 늦게 도착한 응답을 버린다 |

## 9. 파일

| 파일 | 책임 |
| --- | --- |
| `src/types/bookmark.ts` | 신규 — `Bookmark`, `BookmarkRecord` |
| `src/lib/bookmarks.ts` | 신규 — 순수 함수: 정렬, 중복 판정, 메뉴 항목 결정, 북마크 생성 |
| `src/lib/bookmarks.test.ts` | 신규 |
| `src/lib/db.ts` | 수정 — `BOOKMARKS_STORE`, 버전 4, 함수 4개, `deleteVideoData` 캐스케이드 |
| `src/lib/db.test.ts` | 수정 |
| `src/types/message.ts` | 수정 — 메시지 3종 |
| `entrypoints/background.ts` | 수정 — 핸들러 3개 |
| `src/background.test.ts` | 수정 |
| `src/features/bookmarks/useBookmarks.ts` | 신규 — 조회/추가/삭제 훅 |
| `src/components/TranscriptList.tsx` | 수정 — 행 3분할, ☆, `onContextMenu` |
| `src/components/RowContextMenu.tsx` | 신규 — 우클릭 메뉴 |
| `src/components/NotesPanel.tsx` | 신규 — Notes 탭 본문 |
| `src/lib/panel-prefs.ts` | 수정 — `PanelTab`에 `'notes'` 추가 |
| `src/lib/panel-prefs.test.ts` | 수정 |
| `src/lib/export-doc.ts` | 수정 — `renderBookmarksMarkdown` |
| `src/lib/export-doc.test.ts` | 수정 |
| `src/features/export/useExportData.ts` | 수정 — bookmarks 추가 |
| `src/components/DownloadMenu.tsx` | 수정 — 세 번째 항목 |
| `entrypoints/sidepanel/App.tsx` | 수정 — 탭 배열에 `Notes` 하나, 분기 하나. 마크업은 넣지 않는다 |

`App.tsx`는 이미 1077줄이다. Notes 마크업은 `NotesPanel.tsx`가 전부 가지고,
`App.tsx`의 변경은 탭 정의와 렌더 분기뿐이다.

## 10. 테스트

이 저장소에는 컴포넌트 렌더 테스트 하니스가 없다(`@testing-library/*` 없음,
`*.test.tsx` 0개). 따라서 `library.ts`/`export-doc.ts`가 세운 규율 — **판단은
전부 순수 함수로 뽑고 컴포넌트는 그리기만 한다** — 을 그대로 따른다.

### 단위 테스트 (vitest)

- `bookmarks.ts` — `startSec` 오름차순 정렬(동률이면 `createdAt`), `row` 중복
  판정, `excerpt`는 중복 판정하지 않음, 우클릭 메뉴 항목 결정(`선택 있음/없음` ×
  `저장됨/아님` 4조합), 행/조각 북마크 생성
- `db.ts` — v3 → v4 비파괴 마이그레이션(기존 v1 → v2 스위트 패턴), 없는 영상의
  `getBookmarks`가 `[]`, RMW 추가/삭제, 없는 `bookmarkId` 삭제가 no-op,
  `deleteVideoData` 3스토어 캐스케이드
- `export-doc.ts` — `renderBookmarksMarkdown`: 0개 / `row`만 / `excerpt` 혼합 /
  번역 `null` / 타임스탬프 링크의 `?t=` 초값
- `panel-prefs.ts` — `'notes'`가 유효한 `lastTab`, 알 수 없는 값은 기본값 폴백
- `background.ts` — 메시지 3종 핸들러, db 거부 시 `{ok:false}`

### 실제 크롬 검증 (CDP)

컴포넌트에 렌더 테스트가 없으므로 다음은 실제 크롬에서 확인한다. 서비스워커는
`loadUnpacked`가 아니라 `runtime.reload`로 교체하고, 숨은 탭은 스크롤 이벤트를
억제하므로 대상 탭을 활성 상태로 둔다.

- 우클릭 → 메뉴 표시 → 저장 → ★ 전환 + 탭 뱃지 증가
- 드래그 선택 → 우클릭 → 조각 저장 → Notes에 조각만 표시
- 메뉴가 패널 오른쪽 경계에서 뒤집히는지
- ☆ 클릭이 시크를 유발하지 않는지
- Notes 행 클릭 → 영상이 그 시점으로 이동
- `displayMode` 전환이 Notes의 `row` 항목에 반영되는지
- ⬇ → `기억한 문장 (.md)` 다운로드 내용
- 라이브러리에서 삭제 후 북마크가 남지 않는지
