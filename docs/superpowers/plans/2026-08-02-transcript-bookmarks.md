# 기억한 문장 — Transcript 북마크와 Notes 탭 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcript 행을 우클릭하거나 ☆를 눌러 문장을 저장하고, 패널의 세 번째 탭 `Notes`에서 그 영상의 저장 문장을 모아 보고, Markdown으로 내보낸다.

**Architecture:** IndexedDB에 `bookmarks` 스토어를 하나 더한다(영상당 레코드 1개, 안에 배열). background가 조회·추가·삭제 메시지 3종을 처리하고, 쓰기 응답은 갱신된 전체 배열을 되돌려준다. 패널은 `useBookmarks(videoId)` 훅 하나로 그 배열을 들고 있으며, Transcript의 ★ 표시·Notes 탭 목록·탭 뱃지 숫자가 모두 같은 배열에서 파생된다.

**Tech Stack:** WXT + React 18 + TypeScript + Tailwind, Manifest V3, vitest + fake-indexeddb

**설계 문서:** `docs/superpowers/specs/2026-08-02-transcript-bookmarks-design.md`

## Global Constraints

이 절의 모든 항목은 **모든 태스크의 요구사항에 암묵적으로 포함된다.**

- **새 의존성 추가 금지.** `@testing-library/*`를 포함해 어떤 패키지도 추가하지
  않는다. 이 저장소에는 컴포넌트 렌더 테스트 하니스가 **없다**(측정: `package.json`에
  testing-library 없음, `*.test.tsx` 파일 0개). 따라서 **모든 결정 로직은
  `src/lib/bookmarks.ts`의 순수 함수로 뽑아 테스트하고, 컴포넌트는 그 함수를 호출만
  한다.** `pnpm`/`npm install` 부작용으로 `package-lock.json`이 생기면 삭제한다.
- **새 권한 금지.** `wxt.config.ts`의 `permissions`는 정확히 `['storage', 'sidePanel']`
  그대로 유지한다. **`chrome.contextMenus`를 쓰지 않는다** — 우클릭 메뉴는
  `onContextMenu` + `preventDefault` + 자체 렌더다.
- **새 서페이스 금지.** 새 확장 페이지(`*.html` 엔트리포인트)를 만들지 않는다.
  Notes는 사이드패널 안의 탭이다.
- **아이콘은 인라인 SVG.** 아이콘 라이브러리를 추가하지 않는다.
  `src/components/LibraryView.tsx`의 `TrashIcon`과 같은 방식(`width="16"`,
  `stroke="currentColor"`, `strokeWidth="2"`, `aria-hidden`)을 따른다.
- **UI 문구는 한국어.** 이 계획에 적힌 문구를 **글자 그대로** 쓴다.
- **시계와 난수를 순수 함수 안에서 읽지 않는다.** `new Date()`와
  `crypto.randomUUID()`는 호출부(컴포넌트/훅)에서 만들어 인자로 넘긴다 —
  `export-doc.ts`의 `exportedAt`이 세운 관용이다.
- **`entrypoints/sidepanel/App.tsx`는 이미 1077줄이다.** Notes 마크업을 한 줄도
  넣지 않는다. 그 파일의 변경은 훅 호출 하나, 탭 배열 항목 하나, 렌더 분기 하나,
  그리고 Task 7이 명시하는 복원 로직 한 줄뿐이다.
- **`scripts/` 아래 어떤 스크립트도 실행하지 않는다.** 저장소 루트의 `.env.local`을
  읽거나 열지 않는다.
- **베이스라인: 479개 테스트 / 24개 파일이 통과 중이다.** 각 태스크 종료 시
  `npx vitest run` 전체 통과 + `npx tsc --noEmit` 무오류여야 한다.
- **커밋은 태스크당 하나**, 메시지는 영어 한 줄로 무엇이 달라졌는지 말한다.

---

## 파일 구조

| 파일 | 책임 | 태스크 |
| --- | --- | --- |
| `src/types/bookmark.ts` | 신규 — `Bookmark` 판별 유니온, `BookmarkRecord` | 1 |
| `src/lib/db.ts` | 수정 — `BOOKMARKS_STORE`, 버전 4, 조회/추가/삭제, 삭제 캐스케이드 | 1 |
| `src/lib/db.test.ts` | 수정 | 1 |
| `src/lib/bookmarks.ts` | 신규 — 정렬·중복 판정·메뉴 항목·북마크 생성 순수 함수 | 2 |
| `src/lib/bookmarks.test.ts` | 신규 | 2 |
| `src/types/message.ts` | 수정 — 메시지 3종 + 응답 맵 | 3 |
| `entrypoints/background.ts` | 수정 — 핸들러 3개 + `errorResponseFor` 3분기 | 3 |
| `src/background.test.ts` | 수정 | 3 |
| `src/features/bookmarks/useBookmarks.ts` | 신규 — 조회/추가/삭제 훅 | 4 |
| `src/components/TranscriptList.tsx` | 수정 — 행 3분할, ☆ 버튼, `visibleTexts` 인자 확장 | 4, 5, 6 |
| `src/components/RowContextMenu.tsx` | 신규 — 우클릭 메뉴 | 5 |
| `src/components/NotesPanel.tsx` | 신규 — Notes 탭 본문 | 6 |
| `src/lib/panel-prefs.ts` | 수정 — `PanelTab`에 `'notes'` | 7 |
| `src/lib/panel-prefs.test.ts` | 수정 | 7 |
| `entrypoints/sidepanel/App.tsx` | 수정 — 훅 호출, 탭 하나, 분기 하나, 복원 조건 | 7 |
| `src/lib/export-doc.ts` | 수정 — `renderBookmarksMarkdown` | 8 |
| `src/lib/export-doc.test.ts` | 수정 | 8 |
| `src/features/export/useExportData.ts` | 수정 — `bookmarks` 추가 | 8 |
| `src/components/DownloadMenu.tsx` | 수정 — 세 번째 항목 | 8 |

---

### Task 1: 타입과 db 레이어

**Files:**
- Create: `src/types/bookmark.ts`
- Modify: `src/lib/db.ts`
- Test: `src/lib/db.test.ts`

**Interfaces:**
- Consumes: 기존 `openDb`, `DB_NAME`, `DB_VERSION`, `TRANSLATIONS_STORE`,
  `SUMMARIES_STORE`, `deleteVideoData` (모두 `src/lib/db.ts` 안에 이미 있다)
- Produces:
  - `Bookmark`, `BookmarkRecord` (`~/types/bookmark`)
  - `BOOKMARKS_STORE: 'bookmarks'`
  - `getBookmarks(videoId: string): Promise<Bookmark[]>`
  - `addBookmark(videoId: string, bookmark: Bookmark): Promise<Bookmark[]>`
  - `deleteBookmark(videoId: string, bookmarkId: string): Promise<Bookmark[]>`

- [ ] **Step 1: 타입 파일을 만든다**

`src/types/bookmark.ts`:

```ts
// spec 2026-08-02 §4.1. 스토어에 들어가는 모양과 패널이 주고받는 모양이 같다 —
// 라이브러리(`TranslationDigest`)와 달리 경량 투영을 만들지 않는 이유는 규모다:
// 한 건이 최대 두 문장 스냅샷(약 500 B)이고 영상당 수십 건이라, 50건이 약 25 KB로
// 구조화 복제에 부담이 되지 않는다.

interface BookmarkBase {
  /** `crypto.randomUUID()`. 호출부가 만들어 넘긴다 — 이 모듈도 db도 난수를 읽지 않는다. */
  bookmarkId: string;
  /** 출처 행. 중복 판정에만 쓰고 렌더에는 쓰지 않는다 — 재번역으로 세그먼트가
   * 재분할되면 어긋날 수 있는 값이라, 화면에 보이는 텍스트는 아래 스냅샷이 낸다. */
  segmentId: string;
  /** 시크 앵커. 초 단위라 세그먼트가 재분할돼도 유효하다. */
  startSec: number;
  createdAt: string;
}

/**
 * 판별 유니온인 이유: 네 필드를 전부 nullable로 늘어놓으면 `kind: 'row'`인데
 * `sourceText`가 `null`인 레코드가 타입상 합법이 된다. 유니온이면 그 조합이
 * 컴파일 단계에서 불가능하고, `kind`로 좁힌 뒤에는 옵셔널 체이닝 없이 읽는다.
 */
export type Bookmark =
  // 행 통째 — 원문은 반드시 있고, 번역은 아직 없을 수 있다(미번역 세그먼트).
  | (BookmarkBase & { kind: 'row'; sourceText: string; translatedText: string | null })
  // 드래그 조각 — 사용자가 고른 텍스트 하나뿐. 원문/번역을 구분하지 않는다.
  | (BookmarkBase & { kind: 'excerpt'; excerpt: string });

/** `bookmarks` 스토어의 레코드. keyPath: 'videoId'. */
export interface BookmarkRecord {
  videoId: string;
  bookmarks: Bookmark[];
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`src/lib/db.test.ts`의 상단 import 블록에 다음을 더한다:

```ts
import type { Bookmark } from '~/types/bookmark';
```

그리고 `'./db'`에서 가져오는 목록에 `BOOKMARKS_STORE`, `getBookmarks`,
`addBookmark`, `deleteBookmark`를 더한다.

파일 끝에 다음을 추가한다:

```ts
function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    bookmarkId: 'bm-1',
    segmentId: 'zjkBMFhNj_g:3',
    startSec: 30,
    createdAt: '2026-08-02T00:00:00.000Z',
    kind: 'row',
    sourceText: 'source text 3',
    translatedText: '원문 3',
    ...overrides,
  } as Bookmark;
}

// v3까지만 만들어 두고 열어, 실제 3->4 onupgradeneeded 전이를 태운다.
// seedV1Database와 같은 관용 — 같은 버전으로 여는 no-op을 마이그레이션이라고
// 부르지 않기 위해서다.
function seedV3Database(rec: TranslationRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
      db.createObjectStore(TRANSLATIONS_STORE, { keyPath: 'videoId' });
      db.createObjectStore(SUMMARIES_STORE, { keyPath: 'videoId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(TRANSLATIONS_STORE, 'readwrite');
      tx.objectStore(TRANSLATIONS_STORE).put(rec);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    request.onerror = () => reject(request.error);
  });
}

describe('v3 -> v4 migration', () => {
  it('adds the bookmarks store without touching existing translations data', async () => {
    const seeded = makeRecord({ status: 'done' });
    await seedV3Database(seeded);

    // db.ts의 어떤 호출이든 DB_VERSION(4)로 열어 3->4 전이를 일으킨다.
    expect(await getTranslation(seeded.videoId)).toEqual(seeded);
    expect(await getBookmarks(seeded.videoId)).toEqual([]);
  });
});

describe('bookmarks', () => {
  it('returns an empty array for a video that has none', async () => {
    expect(await getBookmarks('zjkBMFhNj_g')).toEqual([]);
  });

  it('adds bookmarks and returns the updated list', async () => {
    const first = makeBookmark();
    expect(await addBookmark('zjkBMFhNj_g', first)).toEqual([first]);

    const second = makeBookmark({ bookmarkId: 'bm-2', segmentId: 'zjkBMFhNj_g:7', startSec: 70 });
    expect(await addBookmark('zjkBMFhNj_g', second)).toEqual([first, second]);
    expect(await getBookmarks('zjkBMFhNj_g')).toEqual([first, second]);
  });

  it('is idempotent on a repeated bookmarkId', async () => {
    const bookmark = makeBookmark();
    await addBookmark('zjkBMFhNj_g', bookmark);
    // 같은 메시지가 재전달돼도 두 번 들어가면 안 된다.
    expect(await addBookmark('zjkBMFhNj_g', bookmark)).toEqual([bookmark]);
  });

  it('keeps each video s bookmarks separate', async () => {
    await addBookmark('video-a', makeBookmark({ bookmarkId: 'a-1' }));
    await addBookmark('video-b', makeBookmark({ bookmarkId: 'b-1' }));

    expect(await getBookmarks('video-a')).toHaveLength(1);
    expect((await getBookmarks('video-b'))[0].bookmarkId).toBe('b-1');
  });

  it('stores an excerpt bookmark with its own shape', async () => {
    const excerpt = makeBookmark({
      bookmarkId: 'bm-x',
      kind: 'excerpt',
      excerpt: 'the key thing is the softmax',
      sourceText: undefined,
      translatedText: undefined,
    } as Partial<Bookmark>);
    const stored = (await addBookmark('zjkBMFhNj_g', excerpt))[0];
    expect(stored.kind).toBe('excerpt');
    if (stored.kind !== 'excerpt') throw new Error('expected an excerpt bookmark');
    expect(stored.excerpt).toBe('the key thing is the softmax');
  });

  it('deletes by bookmarkId and returns the rest', async () => {
    const first = makeBookmark();
    const second = makeBookmark({ bookmarkId: 'bm-2' });
    await addBookmark('zjkBMFhNj_g', first);
    await addBookmark('zjkBMFhNj_g', second);

    expect(await deleteBookmark('zjkBMFhNj_g', 'bm-1')).toEqual([second]);
  });

  it('treats an unknown bookmarkId as a no-op', async () => {
    const bookmark = makeBookmark();
    await addBookmark('zjkBMFhNj_g', bookmark);
    expect(await deleteBookmark('zjkBMFhNj_g', 'nope')).toEqual([bookmark]);
  });

  it('treats a delete on a video with no record as a no-op', async () => {
    expect(await deleteBookmark('never-seen', 'bm-1')).toEqual([]);
  });
});

describe('deleteVideoData cascade', () => {
  it('deletes bookmarks along with the translation and summary', async () => {
    const videoId = 'zjkBMFhNj_g';
    await putTranslation(makeRecord({ status: 'done' }));
    await putSummary(makeSummary());
    await addBookmark(videoId, makeBookmark());

    await deleteVideoData(videoId);

    expect(await getTranslation(videoId)).toBeNull();
    expect(await getSummary(videoId)).toBeNull();
    expect(await getBookmarks(videoId)).toEqual([]);
  });
});
```

> `makeSummary`는 `db.test.ts`에 이미 있다. 없다면 그 파일이 `putSummary` 테스트에서
> 쓰는 리터럴을 그대로 쓴다 — 새 헬퍼를 만들지 않는다.

- [ ] **Step 3: 테스트가 실패하는 것을 확인한다**

Run: `npx vitest run src/lib/db.test.ts`
Expected: FAIL — `BOOKMARKS_STORE`, `getBookmarks`, `addBookmark`,
`deleteBookmark`가 `./db`에 없어 import 단계에서 죽는다.

- [ ] **Step 4: db.ts에 스토어와 버전을 더한다**

`src/lib/db.ts`의 `DB_VERSION`을 `4`로 바꾸고, `SUMMARIES_STORE` 선언 아래에
추가한다:

```ts
// M3: 사용자가 고른 문장(spec 2026-08-02 §4.2). 영상당 레코드 하나에 배열로
// 담는다 — 북마크마다 레코드를 만들면 `videoId` 인덱스가 필요해지는데, 이 파일
// 서두의 판단("인덱스가 필요해지면 idb 패키지를 재검토")이 걸리는 선이다. 배열이면
// 인덱스가 필요 없고 나머지 세 스토어와 키 규칙도 같아진다.
export const BOOKMARKS_STORE = 'bookmarks';
```

`openDb`의 `onupgradeneeded` 안, `SUMMARIES_STORE` 가드 다음 줄에 추가한다:

```ts
      if (!db.objectStoreNames.contains(BOOKMARKS_STORE)) {
        db.createObjectStore(BOOKMARKS_STORE, { keyPath: 'videoId' });
      }
```

import 블록에 추가한다:

```ts
import type { Bookmark, BookmarkRecord } from '~/types/bookmark';
```

- [ ] **Step 5: 조회·추가·삭제를 구현한다**

`src/lib/db.ts`의 `deleteVideoData` **바로 위**에 추가한다:

```ts
export async function getBookmarks(videoId: string): Promise<Bookmark[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKMARKS_STORE, 'readonly');
    const request = tx.objectStore(BOOKMARKS_STORE).get(videoId);
    let result: Bookmark[] = [];
    request.onsuccess = () => {
      // 레코드 부재는 정상이다(그 영상에서 아직 아무것도 저장하지 않음) — 빈
      // 배열로 접는다. `null`을 돌려주면 모든 호출부가 같은 폴백을 반복해야 한다.
      result = (request.result as BookmarkRecord | undefined)?.bookmarks ?? [];
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// 추가와 삭제가 공유하는 read-modify-write. get -> put이 사이에 `await` 없이 한
// readwrite 트랜잭션 안에서 끝나므로, 같은 videoId에 대한 동시 호출이 stale read로
// 서로를 덮어쓸 수 없다 — `upsertBatch`가 세운 같은 관용이다.
async function mutateBookmarks(
  videoId: string,
  mutate: (current: Bookmark[]) => Bookmark[],
): Promise<Bookmark[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKMARKS_STORE, 'readwrite');
    const store = tx.objectStore(BOOKMARKS_STORE);
    const getRequest = store.get(videoId);
    let next: Bookmark[] = [];

    getRequest.onsuccess = () => {
      const existing = getRequest.result as BookmarkRecord | undefined;
      next = mutate(existing?.bookmarks ?? []);
      const updated: BookmarkRecord = { videoId, bookmarks: next };
      store.put(updated);
    };
    getRequest.onerror = () => {
      db.close();
      reject(getRequest.error);
    };

    tx.oncomplete = () => {
      db.close();
      resolve(next);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// 같은 bookmarkId를 두 번 넣지 않는다 — 메시지가 재전달돼도 목록이 불어나지
// 않게 하는 멱등성이다.
export function addBookmark(videoId: string, bookmark: Bookmark): Promise<Bookmark[]> {
  return mutateBookmarks(videoId, (current) =>
    current.some((existing) => existing.bookmarkId === bookmark.bookmarkId)
      ? current
      : [...current, bookmark],
  );
}

export function deleteBookmark(videoId: string, bookmarkId: string): Promise<Bookmark[]> {
  return mutateBookmarks(videoId, (current) =>
    current.filter((existing) => existing.bookmarkId !== bookmarkId),
  );
}
```

- [ ] **Step 6: 삭제 캐스케이드를 더한다**

`deleteVideoData`의 주석 첫 문단을 다음으로 바꾸고, 트랜잭션에 스토어를 더한다:

```ts
// 번역·요약·북마크를 한 트랜잭션으로 지운다. 원자성이 필요한 이유: 셋이 갈라지면
// 목록에서 사라진 영상의 요약이나 북마크가 영원히 고아로 남는다(목록의 기준
// 스토어가 `translations`이므로 다시 보이지 않는다).
```

```ts
    const tx = db.transaction([TRANSLATIONS_STORE, SUMMARIES_STORE, BOOKMARKS_STORE], 'readwrite');
    tx.objectStore(TRANSLATIONS_STORE).delete(videoId);
    tx.objectStore(SUMMARIES_STORE).delete(videoId);
    tx.objectStore(BOOKMARKS_STORE).delete(videoId);
```

- [ ] **Step 7: 테스트가 통과하는 것을 확인한다**

Run: `npx vitest run src/lib/db.test.ts && npx tsc --noEmit`
Expected: 전부 PASS, 타입 오류 없음

- [ ] **Step 8: 전체 테스트를 돌린다**

Run: `npx vitest run`
Expected: 24 files / 479 + 신규 테스트 전부 PASS

- [ ] **Step 9: 커밋**

```bash
git add src/types/bookmark.ts src/lib/db.ts src/lib/db.test.ts
git commit -m "Add a bookmarks store, one record per video holding an array"
```

---

### Task 2: 순수 함수

**Files:**
- Create: `src/lib/bookmarks.ts`
- Test: `src/lib/bookmarks.test.ts`

**Interfaces:**
- Consumes: `Bookmark` (`~/types/bookmark`), `TranscriptSegment` (`~/types/transcript`)
- Produces:
  - `sortBookmarks(bookmarks: readonly Bookmark[]): Bookmark[]`
  - `bookmarkedSegmentIds(bookmarks: readonly Bookmark[]): Set<string>`
  - `findRowBookmark(bookmarks: readonly Bookmark[], segmentId: string): Bookmark | null`
  - `createRowBookmark(segment: TranscriptSegment, bookmarkId: string, now: Date): Bookmark`
  - `createExcerptBookmark(segment: TranscriptSegment, text: string, bookmarkId: string, now: Date): Bookmark`
  - `normalizeSelection(raw: string | null | undefined): string | null`
  - `type RowMenuAction = 'save-row' | 'remove-row' | 'save-excerpt'`
  - `interface RowMenuItem { action: RowMenuAction; label: string }`
  - `rowMenuItems(input: { saved: boolean; selectionText: string | null }): RowMenuItem[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/bookmarks.test.ts` (신규):

```ts
import { describe, expect, it } from 'vitest';
import {
  bookmarkedSegmentIds,
  createExcerptBookmark,
  createRowBookmark,
  findRowBookmark,
  normalizeSelection,
  rowMenuItems,
  sortBookmarks,
} from './bookmarks';
import type { Bookmark } from '~/types/bookmark';
import type { TranscriptSegment } from '~/types/transcript';

function rowBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    bookmarkId: 'bm-1',
    segmentId: 'vid:3',
    startSec: 30,
    createdAt: '2026-08-02T00:00:00.000Z',
    kind: 'row',
    sourceText: 'source',
    translatedText: '번역',
    ...overrides,
  } as Bookmark;
}

function excerptBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    bookmarkId: 'bm-x',
    segmentId: 'vid:3',
    startSec: 30,
    createdAt: '2026-08-02T00:00:00.000Z',
    kind: 'excerpt',
    excerpt: '조각',
    ...overrides,
  } as Bookmark;
}

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    segmentId: 'vid:3',
    videoId: 'vid',
    index: 3,
    startSec: 30.4,
    endSec: 40,
    sourceText: 'the key thing is the softmax',
    translatedText: '핵심은 소프트맥스입니다',
    ...overrides,
  };
}

describe('sortBookmarks', () => {
  it('orders by startSec ascending, not by save order', () => {
    const late = rowBookmark({ bookmarkId: 'late', startSec: 300, createdAt: '2026-08-02T00:00:00.000Z' });
    const early = rowBookmark({ bookmarkId: 'early', startSec: 12, createdAt: '2026-08-02T01:00:00.000Z' });

    expect(sortBookmarks([late, early]).map((b) => b.bookmarkId)).toEqual(['early', 'late']);
  });

  it('breaks a startSec tie by createdAt ascending', () => {
    const second = excerptBookmark({ bookmarkId: 'second', createdAt: '2026-08-02T02:00:00.000Z' });
    const first = excerptBookmark({ bookmarkId: 'first', createdAt: '2026-08-02T01:00:00.000Z' });

    expect(sortBookmarks([second, first]).map((b) => b.bookmarkId)).toEqual(['first', 'second']);
  });

  it('does not mutate its input', () => {
    const input = [rowBookmark({ startSec: 90 }), rowBookmark({ bookmarkId: 'bm-2', startSec: 10 })];
    sortBookmarks(input);
    expect(input[0].startSec).toBe(90);
  });
});

describe('bookmarkedSegmentIds', () => {
  it('collects only row bookmarks', () => {
    // 조각만 저장한 행의 ☆는 비어 있어야 한다 — 그 행을 통째로는 저장하지 않았다.
    const ids = bookmarkedSegmentIds([
      rowBookmark({ segmentId: 'vid:1' }),
      excerptBookmark({ segmentId: 'vid:9' }),
    ]);
    expect([...ids]).toEqual(['vid:1']);
  });

  it('is empty for an empty list', () => {
    expect(bookmarkedSegmentIds([]).size).toBe(0);
  });
});

describe('findRowBookmark', () => {
  it('finds the row bookmark for a segment', () => {
    const row = rowBookmark({ segmentId: 'vid:5' });
    expect(findRowBookmark([excerptBookmark(), row], 'vid:5')).toBe(row);
  });

  it('ignores an excerpt on the same segment', () => {
    expect(findRowBookmark([excerptBookmark({ segmentId: 'vid:5' })], 'vid:5')).toBeNull();
  });

  it('returns null when the segment has nothing', () => {
    expect(findRowBookmark([rowBookmark()], 'vid:99')).toBeNull();
  });
});

describe('createRowBookmark', () => {
  it('snapshots both texts and floors startSec to whole seconds', () => {
    const created = createRowBookmark(segment(), 'bm-new', new Date('2026-08-02T03:04:05.000Z'));

    expect(created).toEqual({
      bookmarkId: 'bm-new',
      segmentId: 'vid:3',
      // 30.4 -> 30. 시크와 내보내기 링크가 같은 정수를 쓰게 여기서 한 번만 자른다.
      startSec: 30,
      createdAt: '2026-08-02T03:04:05.000Z',
      kind: 'row',
      sourceText: 'the key thing is the softmax',
      translatedText: '핵심은 소프트맥스입니다',
    });
  });

  it('keeps translatedText null for a segment that is not translated yet', () => {
    const created = createRowBookmark(segment({ translatedText: null }), 'bm-new', new Date(0));
    if (created.kind !== 'row') throw new Error('expected a row bookmark');
    expect(created.translatedText).toBeNull();
    expect(created.sourceText).toBe('the key thing is the softmax');
  });
});

describe('createExcerptBookmark', () => {
  it('stores the selected text and the row s timestamp', () => {
    const created = createExcerptBookmark(segment(), '  the softmax  ', 'bm-x', new Date('2026-08-02T00:00:00.000Z'));

    expect(created).toEqual({
      bookmarkId: 'bm-x',
      segmentId: 'vid:3',
      startSec: 30,
      createdAt: '2026-08-02T00:00:00.000Z',
      kind: 'excerpt',
      // 앞뒤 공백은 저장 전에 털어낸다 — 드래그 선택은 거의 항상 공백을 물고 온다.
      excerpt: 'the softmax',
    });
  });
});

describe('normalizeSelection', () => {
  it('returns null for nothing selected', () => {
    expect(normalizeSelection(null)).toBeNull();
    expect(normalizeSelection(undefined)).toBeNull();
  });

  it('returns null for whitespace-only selection', () => {
    // 행을 그냥 클릭해도 브라우저가 빈 Selection을 남긴다 — 그걸 조각으로 보면 안 된다.
    expect(normalizeSelection('   \n  ')).toBeNull();
  });

  it('trims a real selection', () => {
    expect(normalizeSelection(' the softmax ')).toBe('the softmax');
  });
});

describe('rowMenuItems', () => {
  it('offers saving when the row is not saved and nothing is selected', () => {
    expect(rowMenuItems({ saved: false, selectionText: null })).toEqual([
      { action: 'save-row', label: '이 문장 기억하기' },
    ]);
  });

  it('offers removing when the row is already saved', () => {
    expect(rowMenuItems({ saved: true, selectionText: null })).toEqual([
      { action: 'remove-row', label: '기억 해제' },
    ]);
  });

  it('adds the excerpt item when there is a selection', () => {
    expect(rowMenuItems({ saved: false, selectionText: 'the softmax' })).toEqual([
      { action: 'save-row', label: '이 문장 기억하기' },
      { action: 'save-excerpt', label: '선택한 부분만 기억하기' },
    ]);
  });

  it('offers both removing and excerpting on a saved row with a selection', () => {
    expect(rowMenuItems({ saved: true, selectionText: 'the softmax' })).toEqual([
      { action: 'remove-row', label: '기억 해제' },
      { action: 'save-excerpt', label: '선택한 부분만 기억하기' },
    ]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `npx vitest run src/lib/bookmarks.test.ts`
Expected: FAIL — `./bookmarks` 모듈이 없다

- [ ] **Step 3: 순수 함수를 구현한다**

`src/lib/bookmarks.ts` (신규):

```ts
import type { Bookmark } from '~/types/bookmark';
import type { TranscriptSegment } from '~/types/transcript';

/**
 * 북마크에 대한 모든 판단은 여기 모인다 — 이 저장소에는 컴포넌트 렌더 테스트
 * 하니스가 없으므로(`library.ts`/`export-doc.ts`와 같은 규율), 컴포넌트는 이
 * 함수들을 호출만 하고 스스로 결정하지 않는다.
 *
 * 시계와 난수를 읽지 않는다 — `bookmarkId`와 `now`는 호출부가 만들어 넘긴다.
 */

/**
 * 영상 흐름 순(저장 순이 아니라). 복습은 시간축을 따라가는 것이 자연스럽고, 한
 * 행에서 조각을 여러 개 저장하면 저장 순은 오히려 뒤섞인다. 같은 `startSec`이
 * 여럿이면(같은 행의 조각들) `createdAt`으로 가른다.
 */
export function sortBookmarks(bookmarks: readonly Bookmark[]): Bookmark[] {
  return [...bookmarks].sort((a, b) =>
    a.startSec !== b.startSec ? a.startSec - b.startSec : a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * Transcript에서 ★로 채워질 행들. `kind === 'excerpt'`는 포함하지 않는다 —
 * 조각만 저장한 행은 "통째로는 아직 저장하지 않은" 상태가 정확하다.
 */
export function bookmarkedSegmentIds(bookmarks: readonly Bookmark[]): Set<string> {
  const ids = new Set<string>();
  for (const bookmark of bookmarks) {
    if (bookmark.kind === 'row') ids.add(bookmark.segmentId);
  }
  return ids;
}

/** 토글의 해제 쪽이 지울 대상. 조각은 중복 판정을 하지 않으므로 걸리지 않는다. */
export function findRowBookmark(
  bookmarks: readonly Bookmark[],
  segmentId: string,
): Bookmark | null {
  return bookmarks.find((b) => b.kind === 'row' && b.segmentId === segmentId) ?? null;
}

export function createRowBookmark(
  segment: TranscriptSegment,
  bookmarkId: string,
  now: Date,
): Bookmark {
  return {
    bookmarkId,
    segmentId: segment.segmentId,
    // 초 단위로 자른다 — 시크와 내보내기의 `?t=` 링크가 같은 값을 쓰게 한 곳에서만
    // 자르는 것이 두 곳에서 각자 Math.floor하는 것보다 어긋날 여지가 없다.
    startSec: Math.floor(segment.startSec),
    createdAt: now.toISOString(),
    kind: 'row',
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
  };
}

export function createExcerptBookmark(
  segment: TranscriptSegment,
  text: string,
  bookmarkId: string,
  now: Date,
): Bookmark {
  return {
    bookmarkId,
    segmentId: segment.segmentId,
    startSec: Math.floor(segment.startSec),
    createdAt: now.toISOString(),
    kind: 'excerpt',
    excerpt: text.trim(),
  };
}

/**
 * 행을 그냥 클릭하기만 해도 브라우저는 빈 Selection을 남긴다 — 공백뿐인 선택을
 * 조각으로 취급하면 우클릭 메뉴에 쓸모없는 항목이 계속 뜬다.
 */
export function normalizeSelection(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export type RowMenuAction = 'save-row' | 'remove-row' | 'save-excerpt';

export interface RowMenuItem {
  action: RowMenuAction;
  label: string;
}

export function rowMenuItems({
  saved,
  selectionText,
}: {
  saved: boolean;
  selectionText: string | null;
}): RowMenuItem[] {
  const items: RowMenuItem[] = [
    saved
      ? { action: 'remove-row', label: '기억 해제' }
      : { action: 'save-row', label: '이 문장 기억하기' },
  ];
  if (selectionText !== null) {
    items.push({ action: 'save-excerpt', label: '선택한 부분만 기억하기' });
  }
  return items;
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `npx vitest run src/lib/bookmarks.test.ts && npx tsc --noEmit`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/lib/bookmarks.ts src/lib/bookmarks.test.ts
git commit -m "Decide sort, dedupe, and menu items for bookmarks in pure functions"
```

---

### Task 3: 메시지와 background 핸들러

**Files:**
- Modify: `src/types/message.ts`
- Modify: `entrypoints/background.ts`
- Test: `src/background.test.ts`

**Interfaces:**
- Consumes: `getBookmarks`/`addBookmark`/`deleteBookmark` (Task 1), `Bookmark` (Task 1)
- Produces: `GET_BOOKMARKS` / `ADD_BOOKMARK` / `DELETE_BOOKMARK` 메시지와
  `{ ok: true; bookmarks: Bookmark[] } | { ok: false; error: string }` 응답

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/background.test.ts`의 import에 추가한다:

```ts
import type { Bookmark } from '~/types/bookmark';
```

파일 끝에 추가한다:

```ts
function testBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    bookmarkId: 'bm-1',
    segmentId: 'vid:3',
    startSec: 30,
    createdAt: '2026-08-02T00:00:00.000Z',
    kind: 'row',
    sourceText: 'source',
    translatedText: '번역',
    ...overrides,
  } as Bookmark;
}

describe('bookmark messages', () => {
  it('GET_BOOKMARKS returns an empty list for a video with none', async () => {
    const res = await handle({ type: 'GET_BOOKMARKS', payload: { videoId: 'vid' } });
    expect(res).toEqual({ ok: true, bookmarks: [] });
  });

  it('ADD_BOOKMARK persists and returns the updated list', async () => {
    const bookmark = testBookmark();
    const added = await handle({ type: 'ADD_BOOKMARK', payload: { videoId: 'vid', bookmark } });
    expect(added).toEqual({ ok: true, bookmarks: [bookmark] });

    // 쓰기 응답만 믿지 않는다 — 실제로 저장됐는지 별도 조회로 확인한다.
    const fetched = await handle({ type: 'GET_BOOKMARKS', payload: { videoId: 'vid' } });
    expect(fetched).toEqual({ ok: true, bookmarks: [bookmark] });
  });

  it('DELETE_BOOKMARK removes one and returns the rest', async () => {
    const first = testBookmark();
    const second = testBookmark({ bookmarkId: 'bm-2', startSec: 90 });
    await handle({ type: 'ADD_BOOKMARK', payload: { videoId: 'vid', bookmark: first } });
    await handle({ type: 'ADD_BOOKMARK', payload: { videoId: 'vid', bookmark: second } });

    const res = await handle({
      type: 'DELETE_BOOKMARK',
      payload: { videoId: 'vid', bookmarkId: 'bm-1' },
    });
    expect(res).toEqual({ ok: true, bookmarks: [second] });
  });

  it('reports a read failure as ok:false instead of an empty list', async () => {
    // 빈 목록으로 접으면 패널이 "아직 없어요"를 띄우는데, 진실은 "물어보지
    // 못했다"이다 — GET_LIBRARY가 Important #2에서 배운 것과 같은 구분이다.
    vi.mocked(getBookmarks).mockRejectedValueOnce(new Error('db is gone'));

    const res = await handle({ type: 'GET_BOOKMARKS', payload: { videoId: 'vid' } });
    expect(res).toEqual({ ok: false, error: 'db is gone' });
  });
});
```

`vi.mock('~/lib/db', ...)` 블록의 반환 객체에 `getBookmarks: vi.fn(actual.getBookmarks)`를
더하고, 파일 상단의 `'~/lib/db'` import에 `getBookmarks`를 더한다.

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `npx vitest run src/background.test.ts`
Expected: FAIL — `GET_BOOKMARKS` 등이 `AppMessage`에 없어 타입/런타임 모두 깨진다

- [ ] **Step 3: 메시지 타입을 더한다**

`src/types/message.ts`의 import에 추가한다:

```ts
import type { Bookmark } from '~/types/bookmark';
```

`AppMessage` 유니온의 마지막 항목(`DELETE_LIBRARY_ENTRY`)의 세미콜론을 `|`로 바꾸고
이어서 추가한다:

```ts
  | { type: 'DELETE_LIBRARY_ENTRY'; payload: { videoId: string } }
  // panel -> background: 한 영상의 기억한 문장(spec 2026-08-02 §4.3). 조회는
  // 투영 없이 전체를 그대로 보낸다 — 영상당 수십 건, 한 건 약 500 B라 구조화
  // 복제에 부담이 없다.
  | { type: 'GET_BOOKMARKS'; payload: { videoId: string } }
  // 쓰기 둘 다 갱신된 전체 목록으로 답한다. 패널이 쓰기 후 재조회할 필요가 없고,
  // 낙관적 업데이트를 롤백하는 상태 기계도 생기지 않는다.
  //
  // `bookmark`를 패널이 완성해서 보내는 이유: `bookmarkId`(crypto.randomUUID)와
  // `createdAt`을 background가 채우면, 응답이 오기 전까지 패널이 그 항목을 그릴
  // 수 없다. 같은 `bookmarkId`의 재전달은 db 레이어가 멱등으로 흡수한다.
  | { type: 'ADD_BOOKMARK'; payload: { videoId: string; bookmark: Bookmark } }
  | { type: 'DELETE_BOOKMARK'; payload: { videoId: string; bookmarkId: string } };
```

`AppResponseMap`에 세 줄을 더한다 (`DELETE_LIBRARY_ENTRY` 항목 아래):

```ts
  GET_BOOKMARKS: { ok: true; bookmarks: Bookmark[] } | { ok: false; error: string };
  ADD_BOOKMARK: { ok: true; bookmarks: Bookmark[] } | { ok: false; error: string };
  DELETE_BOOKMARK: { ok: true; bookmarks: Bookmark[] } | { ok: false; error: string };
```

- [ ] **Step 4: background 핸들러를 더한다**

`entrypoints/background.ts`의 `'~/lib/db'` import 목록에 `getBookmarks`,
`addBookmark`, `deleteBookmark`를 더한다.

`handle`의 switch에서 `case 'DELETE_LIBRARY_ENTRY'` 블록 **다음**에 추가한다:

```ts
    case 'GET_BOOKMARKS': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_BOOKMARKS' }>;
      const bookmarks = await getBookmarks(payload.videoId);
      return { ok: true, bookmarks } as AppResponseMap[T];
    }
    case 'ADD_BOOKMARK': {
      const { payload } = msg as Extract<AppMessage, { type: 'ADD_BOOKMARK' }>;
      const bookmarks = await addBookmark(payload.videoId, payload.bookmark);
      return { ok: true, bookmarks } as AppResponseMap[T];
    }
    case 'DELETE_BOOKMARK': {
      const { payload } = msg as Extract<AppMessage, { type: 'DELETE_BOOKMARK' }>;
      const bookmarks = await deleteBookmark(payload.videoId, payload.bookmarkId);
      return { ok: true, bookmarks } as AppResponseMap[T];
    }
```

> `GET_LIBRARY`처럼 내부 try/catch를 두지 않는다. 여기서는 바깥
> `onMessage`/`errorResponseFor` 래퍼가 이미 `{ ok: false, error }`라는 **같은
> 모양**으로 접어 주기 때문이다 — `GET_LIBRARY`가 로컬 catch를 둔 이유는 그 응답이
> `{ ok: true, entries }`라서 폴백 모양이 달라서였다.

- [ ] **Step 5: errorResponseFor를 exhaustive하게 유지한다**

`errorResponseFor`의 switch에 세 분기를 더한다 (`DELETE_LIBRARY_ENTRY` 근처):

```ts
    case 'GET_BOOKMARKS':
    case 'ADD_BOOKMARK':
    case 'DELETE_BOOKMARK':
      return { ok: false, error: message };
```

- [ ] **Step 6: 테스트가 통과하는 것을 확인한다**

Run: `npx vitest run src/background.test.ts && npx tsc --noEmit`
Expected: 전부 PASS. 타입 오류가 있다면 `errorResponseFor`의 exhaustiveness나
`AppResponseMap` 누락이다.

- [ ] **Step 7: 전체 테스트를 돌린다**

Run: `npx vitest run`
Expected: 전부 PASS

- [ ] **Step 8: 커밋**

```bash
git add src/types/message.ts entrypoints/background.ts src/background.test.ts
git commit -m "Read, add, and delete bookmarks over three background messages"
```

---

### Task 4: 훅과 Transcript 행의 ☆

**Files:**
- Create: `src/features/bookmarks/useBookmarks.ts`
- Modify: `src/components/TranscriptList.tsx`

**Interfaces:**
- Consumes: `sendMessage` (`~/lib/messaging`), Task 2의 순수 함수 전부, Task 3의 메시지
- Produces:
  - `useBookmarks(videoId: string | null): BookmarksState`
  - `BookmarksState = { bookmarks: Bookmark[]; loadFailed: boolean; savedSegmentIds: Set<string>;
    toggleRow(segment): void; saveExcerpt(segment, text): void; remove(bookmarkId): void; reload(): void }`
  - `TranscriptListProps`에 `savedSegmentIds?`, `onToggleRow?`, `onSaveExcerpt?` 추가

> 이 태스크에는 단위 테스트가 없다 — 훅과 컴포넌트에는 렌더 하니스가 없고, 판단
> 로직은 이미 Task 2가 전부 덮었다. 검증은 `tsc` + Step 6의 실제 크롬 확인이다.

- [ ] **Step 1: 훅을 만든다**

`src/features/bookmarks/useBookmarks.ts` (신규):

```ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  bookmarkedSegmentIds,
  createExcerptBookmark,
  createRowBookmark,
  findRowBookmark,
  sortBookmarks,
} from '~/lib/bookmarks';
import { sendMessage } from '~/lib/messaging';
import type { Bookmark } from '~/types/bookmark';
import type { TranscriptSegment } from '~/types/transcript';

export interface BookmarksState {
  /** 항상 `startSec` 오름차순. 소비자가 다시 정렬하지 않는다. */
  bookmarks: Bookmark[];
  /** 조회 자체가 실패했다 — "아직 없음"(빈 배열)과 구분해야 재시도를 보여줄 수 있다. */
  loadFailed: boolean;
  savedSegmentIds: Set<string>;
  toggleRow: (segment: TranscriptSegment) => void;
  saveExcerpt: (segment: TranscriptSegment, text: string) => void;
  remove: (bookmarkId: string) => void;
  reload: () => void;
}

/**
 * 한 영상의 북마크를 들고 있는 단일 소스. Transcript의 ★ 표시, Notes 탭 목록,
 * 탭 뱃지 숫자가 전부 이 배열에서 파생된다 — 세 곳이 각자 조회하면 저장 직후
 * 서로 다른 개수를 보여줄 수 있다.
 *
 * 쓰기는 응답이 돌려주는 전체 목록으로 상태를 갈아끼운다(낙관적 업데이트 없음).
 * 사용자가 체감하는 지연은 확장 내부 메시지 왕복 한 번이고, 그 대가로 롤백해야
 * 하는 중간 상태가 아예 생기지 않는다.
 */
export function useBookmarks(videoId: string | null): BookmarksState {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (videoId === null) {
      setBookmarks([]);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setLoadFailed(false);
    void sendMessage({ type: 'GET_BOOKMARKS', payload: { videoId } })
      .then((res) => {
        if (cancelled) return;
        // 영상을 바꾸는 중 늦게 도착한 응답이 새 영상의 목록을 덮지 않도록
        // cancelled 플래그로 버린다.
        if (res.ok) setBookmarks(sortBookmarks(res.bookmarks));
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, reloadToken]);

  const applyWrite = useCallback(
    (send: () => Promise<{ ok: true; bookmarks: Bookmark[] } | { ok: false; error: string }>) => {
      void send()
        .then((res) => {
          if (res.ok) setBookmarks(sortBookmarks(res.bookmarks));
        })
        // 확장 컨텍스트 무효화 등으로 거부되면 목록을 그대로 둔다 — ★가 켜지지
        // 않는 것이 사용자에게 보이는 실패 신호다.
        .catch(() => {});
    },
    [],
  );

  const toggleRow = useCallback(
    (segment: TranscriptSegment) => {
      if (videoId === null) return;
      const existing = findRowBookmark(bookmarks, segment.segmentId);
      if (existing) {
        applyWrite(() =>
          sendMessage({
            type: 'DELETE_BOOKMARK',
            payload: { videoId, bookmarkId: existing.bookmarkId },
          }),
        );
        return;
      }
      const bookmark = createRowBookmark(segment, crypto.randomUUID(), new Date());
      applyWrite(() => sendMessage({ type: 'ADD_BOOKMARK', payload: { videoId, bookmark } }));
    },
    [applyWrite, bookmarks, videoId],
  );

  const saveExcerpt = useCallback(
    (segment: TranscriptSegment, text: string) => {
      if (videoId === null) return;
      const bookmark = createExcerptBookmark(segment, text, crypto.randomUUID(), new Date());
      applyWrite(() => sendMessage({ type: 'ADD_BOOKMARK', payload: { videoId, bookmark } }));
    },
    [applyWrite, videoId],
  );

  const remove = useCallback(
    (bookmarkId: string) => {
      if (videoId === null) return;
      applyWrite(() => sendMessage({ type: 'DELETE_BOOKMARK', payload: { videoId, bookmarkId } }));
    },
    [applyWrite, videoId],
  );

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const savedSegmentIds = useMemo(() => bookmarkedSegmentIds(bookmarks), [bookmarks]);

  return { bookmarks, loadFailed, savedSegmentIds, toggleRow, saveExcerpt, remove, reload };
}
```

- [ ] **Step 2: TranscriptList의 props를 넓힌다**

`src/components/TranscriptList.tsx`의 `TranscriptListProps`에 세 줄을 더한다:

```ts
  /** 통째로 저장된 행의 segmentId 집합 (spec 2026-08-02 §6.2 — 조각은 포함되지 않는다). */
  savedSegmentIds?: ReadonlySet<string>;
  /** 행 통째 저장/해제. **이 prop이 없으면 ☆도 우클릭도 렌더하지 않는다** —
   * `failed` 영상 분기가 그 경로를 쓴다(spec §8). */
  onToggleRow?: (segment: TranscriptSegment) => void;
  /** 행 안에서 드래그한 텍스트를 조각으로 저장. Task 5에서 배선된다. */
  onSaveExcerpt?: (segment: TranscriptSegment, text: string) => void;
```

- [ ] **Step 3: 행을 셋으로 분해하고 ☆를 단다**

`TranscriptList`의 시그니처를 바꾼다:

```tsx
export function TranscriptList({
  segments,
  displayMode = 'both',
  activeIndex = null,
  onSeekRow,
  savedSegmentIds,
  onToggleRow,
  onSaveExcerpt,
}: TranscriptListProps) {
```

`segments.map` 안의 반환 JSX를 통째로 다음으로 교체한다. **바뀐 점은 셋뿐이다**:
바깥 `div`가 `role="button"`을 잃고 순수 컨테이너가 되었고, 시크 클릭 영역이 안쪽
`div`로 내려갔으며, 그 오른쪽에 ☆ 버튼이 붙었다. `rowRefs`와 active 배경은 바깥
컨테이너에 남는다 — `scrollIntoView`의 대상이 행 전체여야 하기 때문이다.

```tsx
        const texts = visibleTexts(segment, displayMode);
        const active = i === activeIndex;
        const interactive = onSeekRow !== undefined;
        const bookmarkable = onToggleRow !== undefined;
        const saved = savedSegmentIds?.has(segment.segmentId) ?? false;
        return (
          <div
            key={segment.segmentId}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            className={`group flex items-start gap-1 pr-2 ${
              active ? 'bg-neutral-100 dark:bg-neutral-800/60' : ''
            }`}
          >
            <div
              {...(interactive
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: () => onSeekRow(segment),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSeekRow(segment);
                      }
                    },
                  }
                : {})}
              className={`flex min-w-0 flex-1 gap-3 px-4 py-3 ${
                interactive ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900' : ''
              }`}
            >
              <span className="w-12 flex-none text-right font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
                {formatTimestamp(segment.startSec)}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                {texts.kind === 'dual' ? (
                  <>
                    <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                      {texts.secondaryText}
                    </span>
                    <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                      {texts.primaryText}
                    </span>
                  </>
                ) : texts.kind === 'secondary-only' ? (
                  <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {texts.text}
                  </span>
                ) : (
                  <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                    {texts.text}
                  </span>
                )}
              </div>
            </div>

            {bookmarkable && (
              <button
                type="button"
                onClick={(e) => {
                  // 이 클릭이 위로 새면 행의 시크가 함께 발동한다.
                  e.stopPropagation();
                  onToggleRow(segment);
                }}
                aria-label={saved ? '기억 해제' : '이 문장 기억하기'}
                aria-pressed={saved}
                // 저장된 행은 호버와 무관하게 계속 보인다 — 어느 행을 이미
                // 저장했는지가 Transcript에서 바로 읽혀야 한다. focus-visible을
                // 함께 거는 이유는 키보드 탐색으로도 닿을 수 있어야 해서다.
                className={`mt-3 shrink-0 rounded p-1 transition-opacity hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  saved
                    ? 'text-neutral-800 opacity-100 dark:text-neutral-200'
                    : 'text-neutral-400 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 dark:text-neutral-500'
                }`}
              >
                <StarIcon filled={saved} />
              </button>
            )}
          </div>
        );
```

파일 끝에 아이콘을 더한다:

```tsx
/** `LibraryView`의 `TrashIcon`과 같은 방식의 인라인 SVG — 아이콘 라이브러리를 추가하지 않는다. */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z" />
    </svg>
  );
}
```

- [ ] **Step 4: App.tsx에서 두 TranscriptList 중 done 쪽에만 배선한다**

`entrypoints/sidepanel/App.tsx`의 `ReadyBody` 안, `const playback = usePlaybackSync(...)`
아래에 추가한다:

```tsx
  // spec §8 — `failed` 영상에는 북마크 진입점을 두지 않는다. `showSummaryTab`이
  // 곧 그 게이트다(= showTranscriptList && status === 'done'). 훅 자체는 항상
  // 호출한다 — 조건부 호출은 rules-of-hooks 위반이다.
  const bookmarks = useBookmarks(videoId);
```

import를 더한다:

```tsx
import { useBookmarks } from '~/features/bookmarks/useBookmarks';
```

`showSummaryTab === true` 쪽 분기의 `<TranscriptList ... />`(현재 768행 근처)에만
두 prop을 더한다. **`showSummaryTab === false` 쪽(801행 근처)은 손대지 않는다.**

```tsx
                  <TranscriptList
                    segments={record.segments}
                    displayMode={displayMode}
                    activeIndex={activeIndex}
                    onSeekRow={(segment) => playback.seek(segment.startSec)}
                    savedSegmentIds={bookmarks.savedSegmentIds}
                    onToggleRow={bookmarks.toggleRow}
                    onSaveExcerpt={bookmarks.saveExcerpt}
                  />
```

> `onSaveExcerpt`는 이 태스크의 `TranscriptList`가 아직 쓰지 않는다(선택적 prop이라
> 무해하다). Task 5가 우클릭 메뉴를 붙이는 순간 바로 동작하도록 여기서 미리
> 넘긴다 — 그러지 않으면 Task 5 종료 시점에 조각 저장 메뉴가 아무 일도 하지 않는
> 상태로 남는다.

- [ ] **Step 5: 타입과 테스트를 확인한다**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 타입 오류 없음, 479개 + 지금까지의 신규 테스트 전부 PASS

- [ ] **Step 6: 실제 크롬에서 확인한다**

`pnpm dev`로 확장을 띄우고 (서비스워커를 갈아끼울 때는 `loadUnpacked`가 아니라
`chrome.runtime.reload()`를 쓴다), 번역이 완료된 영상에서:

1. Transcript 행에 마우스를 올리면 오른쪽에 ☆가 나타난다
2. ☆를 누르면 ★로 채워지고, **영상이 그 시점으로 이동하지 않는다** (stopPropagation)
3. 마우스를 치워도 ★는 계속 보인다
4. ★를 다시 누르면 ☆로 돌아간다
5. DevTools → Application → IndexedDB → `youtube-caption-translator` → `bookmarks`에
   레코드가 있고 `bookmarks` 배열이 늘었다 줄었다 한다
6. 실패한 영상(번역 실패 상태)의 Transcript에는 ☆가 **없다**

- [ ] **Step 7: 커밋**

```bash
git add src/features/bookmarks/useBookmarks.ts src/components/TranscriptList.tsx entrypoints/sidepanel/App.tsx
git commit -m "Let a transcript row be remembered with a hover star"
```

---

### Task 5: 우클릭 메뉴

**Files:**
- Create: `src/components/RowContextMenu.tsx`
- Modify: `src/components/TranscriptList.tsx`

**Interfaces:**
- Consumes: `rowMenuItems`, `normalizeSelection`, `RowMenuItem` (Task 2);
  `onToggleRow`/`onSaveExcerpt` props (Task 4)
- Produces: `RowContextMenu` 컴포넌트

- [ ] **Step 1: 메뉴 컴포넌트를 만든다**

`src/components/RowContextMenu.tsx` (신규):

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RowMenuItem } from '~/lib/bookmarks';

/**
 * Transcript 행의 우클릭 메뉴. `chrome.contextMenus`를 쓰지 않는 이유는 권한이다 —
 * 이 확장의 permissions는 `['storage', 'sidePanel']` 둘뿐이고, 그 선을 문맥 메뉴
 * 하나 때문에 넘기지 않는다.
 *
 * 열고 닫는 규칙(바깥 pointerdown, Escape, 열릴 때 첫 항목 포커스)은
 * `DownloadMenu`가 이미 확립한 것을 그대로 따른다.
 */
export function RowContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  items: RowMenuItem[];
  onSelect: (item: RowMenuItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 실제 크기를 재기 전에는 그리지 않는다 — 클릭 좌표에 한 번 그렸다가 뒤집으면
  // 메뉴가 눈에 띄게 튄다.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    // 패널이 400px로 좁아서 오른쪽 넘침은 예외가 아니라 기본이다. 넘치면 클릭
    // 좌표의 왼쪽으로 펼친다.
    const left = x + width > window.innerWidth - margin ? Math.max(margin, x - width) : x;
    const top = y + height > window.innerHeight - margin ? Math.max(margin, y - height) : y;
    setPlacement({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        left: placement?.left ?? x,
        top: placement?.top ?? y,
        visibility: placement === null ? 'hidden' : 'visible',
      }}
      className="z-20 min-w-[10rem] overflow-hidden rounded-[7px] border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          onClick={() => onSelect(item)}
          className="block w-full px-3 py-2 text-left text-[12px] text-neutral-800 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-900"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: TranscriptList에 우클릭을 배선한다**

`src/components/TranscriptList.tsx`의 import에 더한다:

```tsx
import { normalizeSelection, rowMenuItems } from '~/lib/bookmarks';
import { RowContextMenu } from '~/components/RowContextMenu';
```

`TranscriptList` 본문 상단(`programmaticUntilRef` 선언 아래)에 상태를 더한다:

```tsx
  // 열려 있는 우클릭 메뉴. 한 번에 하나만 뜬다 — 다른 행을 우클릭하면 이전 것이
  // 교체된다. 선택 텍스트는 우클릭 순간에 얼어붙힌다: 메뉴 항목을 클릭하는
  // 시점에는 브라우저가 Selection을 이미 지웠을 수 있다.
  const [menu, setMenu] = useState<{
    segment: TranscriptSegment;
    x: number;
    y: number;
    selectionText: string | null;
  } | null>(null);
```

`useState`를 React import에 더한다: `import { useEffect, useRef, useState } from 'react';`

바깥 컨테이너 `div`(Task 4에서 만든 `group flex ...` div)에 `onContextMenu`를 더한다:

```tsx
            {...(bookmarkable
              ? {
                  onContextMenu: (e: React.MouseEvent) => {
                    e.preventDefault();
                    const selection = window.getSelection();
                    // 선택이 이 행 안에 있을 때만 조각 후보로 본다 — 다른 행에서
                    // 드래그해 둔 선택이 이 행의 메뉴에 딸려 오면 안 된다.
                    const node = selection?.anchorNode ?? null;
                    const withinRow =
                      node !== null && rowRefs.current[i]?.contains(node) === true;
                    setMenu({
                      segment,
                      x: e.clientX,
                      y: e.clientY,
                      selectionText: withinRow
                        ? normalizeSelection(selection?.toString())
                        : null,
                    });
                  },
                }
              : {})}
```

리스트 최상위 `div`의 닫는 태그 **직전**에 메뉴를 렌더한다:

```tsx
      {menu !== null && onToggleRow !== undefined && (
        <RowContextMenu
          x={menu.x}
          y={menu.y}
          items={rowMenuItems({
            saved: savedSegmentIds?.has(menu.segment.segmentId) ?? false,
            selectionText: menu.selectionText,
          })}
          onSelect={(item) => {
            if (item.action === 'save-excerpt') {
              if (menu.selectionText !== null) onSaveExcerpt?.(menu.segment, menu.selectionText);
            } else {
              // save-row와 remove-row는 같은 토글이다 — 어느 쪽 라벨이 떴는지는
              // rowMenuItems가 이미 saved로 결정했고, toggleRow가 같은 판정을
              // 다시 한다(findRowBookmark).
              onToggleRow(menu.segment);
            }
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
```

- [ ] **Step 3: 타입과 테스트를 확인한다**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 타입 오류 없음, 전부 PASS

- [ ] **Step 4: 실제 크롬에서 확인한다**

1. 행을 우클릭하면 **브라우저 기본 메뉴가 아니라** 자체 메뉴가 뜬다
2. 저장 안 된 행이면 `이 문장 기억하기`, 저장된 행이면 `기억 해제`
3. 행 안에서 텍스트를 드래그한 뒤 우클릭하면 `선택한 부분만 기억하기`가 하나 더 뜬다
4. 패널 오른쪽 끝 가까이에서 우클릭해도 메뉴가 잘리지 않고 왼쪽으로 펼쳐진다
5. Escape / 바깥 클릭으로 닫힌다
6. 조각을 저장해도 그 행의 ☆는 **비어 있는 채로 남는다** (spec §6.2)
7. 실패한 영상의 Transcript에서는 우클릭 시 브라우저 기본 메뉴가 뜬다

- [ ] **Step 5: 커밋**

```bash
git add src/components/RowContextMenu.tsx src/components/TranscriptList.tsx
git commit -m "Offer remembering a row or just the selected part on right-click"
```

---

### Task 6: Notes 탭 본문

**Files:**
- Create: `src/components/NotesPanel.tsx`
- Modify: `src/components/TranscriptList.tsx` (`visibleTexts` 인자 타입만)

**Interfaces:**
- Consumes: `Bookmark` (Task 1), `visibleTexts`/`DisplayMode` (`~/components/TranscriptList`),
  `formatTimestamp` (`~/lib/transcript-parse`)
- Produces: `NotesPanel` 컴포넌트

- [ ] **Step 1: visibleTexts의 첫 인자를 넓힌다**

`src/components/TranscriptList.tsx`에서 함수 시그니처만 바꾼다. 본문은 그대로다 —
이 함수는 이미 두 필드밖에 읽지 않는다.

```ts
/** ... 기존 doc 주석 유지 ... */
export function visibleTexts(
  // `TranscriptSegment`가 아니라 이 함수가 실제로 읽는 두 필드만 요구한다.
  // 그래야 `kind: 'row'`로 좁힌 `Bookmark`(같은 두 필드를 같은 타입으로 가진다)를
  // 어댑터 객체 없이 그대로 넘길 수 있다 — Notes 탭이 Transcript와 똑같이
  // displayMode를 존중하게 만드는 유일한 이유다.
  segment: { sourceText: string; translatedText: string | null },
  mode: DisplayMode,
): VisibleTexts {
```

- [ ] **Step 2: NotesPanel을 만든다**

`src/components/NotesPanel.tsx` (신규):

```tsx
import { Button } from '~/components/Button';
import { visibleTexts, type DisplayMode } from '~/components/TranscriptList';
import { formatTimestamp } from '~/lib/transcript-parse';
import type { Bookmark } from '~/types/bookmark';

/**
 * 기억한 문장 목록 (spec 2026-08-02 §3.4). 이 컴포넌트는 판단을 하지 않는다 —
 * 정렬은 `useBookmarks`가 이미 `sortBookmarks`로 끝냈고, 한 행이 무엇을 보여줄지는
 * `visibleTexts`가 정한다. `LibraryView`가 세운 것과 같은 규율이다.
 */
export function NotesPanel({
  bookmarks,
  displayMode,
  loadFailed,
  onSeek,
  onRemove,
  onRetry,
}: {
  bookmarks: Bookmark[];
  displayMode: DisplayMode;
  loadFailed: boolean;
  onSeek: (startSec: number) => void;
  onRemove: (bookmarkId: string) => void;
  onRetry: () => void;
}) {
  if (loadFailed) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 pt-10 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          기억한 문장을 불러오지 못했어요
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          다시 시도
        </Button>
      </div>
    );
  }

  if (bookmarks.length === 0) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 pt-10 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          아직 기억한 문장이 없어요
        </p>
        <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          Transcript에서 문장을 우클릭하거나 ☆를 눌러 저장하세요
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {bookmarks.map((bookmark) => (
        <li key={bookmark.bookmarkId} className="group flex items-start gap-1 pr-2">
          <button
            type="button"
            onClick={() => onSeek(bookmark.startSec)}
            className="flex min-w-0 flex-1 gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
          >
            <span className="w-12 flex-none text-right font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(bookmark.startSec)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <BookmarkTexts bookmark={bookmark} displayMode={displayMode} />
            </span>
          </button>
          <button
            type="button"
            onClick={() => onRemove(bookmark.bookmarkId)}
            aria-label="기억 해제"
            // 확인 단계를 두지 않는다 — 라이브러리 삭제(재생성에 5~8분과 Gemini
            // 재과금)와 달리 되돌리기 비용이 사실상 0이다.
            className="mt-3 shrink-0 rounded p-1 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-100 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <TrashIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

function BookmarkTexts({ bookmark, displayMode }: { bookmark: Bookmark; displayMode: DisplayMode }) {
  if (bookmark.kind === 'excerpt') {
    return (
      <span className="border-l-2 border-neutral-300 pl-2 text-[13px] leading-relaxed text-neutral-900 dark:border-neutral-700 dark:text-neutral-100">
        {bookmark.excerpt}
      </span>
    );
  }

  // Transcript의 행과 똑같은 규칙으로 displayMode를 존중한다 — 같은 함수를 쓰므로
  // 두 화면이 어긋날 수 없다.
  const texts = visibleTexts(bookmark, displayMode);
  if (texts.kind === 'dual') {
    return (
      <>
        <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {texts.secondaryText}
        </span>
        <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
          {texts.primaryText}
        </span>
      </>
    );
  }
  if (texts.kind === 'secondary-only') {
    return (
      <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        {texts.text}
      </span>
    );
  }
  return (
    <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
      {texts.text}
    </span>
  );
}

/** `LibraryView`의 것과 같은 인라인 SVG. */
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}
```

> `Button`의 `variant`/`size` 값은 `LibraryView`의 재시도 버튼과 같은
> `variant="secondary" size="sm"`이다. `src/components/Button.tsx`가 다른 이름을
> 쓴다면 그 파일을 따른다.

- [ ] **Step 3: 타입과 테스트를 확인한다**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 타입 오류 없음, 전부 PASS. `visibleTexts`의 기존 호출부(TranscriptList
자신과 `TranscriptList.test.ts`)는 `TranscriptSegment`를 넘기는데, 그 타입이 새
인자 타입의 상위집합이라 그대로 통과한다.

- [ ] **Step 4: 커밋**

```bash
git add src/components/NotesPanel.tsx src/components/TranscriptList.tsx
git commit -m "Show remembered sentences in video order, honoring the display mode"
```

---

### Task 7: 세 번째 탭 배선

**Files:**
- Modify: `src/lib/panel-prefs.ts`
- Modify: `src/lib/panel-prefs.test.ts`
- Modify: `entrypoints/sidepanel/App.tsx`

**Interfaces:**
- Consumes: `NotesPanel` (Task 6), `useBookmarks` (Task 4)
- Produces: `PanelTab = 'transcript' | 'summary' | 'notes'`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/panel-prefs.test.ts`의 `describe('loadPanelPrefs', ...)` 안에 추가한다:

```ts
  it('accepts notes as a stored tab', async () => {
    store.panelLastTab = 'notes';
    expect((await loadPanelPrefs()).lastTab).toBe('notes');
  });
```

`describe('save functions', ...)`(69행) 안에 추가한다:

```ts
  it('round-trips notes through storage', async () => {
    await savePanelLastTab('notes');
    expect((await loadPanelPrefs()).lastTab).toBe('notes');
  });
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `npx vitest run src/lib/panel-prefs.test.ts`
Expected: FAIL — `'notes'`가 `PANEL_TABS`에 없어 기본값 `'transcript'`로 폴백된다
(그리고 `savePanelLastTab('notes')`는 타입 오류다)

- [ ] **Step 3: PanelTab에 notes를 더한다**

`src/lib/panel-prefs.ts`:

```ts
export type PanelTab = 'transcript' | 'summary' | 'notes';
```

```ts
const PANEL_TABS: readonly PanelTab[] = ['transcript', 'summary', 'notes'];
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `npx vitest run src/lib/panel-prefs.test.ts`
Expected: PASS

- [ ] **Step 5: App.tsx의 탭 상태 타입을 넓힌다**

`activeTab` 선언(525행 근처)을 바꾼다:

```tsx
  const [activeTab, setActiveTab] = useState<PanelTab>('transcript');
```

`PanelTab`은 이미 그 파일이 import하고 있다.

- [ ] **Step 6: 복원 조건을 일반화한다**

`lastTabRestoredRef` effect(564-571행 근처)의 `'summary'` 하드코딩을 고친다.
**이걸 빼먹으면 `'notes'`가 저장돼도 복원이 조용히 실패한다.**

```tsx
  useEffect(() => {
    if (!showSummaryTab || lastTabRestoredRef.current || storedLastTab === null) return;
    lastTabRestoredRef.current = true;
    // `'summary'` 하드코딩에서 넓혔다 — 탭이 셋이 되면서, 복원할 값은 "transcript가
    // 아닌 무엇"이다. 게이트(showSummaryTab)는 Summary와 Notes가 공유하므로
    // 아래 스냅백 effect는 그대로 둔다.
    if (storedLastTab !== 'transcript') {
      if (activeTab !== storedLastTab) restoringTabRef.current = true;
      setActiveTab(storedLastTab);
    }
  }, [showSummaryTab, storedLastTab, activeTab]);
```

- [ ] **Step 7: 탭바에 Notes를 더한다**

`showSummaryTab` 분기 안의 탭 배열(740-744행 근처)을 바꾼다:

```tsx
                {(
                  [
                    ['transcript', 'Transcript'],
                    ['summary', 'Summary'],
                    ['notes', 'Notes'],
                  ] as const
                ).map(([tab, label]) => (
```

버튼의 라벨 부분을 바꿔 개수 뱃지를 붙인다:

```tsx
                    {label}
                    {tab === 'notes' && bookmarks.bookmarks.length > 0 && (
                      // 우클릭은 발견이 어려운 인터랙션이라, 저장한 것이 있다는
                      // 사실 자체가 탭에서 보여야 한다.
                      <span className="ml-1 text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                        {bookmarks.bookmarks.length}
                      </span>
                    )}
```

- [ ] **Step 8: 본문 분기를 셋으로 만든다**

`activeTab === 'transcript' ? (...) : (...)` 구조(765-787행 근처)를 바꾼다:

```tsx
              {activeTab === 'transcript' ? (
                <>
                  {translationLangMismatchBanner}
                  <TranscriptList
                    segments={record.segments}
                    displayMode={displayMode}
                    activeIndex={activeIndex}
                    onSeekRow={(segment) => playback.seek(segment.startSec)}
                    savedSegmentIds={bookmarks.savedSegmentIds}
                    onToggleRow={bookmarks.toggleRow}
                    onSaveExcerpt={bookmarks.saveExcerpt}
                  />
                </>
              ) : activeTab === 'notes' ? (
                <NotesPanel
                  bookmarks={bookmarks.bookmarks}
                  displayMode={displayMode}
                  loadFailed={bookmarks.loadFailed}
                  onSeek={(startSec) => playback.seek(startSec)}
                  onRemove={bookmarks.remove}
                  onRetry={bookmarks.reload}
                />
              ) : (
                <>
                  {summaryLangMismatchBanner}
                  <SummaryPanel
                    summary={summaryState.summary}
                    status={summaryState.status}
                    error={summaryState.error}
                    elapsedSeconds={summaryElapsedSeconds}
                    onGenerate={summaryState.generate}
                    onSeekSection={(startSec) => playback.seek(startSec)}
                  />
                </>
              )}
```

import를 더한다:

```tsx
import { NotesPanel } from '~/components/NotesPanel';
```

> `onSaveExcerpt`는 Task 4에서 이미 넘기고 있다 — 위 코드에 그대로 유지한다.

- [ ] **Step 9: 타입과 테스트를 확인한다**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 전부 PASS

- [ ] **Step 10: 실제 크롬에서 확인한다**

1. 번역 완료 영상에 `Transcript` / `Summary` / `Notes` 세 탭이 보이고, 400px에서
   라벨이 잘리지 않는다
2. 저장한 문장이 있으면 `Notes` 옆에 개수가 뜨고, 저장/해제할 때마다 즉시 바뀐다
3. `Notes` 탭이 `startSec` 오름차순으로 그려진다 (일부러 뒤쪽 문장을 먼저 저장해 확인)
4. Notes 행을 클릭하면 영상이 그 시점으로 이동한다
5. 휴지통을 누르면 확인 없이 바로 사라지고, Transcript의 ★도 함께 꺼진다
6. 자막 표시를 `한국어`로 바꾸면 Notes의 `row` 항목도 한 줄로 바뀐다 (조각은 그대로)
7. `Notes` 탭에 둔 채 패널을 닫았다 다시 열면 `Notes`로 돌아온다
8. 저장이 0개인 영상의 `Notes` 탭에 빈 상태 문구 두 줄이 보인다

- [ ] **Step 11: 커밋**

```bash
git add src/lib/panel-prefs.ts src/lib/panel-prefs.test.ts entrypoints/sidepanel/App.tsx
git commit -m "Add a Notes tab beside Transcript and Summary"
```

---

### Task 8: 내보내기

**Files:**
- Modify: `src/lib/export-doc.ts`
- Modify: `src/lib/export-doc.test.ts`
- Modify: `src/features/export/useExportData.ts`
- Modify: `src/components/DownloadMenu.tsx`

**Interfaces:**
- Consumes: `Bookmark` (Task 1), `sortBookmarks` (Task 2), `GET_BOOKMARKS` (Task 3)
- Produces:
  - `renderBookmarksMarkdown(input: BookmarkExportInput): string`
  - `ExportDataState`의 `ready`에 `bookmarks: Bookmark[]` 추가

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/export-doc.test.ts`의 **기존** `'./export-doc'` import에
`renderBookmarksMarkdown`을 더하고(새 import 줄을 만들지 않는다), 타입 import를
한 줄 더한다:

```ts
import { buildExportModel, buildFileBaseName, renderBookmarksMarkdown, renderMarkdown } from './export-doc';
import type { Bookmark } from '~/types/bookmark';
```

파일 끝에 추가한다. 이 파일에는 `VIDEO`(VideoMeta 상수)와 `VIDEO_ID`가 이미 있고,
날짜는 **로컬 시간 컴포넌트로 만든다** — `new Date('...Z')`를 쓰면 실행 타임존에
따라 `formatExportedAt` 검증이 흔들린다(커밋 `6ba2d8a`가 고친 것과 같은 함정):

```ts
function bookmarkFixture(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    bookmarkId: 'bm-1',
    segmentId: 'zjkBMFhNj_g:3',
    startSec: 724,
    createdAt: '2026-08-02T00:00:00.000Z',
    kind: 'row',
    sourceText: "Let's talk about attention",
    translatedText: '먼저 어텐션에 대해 얘기해 봅시다',
    ...overrides,
  } as Bookmark;
}

describe('renderBookmarksMarkdown', () => {
  const video = VIDEO;
  // 로컬 시간 컴포넌트(월은 0-based) — 파일 상단 EXPORTED_AT과 같은 이유다.
  const exportedAt = new Date(2026, 7, 2, 10, 30);

  it('renders a row bookmark with both texts under a linked timestamp', () => {
    const md = renderBookmarksMarkdown({ video, bookmarks: [bookmarkFixture()], exportedAt });

    expect(md).toContain(`## [12:04](https://youtu.be/${video.videoId}?t=724)`);
    expect(md).toContain("Let's talk about attention");
    expect(md).toContain('먼저 어텐션에 대해 얘기해 봅시다');
  });

  it('keeps both texts even though the panel may be showing only one', () => {
    // 표시 설정은 화면을 좁히는 선택이지 저장된 내용을 버리는 선택이 아니다 —
    // 그래서 이 함수는 displayMode를 아예 받지 않는다.
    const md = renderBookmarksMarkdown({ video, bookmarks: [bookmarkFixture()], exportedAt });
    const lines = md.split('\n');
    expect(lines.some((l) => l === "Let's talk about attention")).toBe(true);
    expect(lines.some((l) => l === '먼저 어텐션에 대해 얘기해 봅시다')).toBe(true);
  });

  it('emits the source alone when a row was never translated', () => {
    const md = renderBookmarksMarkdown({
      video,
      bookmarks: [bookmarkFixture({ translatedText: null } as Partial<Bookmark>)],
      exportedAt,
    });
    expect(md).toContain("Let's talk about attention");
    // 빈 행을 만들지 않는다 — export-doc의 I4가 남긴 규율.
    expect(md).not.toMatch(/\n\n\n\n/);
  });

  it('renders an excerpt as a blockquote', () => {
    const md = renderBookmarksMarkdown({
      video,
      bookmarks: [
        bookmarkFixture({
          bookmarkId: 'bm-x',
          kind: 'excerpt',
          excerpt: 'the key thing is the softmax',
          sourceText: undefined,
          translatedText: undefined,
        } as Partial<Bookmark>),
      ],
      exportedAt,
    });
    expect(md).toContain('> the key thing is the softmax');
  });

  it('orders entries by startSec regardless of input order', () => {
    const md = renderBookmarksMarkdown({
      video,
      bookmarks: [
        bookmarkFixture({ bookmarkId: 'late', startSec: 1721 }),
        bookmarkFixture({ bookmarkId: 'early', startSec: 12 }),
      ],
      exportedAt,
    });
    expect(md.indexOf('[0:12]')).toBeLessThan(md.indexOf('[28:41]'));
  });

  it('states the count in the meta line', () => {
    const md = renderBookmarksMarkdown({
      video,
      bookmarks: [bookmarkFixture(), bookmarkFixture({ bookmarkId: 'bm-2', startSec: 900 })],
      exportedAt,
    });
    expect(md).toContain('기억한 문장 2개');
  });

  it('renders a header and meta line even with no bookmarks', () => {
    // 메뉴가 0개일 때 이 항목을 비활성화하므로 실제로는 도달하지 않지만, 빈
    // 입력에서 예외를 던지지 않는다는 것은 이 함수의 계약이다.
    const md = renderBookmarksMarkdown({ video, bookmarks: [], exportedAt });
    expect(md).toContain(`# ${video.title}`);
    expect(md).toContain('기억한 문장 0개');
  });
});
```

> `VIDEO`는 `export-doc.test.ts` 13행에 이미 있는 `VideoMeta` 상수다 — 새 헬퍼를
> 만들지 않는다. `formatTimestamp(724)`가 `12:04`, `formatTimestamp(1721)`이
> `28:41`, `formatTimestamp(12)`가 `0:12`다.

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `npx vitest run src/lib/export-doc.test.ts`
Expected: FAIL — `renderBookmarksMarkdown`이 없다

- [ ] **Step 3: 렌더러를 구현한다**

`src/lib/export-doc.ts`의 import에 더한다:

```ts
import { sortBookmarks } from '~/lib/bookmarks';
import type { Bookmark } from '~/types/bookmark';
```

파일 끝에 추가한다:

```ts
export interface BookmarkExportInput {
  video: VideoMeta;
  bookmarks: Bookmark[];
  /** 주입받는다 — 이 모듈은 시계를 읽지 않는다. */
  exportedAt: Date;
}

/**
 * 기억한 문장만 담는 발췌 노트 (spec 2026-08-02 §7). `renderMarkdown`을 재사용하지
 * 않고 형제 함수로 두는 이유는 출력 구조가 다르기 때문이다 — 요약도 전체 스크립트도
 * 없고, 항목마다 h2가 하나씩 선다(노트 앱에서 문장 단위로 접히고 링크되도록).
 *
 * `displayMode`를 받지 않는다: 패널의 표시 설정은 화면을 좁히는 선택이지 저장된
 * 내용을 버리는 선택이 아니므로, 내보내기는 언제나 원문과 번역을 모두 담는다.
 */
export function renderBookmarksMarkdown({
  video,
  bookmarks,
  exportedAt,
}: BookmarkExportInput): string {
  const videoUrl = `https://youtu.be/${video.videoId}`;
  const lines: string[] = [`# ${video.title}`, ''];

  const metaParts = [videoUrl, `기억한 문장 ${bookmarks.length}개`, formatExportedAt(exportedAt)];
  lines.push(`> ${metaParts.join(' · ')}`, '');

  for (const bookmark of sortBookmarks(bookmarks)) {
    // startSec은 저장 시점에 이미 정수로 잘렸다(createRowBookmark) — 여기서 다시
    // 자르지 않는다.
    lines.push(`## [${formatTimestamp(bookmark.startSec)}](${videoUrl}?t=${bookmark.startSec})`, '');
    if (bookmark.kind === 'excerpt') {
      lines.push(`> ${bookmark.excerpt}`, '');
      continue;
    }
    lines.push(bookmark.sourceText, '');
    // 번역이 없는 행은 원문만 나간다 — 빈 줄만 남는 항목을 만들지 않는다(I4 규율).
    if (bookmark.translatedText !== null) lines.push(bookmark.translatedText, '');
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `npx vitest run src/lib/export-doc.test.ts`
Expected: PASS

- [ ] **Step 5: useExportData에 bookmarks를 더한다**

`src/features/export/useExportData.ts`:

```ts
import type { Bookmark } from '~/types/bookmark';
```

`ExportDataState`의 `ready`에 한 줄:

```ts
  | {
      status: 'ready';
      video: VideoMeta;
      record: TranslationRecord;
      summary: VideoSummary | null;
      bookmarks: Bookmark[];
    };
```

`fetchExportData`의 `Promise.all`과 반환을 바꾼다:

```ts
    const [video, record, summary, bookmarksRes] = await Promise.all([
      sendMessage({ type: 'GET_VIDEO_META', payload: { videoId } }),
      sendMessage({ type: 'GET_TRANSLATION', payload: { videoId } }),
      sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }),
      sendMessage({ type: 'GET_BOOKMARKS', payload: { videoId } }),
    ]);

    if (!video) return { status: 'unavailable', reason: 'no-video' };
    if (!record || record.status !== 'done') return { status: 'unavailable', reason: 'not-done' };
    return {
      status: 'ready',
      video,
      record,
      summary: summary.summary,
      // 북마크 조회 실패가 스크립트/요약 내보내기까지 막지는 않는다 — 그 두
      // 항목은 이 값 없이도 완결된다. 대신 기억한 문장 항목이 0개로 비활성화된다.
      bookmarks: bookmarksRes.ok ? bookmarksRes.bookmarks : [],
    };
```

- [ ] **Step 6: DownloadMenu에 세 번째 항목을 더한다**

`src/components/DownloadMenu.tsx`의 import를 바꾼다:

```ts
import { buildExportModel, renderBookmarksMarkdown, renderMarkdown } from '~/lib/export-doc';
```

`downloadMarkdown` 아래에 추가한다:

```ts
  // Blob 저장이 두 곳으로 늘어 공통 부분만 뽑았다. `URL.revokeObjectURL`을
  // setTimeout으로 미루는 이유는 앵커 클릭이 비동기로 소비하기 때문이다.
  const saveBlob = (text: string, fileName: string) => {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadBookmarks = () => {
    if (data.status !== 'ready') return;
    try {
      const text = renderBookmarksMarkdown({
        video: data.video,
        bookmarks: data.bookmarks,
        exportedAt: new Date(),
      });
      saveBlob(text, `${buildFileBaseName(data.video.title, data.video.videoId)}-notes.md`);
    } finally {
      setOpen(false);
    }
  };
```

import에 `buildFileBaseName`을 더한다 (`~/lib/export-doc`에서 이미 export 중이다).

`downloadMarkdown`의 Blob 저장 부분을 `saveBlob(renderMarkdown(model), `${model.fileBaseName}.md`)`로
바꿔 중복을 없앤다.

메뉴에 항목을 더한다 (`PDF (인쇄)` 아래):

```tsx
          <MenuItem disabled={!ready || bookmarkCount === 0} onClick={downloadBookmarks}>
            기억한 문장 (.md)
          </MenuItem>
```

`ready` 선언 옆에 추가한다:

```ts
  const bookmarkCount = data.status === 'ready' ? data.bookmarks.length : 0;
```

`hintFor`를 바꾼다:

```ts
function hintFor(data: ExportDataState): string {
  if (data.status === 'loading') return '확인 중…';
  if (data.status === 'unavailable') {
    return data.reason === 'not-done' ? '번역 완료 후 내려받을 수 있어요' : '영상을 인식하지 못했어요';
  }
  if (data.bookmarks.length === 0) {
    // 기억한 문장 항목이 왜 비활성인지 말해 준다 — 앞의 두 항목은 멀쩡히 쓸 수 있다.
    return data.summary
      ? '스크립트와 요약이 함께 담깁니다 · 기억한 문장 없음'
      : '요약 없음 — 스크립트만 포함';
  }
  return data.summary ? '스크립트와 요약이 함께 담깁니다' : '요약 없음 — 스크립트만 포함';
}
```

- [ ] **Step 7: 타입과 전체 테스트를 확인한다**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 전부 PASS. `useExportData`를 쓰는 `entrypoints/export/App.tsx`가
`bookmarks` 필드를 무시하므로 타입 오류가 나지 않는다.

- [ ] **Step 8: 실제 크롬에서 확인한다**

1. 기억한 문장이 0개면 ⬇ 메뉴의 `기억한 문장 (.md)`가 비활성이고 힌트에
   `기억한 문장 없음`이 붙는다
2. 1개 이상이면 활성화되고, 클릭하면 `<제목>_<videoId>-notes.md`가 받아진다
3. 파일 안에 `## [12:04](https://youtu.be/...?t=724)` 형태의 링크가 있고, 그 링크가
   실제로 그 시점으로 이동한다
4. 조각은 `>` 인용으로, 행은 원문/번역 두 줄로 들어 있다
5. 항목이 영상 시간순으로 정렬돼 있다
6. `PDF (인쇄)`와 `Markdown (.md)`는 이전과 똑같이 동작한다

- [ ] **Step 9: 커밋**

```bash
git add src/lib/export-doc.ts src/lib/export-doc.test.ts src/features/export/useExportData.ts src/components/DownloadMenu.tsx
git commit -m "Export just the remembered sentences as their own markdown note"
```

---

## 마무리 검증 (컨트롤러가 실제 크롬에서 수행)

여덟 태스크가 끝난 뒤 한 번에 확인한다. 서비스워커 교체는 `chrome.runtime.reload()`로
하고(`loadUnpacked`는 살아 있는 SW를 갈아끼우지 않는다), 대상 탭은 활성 상태로 둔다
(숨은 탭은 스크롤 이벤트를 억제하고 미디어를 로드하지 않는다).

- [ ] 긴 영상(600행 이상)에서 뒤쪽 문장을 저장한 뒤 `Notes`로 갔다가 `Transcript`로
      돌아왔을 때, 재생 위치 따라가기가 여전히 동작한다
- [ ] 번역을 `다시 생성`해도 기억한 문장이 그대로 남고, 그 항목의 시크가 여전히 맞는다
- [ ] 라이브러리에서 그 영상의 자막을 지운 뒤 DevTools의 `bookmarks` 스토어에서
      해당 레코드가 사라졌다
- [ ] 다른 영상으로 이동하면 `Notes`가 그 영상의 목록으로 바뀐다 (이전 영상 것이
      남아 있지 않다)
- [ ] 확장을 리로드하는 도중 ☆를 눌러도 패널이 죽지 않는다 (★가 안 켜질 뿐)
- [ ] 라이트/다크 모두에서 ☆·메뉴·Notes 행의 대비가 읽을 만하다
