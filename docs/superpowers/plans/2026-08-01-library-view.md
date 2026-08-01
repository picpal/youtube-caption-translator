# 라이브러리 뷰 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드패널에 지금까지 자막을 만든 영상의 목록·검색·삭제 화면을 더한다.

**Architecture:** background가 세 IndexedDB 스토어(`translations`/`videos`/`summaries`)를
조인해 목록 전용 경량 투영(`LibraryEntry[]`)만 패널로 보낸다. 패널은 그 배열을
메모리에서 필터링한다. 화면은 새 서페이스가 아니라 사이드패널 안의 최상위 뷰
전환(`'video' | 'library'`)이다.

**Tech Stack:** WXT + React 18 + TypeScript + Tailwind, Manifest V3, vitest + fake-indexeddb

**설계 문서:** `docs/superpowers/specs/2026-08-01-library-view-design.md`

## Global Constraints

이 절의 모든 항목은 **모든 태스크의 요구사항에 암묵적으로 포함된다.**

- **새 의존성 추가 금지.** `@testing-library/*`를 포함해 어떤 패키지도 추가하지
  않는다. 이 저장소에는 컴포넌트 렌더 테스트 하니스가 **없다**(측정: `package.json`에
  testing-library 없음, `*.test.tsx` 파일 0개). 따라서 **모든 결정 로직은
  `src/lib/library.ts`의 순수 함수로 뽑아 테스트하고, 컴포넌트는 그 함수를 호출만
  한다.** `pnpm`/`npm install` 부작용으로 `package-lock.json`이 생기면 삭제한다.
- **새 권한 금지.** `wxt.config.ts`의 `permissions`는 정확히 `['storage', 'sidePanel']`,
  `host_permissions`는 youtube.com + generativelanguage.googleapis.com 그대로 유지한다.
  `tabs` 권한을 추가하지 않는다.
- **새 서페이스 금지.** `action.default_popup`을 추가하지 않는다. 새 확장 페이지
  (`*.html` 엔트리포인트)를 만들지 않는다. 라이브러리는 사이드패널 안의 뷰다.
- **아이콘은 인라인 SVG.** 아이콘 라이브러리를 추가하지 않는다.
  `src/components/DownloadMenu.tsx`의 `DownloadIcon`과 같은 방식(`width="18"
  height="18"`, `stroke="currentColor"`, `strokeWidth="2"`, `aria-hidden`)을 따른다.
- **UI 문구는 한국어.** 이 계획에 적힌 문구를 **글자 그대로** 쓴다.
- **`entrypoints/sidepanel/App.tsx`는 이미 1003줄이다.** 라이브러리 마크업을 한 줄도
  넣지 않는다. 그 파일의 변경은 뷰 상태 하나, 헤더 버튼 하나, 본문 분기 하나뿐이다.
- **`scripts/` 아래 어떤 스크립트도 실행하지 않는다.** 저장소 루트의 `.env.local`을
  읽거나 열지 않는다.
- **베이스라인: 424개 테스트 / 23개 파일이 통과 중이다.** 각 태스크 종료 시
  `npx vitest run` 전체 통과 + `npx tsc --noEmit` 무오류여야 한다.
- **커밋은 태스크당 하나**, 메시지는 영어 한 줄로 무엇이 달라졌는지 말한다.

---

## 파일 구조

| 파일 | 책임 | 태스크 |
| --- | --- | --- |
| `src/types/library.ts` | 신규 — `TranslationDigest`(db 투영), `LibraryEntry`(메시지 페이로드) | 1 |
| `src/lib/db.ts` | 수정 — 목록 조회 3개 + 원자적 삭제 1개 | 1 |
| `src/lib/db.test.ts` | 수정 — 위 4개 테스트 | 1 |
| `src/lib/youtube.ts` | 수정 — `thumbnailUrlFor` 추가 | 2 |
| `src/lib/youtube.test.ts` | 수정 — `thumbnailUrlFor` 테스트 | 2 |
| `src/lib/video-meta.ts` | 수정 — 인라인 URL을 `thumbnailUrlFor` 호출로 | 2 |
| `src/types/message.ts` | 수정 — 메시지 2개 + 응답 2개 | 3 |
| `entrypoints/background.ts` | 수정 — 핸들러 2개 + `errorResponseFor` 2줄 | 3 |
| `src/background.test.ts` | 수정 — 두 핸들러 테스트 | 3 |
| `src/lib/library.ts` | 신규 — 검색·표시 순수 함수 전부 | 4 |
| `src/lib/library.test.ts` | 신규 | 4 |
| `src/components/LibraryView.tsx` | 신규 — 목록·검색·사용량 (5), 삭제 (6) | 5, 6 |
| `entrypoints/sidepanel/App.tsx` | 수정 — 뷰 상태·헤더 아이콘·탭 이동 | 5 |
| `README.md` | 수정 — 폴더 이동 경고 | 7 |

---

### Task 1: 타입과 db 레이어

**Files:**
- Create: `src/types/library.ts`
- Modify: `src/lib/db.ts` (파일 끝에 추가)
- Test: `src/lib/db.test.ts` (파일 끝에 `describe` 추가)

**Interfaces:**
- Consumes: 기존 `openDb`, `STORE_NAME`, `TRANSLATIONS_STORE`, `SUMMARIES_STORE` (모두
  `src/lib/db.ts` 안에 이미 있다)
- Produces:
  - `TranslationDigest` / `LibraryEntry` (`~/types/library`)
  - `listTranslationDigests(): Promise<TranslationDigest[]>`
  - `getAllVideos(): Promise<VideoMeta[]>`
  - `getAllSummaries(): Promise<VideoSummary[]>`
  - `deleteVideoData(videoId: string): Promise<void>`

- [ ] **Step 1: 타입 파일을 만든다**

`src/types/library.ts`:

```ts
// 라이브러리 뷰(spec 2026-08-01) 전용 타입 둘. 둘 다 순수 타입 선언이라 런타임
// 코드가 없다.
import type { TargetLang } from '~/lib/target-lang';
import type { TranslationStatus } from '~/types/transcript';

/**
 * `translations` 스토어를 커서로 훑으면서 레코드당 남기는 것. `segments` 배열은
 * `length`만 취하고 버린다 — 목록에 필요한 건 개수뿐인데 배열 자체는 1시간 영상
 * 하나가 약 186 KB다(실측). db 레이어 밖으로 나가는 값이므로 db.ts가 아니라
 * 여기에 둔다.
 */
export interface TranslationDigest {
  videoId: string;
  status: TranslationStatus;
  segmentCount: number;
  /** 레코드의 `targetLang ?? 'ko'`를 이미 적용한 값 — 읽는 쪽이 다시 기본값을
   * 채울 필요가 없다. */
  targetLang: TargetLang;
  updatedAt: string;
}

/**
 * background가 세 스토어를 조인해 만든 목록 한 행. 패널로 건너가는 유일한 모양이다.
 *
 * 왜 `TranslationRecord`를 그대로 보내지 않는가: 실측으로 완료 레코드가 자막
 * 구간당 약 594 B라, 영상 100편이면 약 18 MB가 `sendMessage`의 구조화 복제를
 * 통과한다. 이 투영은 같은 100편에 약 8 KB다.
 */
export interface LibraryEntry {
  videoId: string;
  /** `videos` 스토어에 짝이 없으면 `videoId`를 그대로 쓴다 — 제목 없는 행을
   * 만들지 않는다. */
  title: string;
  channelName: string | null;
  thumbnailUrl: string;
  durationSeconds: number | null;
  status: TranslationStatus;
  targetLang: TargetLang;
  segmentCount: number;
  /** 요약이 없으면 빈 배열. 제목과 함께 검색 대상이다. */
  keywords: string[];
  hasSummary: boolean;
  /** 정렬 키 (내림차순). */
  updatedAt: string;
  /** 지금 background에서 이 영상의 번역 또는 요약 잡이 도는 중. 삭제 금지 신호이며,
   * 패널이 목록을 읽은 시점의 스냅샷이라 낡을 수 있다 — 진짜 검사는 background의
   * 삭제 핸들러가 한다. */
  inFlight: boolean;
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`src/lib/db.test.ts` 맨 끝에 추가한다. 상단 import에
`getAllSummaries, getAllVideos, listTranslationDigests, deleteVideoData`를 더하고,
`SUMMARIES_STORE`도 (아직 import돼 있지 않다면) 더한다.

```ts
describe('library queries', () => {
  it('listTranslationDigests projects each record without its segments', async () => {
    await putTranslation(
      makeRecord({ videoId: 'aaa', segments: [makeSegment(), makeSegment({ index: 1 })] }),
    );

    const digests = await listTranslationDigests();

    expect(digests).toHaveLength(1);
    expect(digests[0]).toEqual({
      videoId: 'aaa',
      status: 'done',
      segmentCount: 2,
      targetLang: 'ko',
      updatedAt: digests[0].updatedAt,
    });
    // 투영이 실제로 segments를 떨어뜨렸는지 — 이게 이 함수의 존재 이유다.
    expect('segments' in digests[0]).toBe(false);
  });

  it('listTranslationDigests defaults a record with no targetLang to ko', async () => {
    const record = makeRecord({ videoId: 'bbb' });
    delete record.targetLang;
    await putTranslation(record);

    const [digest] = await listTranslationDigests();

    expect(digest.targetLang).toBe('ko');
  });

  it('listTranslationDigests returns an empty array when nothing is stored', async () => {
    expect(await listTranslationDigests()).toEqual([]);
  });

  it('getAllVideos and getAllSummaries return every stored record', async () => {
    await putVideo(makeMeta({ videoId: 'aaa' }));
    await putVideo(makeMeta({ videoId: 'bbb' }));
    await putSummary(makeSummary({ videoId: 'aaa' }));

    expect((await getAllVideos()).map((v) => v.videoId).sort()).toEqual(['aaa', 'bbb']);
    expect((await getAllSummaries()).map((s) => s.videoId)).toEqual(['aaa']);
  });

  it('deleteVideoData removes the translation and the summary but keeps the video meta', async () => {
    await putVideo(makeMeta({ videoId: 'aaa' }));
    await putTranslation(makeRecord({ videoId: 'aaa' }));
    await putSummary(makeSummary({ videoId: 'aaa' }));

    await deleteVideoData('aaa');

    expect(await getTranslation('aaa')).toBeNull();
    expect(await getSummary('aaa')).toBeNull();
    // 메타는 제목·썸네일 캐시일 뿐이고 재방문 시 덮어써진다 (spec §7.1).
    expect(await getVideo('aaa')).not.toBeNull();
  });

  it('deleteVideoData leaves other videos alone', async () => {
    await putTranslation(makeRecord({ videoId: 'aaa' }));
    await putTranslation(makeRecord({ videoId: 'bbb' }));

    await deleteVideoData('aaa');

    expect(await getTranslation('bbb')).not.toBeNull();
  });

  it('deleteVideoData resolves for a videoId that was never stored', async () => {
    await expect(deleteVideoData('never-existed')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `npx vitest run src/lib/db.test.ts`
Expected: FAIL — `listTranslationDigests is not a function` 계열 에러.

- [ ] **Step 4: db.ts에 구현한다**

`src/lib/db.ts` 상단 import에 더한다:

```ts
import { DEFAULT_TARGET_LANG } from '~/lib/target-lang';
import type { TranslationDigest } from '~/types/library';
```

파일 끝에 추가한다:

```ts
// 라이브러리 목록용 조회 (spec 2026-08-01 §4.3). `getAll` 대신 커서를 쓰는 이유는
// 읽기 속도가 아니다 — 실측으로 커서가 오히려 조금 느리다(4편 339 KB 기준
// getAll 1.6 ms vs 커서 2.6 ms, 레코드마다 왕복이 생겨서). 이유는 결과 크기다:
// 같은 입력에서 getAll은 339 KB를, 이 투영은 0.3 KB를 낸다. 그 차이가 그대로
// sendMessage의 구조화 복제 비용이 된다.
export async function listTranslationDigests(): Promise<TranslationDigest[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSLATIONS_STORE, 'readonly');
    const request = tx.objectStore(TRANSLATIONS_STORE).openCursor();
    const digests: TranslationDigest[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      const record = cursor.value as TranslationRecord;
      digests.push({
        videoId: record.videoId,
        status: record.status,
        segmentCount: record.segments.length,
        targetLang: record.targetLang ?? DEFAULT_TARGET_LANG,
        updatedAt: record.updatedAt,
      });
      cursor.continue();
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(digests);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getAllVideos(): Promise<VideoMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    let result: VideoMeta[] = [];
    request.onsuccess = () => {
      result = (request.result as VideoMeta[] | undefined) ?? [];
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
  });
}

export async function getAllSummaries(): Promise<VideoSummary[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARIES_STORE, 'readonly');
    const request = tx.objectStore(SUMMARIES_STORE).getAll();
    let result: VideoSummary[] = [];
    request.onsuccess = () => {
      result = (request.result as VideoSummary[] | undefined) ?? [];
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
  });
}

// 번역과 요약을 한 트랜잭션으로 지운다. 원자성이 필요한 이유: 번역만 지워지고
// 요약이 남으면, 목록에서 사라진 영상의 요약이 영원히 고아로 남는다(목록의 기준
// 스토어가 `translations`이므로 다시 보이지 않는다).
//
// `videos`의 메타는 일부러 남긴다 — 제목·썸네일 캐시일 뿐이고 그 영상을 다시
// 방문하면 어차피 덮어써진다 (spec §7.1).
//
// 없는 키를 지우는 것은 IndexedDB에서 성공하는 no-op이므로 이 함수는 멱등이다.
export async function deleteVideoData(videoId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRANSLATIONS_STORE, SUMMARIES_STORE], 'readwrite');
    tx.objectStore(TRANSLATIONS_STORE).delete(videoId);
    tx.objectStore(SUMMARIES_STORE).delete(videoId);
    tx.oncomplete = () => {
      db.close();
      resolve();
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
```

- [ ] **Step 5: 통과를 확인한다**

Run: `npx vitest run src/lib/db.test.ts && npx tsc --noEmit`
Expected: PASS, 타입 오류 없음.

- [ ] **Step 6: 커밋**

```bash
git add src/types/library.ts src/lib/db.ts src/lib/db.test.ts
git commit -m "Add library list queries and an atomic per-video delete"
```

---

### Task 2: 썸네일 URL 헬퍼 추출

**왜 별도 태스크인가:** background가 `videos`에 짝이 없는 영상의 썸네일을 만들어야
하는데, 그 규칙이 지금 `src/lib/video-meta.ts:556`에 인라인돼 있다. background가
`video-meta.ts`를 import하면 DOM 파싱 코드 500여 줄이 서비스 워커 번들에 딸려
들어온다 — 문자열 하나 때문에 그럴 이유가 없다.

**Files:**
- Modify: `src/lib/youtube.ts` (파일 끝에 추가)
- Modify: `src/lib/video-meta.ts:556`
- Test: `src/lib/youtube.test.ts` (파일 끝에 `describe` 추가)

**Interfaces:**
- Produces: `thumbnailUrlFor(videoId: string): string` (`~/lib/youtube`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/youtube.test.ts` 끝에 추가하고, 상단 import에 `thumbnailUrlFor`를 더한다.

```ts
describe('thumbnailUrlFor', () => {
  it('builds the hqdefault URL from a video id', () => {
    expect(thumbnailUrlFor('zjkBMFhNj_g')).toBe(
      'https://i.ytimg.com/vi/zjkBMFhNj_g/hqdefault.jpg',
    );
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/lib/youtube.test.ts`
Expected: FAIL — `thumbnailUrlFor is not a function`.

- [ ] **Step 3: youtube.ts에 구현한다**

`src/lib/youtube.ts` 끝에 추가한다:

```ts
/**
 * 영상 id에서 유도한 썸네일 URL. 이 저장소에서 유일하게 검증된 썸네일 출처다 —
 * `src/lib/video-meta.ts`가 원래 이 식을 인라인으로 갖고 있었고, 여기로 옮긴
 * 이유는 서비스 워커(라이브러리 목록에서 `videos` 스토어에 짝이 없는 영상의
 * 썸네일을 만든다)가 `video-meta.ts`의 DOM 파싱 코드를 번들에 끌어들이지 않고
 * 쓸 수 있게 하기 위해서다.
 */
export function thumbnailUrlFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
```

- [ ] **Step 4: video-meta.ts가 그 함수를 쓰게 한다**

`src/lib/video-meta.ts`의 import에 `import { thumbnailUrlFor } from '~/lib/youtube';`를
더하고(이미 `~/lib/youtube`에서 뭔가 import 중이면 그 구문에 합친다), 556행을 바꾼다:

```ts
    thumbnailUrl: thumbnailUrlFor(videoId),
```

바로 위의 "Derived from the video id — the only thumbnail source that is both …"
주석은 **그대로 둔다.** 그 자리에서 여전히 맞는 설명이다.

- [ ] **Step 5: 전체 테스트를 돌린다**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — `video-meta` 기존 테스트가 같은 문자열을 계속 단언하므로 리팩터가
동작을 바꾸지 않았음을 그 테스트들이 증명한다.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/youtube.ts src/lib/youtube.test.ts src/lib/video-meta.ts
git commit -m "Extract thumbnailUrlFor so the service worker can build one without the DOM parser"
```

---

### Task 3: 메시지와 background 핸들러

**Files:**
- Modify: `src/types/message.ts` (`AppMessage` 유니온, `AppResponseMap`)
- Modify: `entrypoints/background.ts` (import, `handle()` switch, `errorResponseFor`)
- Test: `src/background.test.ts` (파일 끝에 `describe` 추가)

**Interfaces:**
- Consumes: Task 1의 `listTranslationDigests` / `getAllVideos` / `getAllSummaries` /
  `deleteVideoData`, Task 2의 `thumbnailUrlFor`, `LibraryEntry`
- Produces: 메시지 `GET_LIBRARY` → `LibraryEntry[]`,
  `DELETE_LIBRARY_ENTRY { videoId }` → `{ ok: true } | { ok: false; error: string }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/background.test.ts` 끝에 추가한다. 이 파일의 기존 규약을 그대로 따른다:
`handle()`을 실제로 호출하고, fake-indexeddb에 진짜로 쓰고,
`generateSummary`/`analyzeGlossary`/`translateBatch`만 목이다.

먼저 상단 import를 고친다 — `putVideo`가 아직 없다:

```ts
import { DB_NAME, getVideo, getTranslation, getSummary, putTranslation, putSummary, putVideo } from '~/lib/db';
import type { VideoMeta } from '~/types/video';
```

이 파일에는 `doneTranslationRecord(videoId, overrides)`가 이미 있다(150행) —
그것을 쓴다. `VideoMeta`/`VideoSummary` 픽스처는 없으므로 이 블록 앞에 만든다.
픽스처를 공용 모듈로 빼지 않는다 — 이 저장소는 파일마다 자기 픽스처를 갖는다.

```ts
function libraryMeta(videoId: string, overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: `${videoId} 제목`,
    channelName: '어떤채널',
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: 1334,
    captionAvailability: 'auto-only',
    fetchedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function librarySummary(videoId: string, keywords: string[]): VideoSummary {
  return {
    videoId,
    purpose: 'p',
    mainArguments: ['a'],
    sections: [{ startSec: 0, title: '도입' }],
    keywords,
    conclusion: 'c',
    model: 'test-model',
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

// 요약 잡을 in-flight로 고정한다. GENERATE_SUMMARY는 API 키와 segments가 있는
// 레코드가 둘 다 있어야 실제로 잡을 띄우므로(없으면 즉시 실패하고 맵에서
// 빠진다), 그 둘을 갖춘 뒤 해소되지 않는 목을 물린다. 이 파일의 기존 dedup
// 테스트가 쓰는 것과 같은 수법이다.
async function pinSummaryJob(videoId: string): Promise<void> {
  await chrome.storage.local.set({
    geminiApiKey: 'test-key',
    geminiApiKeySavedAt: '2026-01-01T00:00:00.000Z',
  });
  vi.mocked(generateSummary).mockReturnValue(new Promise(() => {}));
  void handle({ type: 'GENERATE_SUMMARY', payload: { videoId } }, senderFor(undefined));
  // 핸들러가 inFlightSummaries에 등록할 틈을 준다.
  await new Promise((resolve) => setTimeout(resolve, 0));
}
```

```ts
describe('GET_LIBRARY', () => {
  it('lists only videos that have a translation record', async () => {
    // 방문만 해도 videos에 쌓인다 — 그것만으로는 목록에 들어오면 안 된다.
    await putVideo(libraryMeta('visited-only'));
    await putVideo(libraryMeta('translated', { title: '번역한 영상' }));
    await putTranslation(doneTranslationRecord('translated'));

    const entries = await handle({ type: 'GET_LIBRARY' });

    expect(entries.map((e) => e.videoId)).toEqual(['translated']);
    expect(entries[0].title).toBe('번역한 영상');
  });

  it('falls back to the videoId and a derived thumbnail when no meta is stored', async () => {
    await putTranslation(doneTranslationRecord('orphan'));

    const [entry] = await handle({ type: 'GET_LIBRARY' });

    expect(entry.title).toBe('orphan');
    expect(entry.thumbnailUrl).toBe('https://i.ytimg.com/vi/orphan/hqdefault.jpg');
    expect(entry.channelName).toBeNull();
    expect(entry.durationSeconds).toBeNull();
  });

  it('carries the summary keywords and hasSummary', async () => {
    await putTranslation(doneTranslationRecord('withsum'));
    await putSummary(librarySummary('withsum', ['tokio', 'executor']));
    await putTranslation(doneTranslationRecord('nosum'));

    const entries = await handle({ type: 'GET_LIBRARY' });
    const withSum = entries.find((e) => e.videoId === 'withsum');
    const noSum = entries.find((e) => e.videoId === 'nosum');

    expect(withSum?.keywords).toEqual(['tokio', 'executor']);
    expect(withSum?.hasSummary).toBe(true);
    expect(noSum?.keywords).toEqual([]);
    expect(noSum?.hasSummary).toBe(false);
  });

  it('sorts by updatedAt descending, breaking ties by videoId', async () => {
    await putTranslation(doneTranslationRecord('old', { updatedAt: '2026-07-01T00:00:00.000Z' }));
    await putTranslation(doneTranslationRecord('zzz', { updatedAt: '2026-07-31T00:00:00.000Z' }));
    await putTranslation(doneTranslationRecord('aaa', { updatedAt: '2026-07-31T00:00:00.000Z' }));

    const entries = await handle({ type: 'GET_LIBRARY' });

    expect(entries.map((e) => e.videoId)).toEqual(['aaa', 'zzz', 'old']);
  });

  it('carries the record status so the row can badge it', async () => {
    await putTranslation(doneTranslationRecord('broke', { status: 'failed' }));

    const [entry] = await handle({ type: 'GET_LIBRARY' });

    expect(entry.status).toBe('failed');
  });

  it('returns an empty array when nothing has been translated', async () => {
    expect(await handle({ type: 'GET_LIBRARY' })).toEqual([]);
  });

  it('reports the in-flight job on the entry it belongs to', async () => {
    await putTranslation(doneTranslationRecord('busy'));
    await putTranslation(doneTranslationRecord('idle'));
    await pinSummaryJob('busy');

    const entries = await handle({ type: 'GET_LIBRARY' });

    expect(entries.find((e) => e.videoId === 'busy')?.inFlight).toBe(true);
    expect(entries.find((e) => e.videoId === 'idle')?.inFlight).toBe(false);
  });
});

describe('DELETE_LIBRARY_ENTRY', () => {
  it('deletes the translation and summary and keeps the video meta', async () => {
    await putVideo(libraryMeta('gone'));
    await putTranslation(doneTranslationRecord('gone'));
    await putSummary(librarySummary('gone', ['k']));

    const res = await handle({ type: 'DELETE_LIBRARY_ENTRY', payload: { videoId: 'gone' } });

    expect(res).toEqual({ ok: true });
    expect(await getTranslation('gone')).toBeNull();
    expect(await getSummary('gone')).toBeNull();
    expect(await getVideo('gone')).not.toBeNull();
    expect(await handle({ type: 'GET_LIBRARY' })).toEqual([]);
  });

  it('refuses while a job is in flight and deletes nothing', async () => {
    await putTranslation(doneTranslationRecord('busy'));
    await pinSummaryJob('busy');

    const res = await handle({ type: 'DELETE_LIBRARY_ENTRY', payload: { videoId: 'busy' } });

    expect(res).toEqual({ ok: false, error: 'job in flight' });
    // 이게 이 테스트의 핵심이다: 거부했으면 아무것도 지우지 않았어야 한다.
    expect(await getTranslation('busy')).not.toBeNull();
  });

  it('resolves ok for a videoId that has nothing stored', async () => {
    expect(await handle({ type: 'DELETE_LIBRARY_ENTRY', payload: { videoId: 'nothing' } })).toEqual({
      ok: true,
    });
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/background.test.ts`
Expected: FAIL — `GET_LIBRARY`가 `AppMessage` 유니온에 없어 타입 에러이거나,
`Unhandled message type: GET_LIBRARY`.

- [ ] **Step 3: 메시지 타입을 더한다**

`src/types/message.ts`의 `AppMessage` 유니온에서 `SUMMARY_REFRESHED` **앞에** 넣는다
(그 항목이 `;`로 유니온을 닫으므로):

```ts
  // panel -> background: 라이브러리 목록(spec 2026-08-01). 세 스토어를 조인한
  // 경량 투영만 돌려준다 — `TranslationRecord`를 그대로 보내면 영상 100편에 약
  // 18 MB가 구조화 복제를 통과한다(실측: 완료 레코드가 자막 구간당 약 594 B).
  // payload가 없는 이유: 라이브러리는 언제나 전체 목록이고, 검색은 패널이
  // 메모리에서 한다(대상이 수십 건이라 인덱스가 필요 없다).
  | { type: 'GET_LIBRARY' }
  // panel -> background: 한 영상의 번역과 요약을 지운다(`videos`의 메타는 남는다,
  // spec §7.1). 진행 중인 잡이 있으면 거부한다 — 번역 도중 레코드를 지우면 다음
  // `upsertBatch`가 레코드 부재를 보고 트랜잭션을 abort시켜(src/lib/db.ts:154)
  // 파이프라인이 사용자에게 이유 없는 에러로 죽는다.
  | { type: 'DELETE_LIBRARY_ENTRY'; payload: { videoId: string } }
```

`AppResponseMap`에 더한다:

```ts
  // `updatedAt` 내림차순, 동률이면 `videoId` 오름차순 — 결정적 순서라 테스트가
  // 순서를 단언할 수 있다.
  GET_LIBRARY: LibraryEntry[];
  // `error`는 다른 핸들러들과 같은 규약: 원문 영어 사유를 돌려주고 한국어 문구는
  // 패널이 만든다. 진행 중 거부는 정확히 `'job in flight'`다.
  DELETE_LIBRARY_ENTRY: { ok: true } | { ok: false; error: string };
```

파일 상단 import에 더한다:

```ts
import type { LibraryEntry } from './library';
```

- [ ] **Step 4: background 핸들러를 구현한다**

`entrypoints/background.ts`의 db import 구문에 더한다:

```ts
import {
  putVideo, getVideo, getTranslation, putTranslation, upsertBatch, getSummary, putSummary,
  listTranslationDigests, getAllVideos, getAllSummaries, deleteVideoData,
} from '~/lib/db';
import { thumbnailUrlFor } from '~/lib/youtube';
import type { LibraryEntry } from '~/types/library';
```

`handle()`의 switch에서 `case 'SUMMARY_REFRESHED':` **앞에** 넣는다:

```ts
    case 'GET_LIBRARY': {
      // 목록의 기준 스토어는 `translations`다. `videos`를 기준으로 삼으면 안 된다 —
      // 그 스토어는 watch 페이지를 방문하기만 해도 VIDEO_DETECTED 핸들러가
      // 채우므로, 번역한 적 없는 영상이 목록에 섞인다. `videos`는 제목·썸네일을
      // 붙이기 위해 조인만 한다.
      const [digests, videos, summaries] = await Promise.all([
        listTranslationDigests(),
        getAllVideos(),
        getAllSummaries(),
      ]);
      const metaById = new Map(videos.map((meta) => [meta.videoId, meta]));
      const summaryById = new Map(summaries.map((summary) => [summary.videoId, summary]));

      const entries: LibraryEntry[] = digests.map((digest) => {
        const meta = metaById.get(digest.videoId);
        const summary = summaryById.get(digest.videoId);
        return {
          videoId: digest.videoId,
          // 메타가 없어도 행을 빠뜨리지 않는다 — videoId가 제목 자리를 대신한다.
          title: meta?.title ?? digest.videoId,
          channelName: meta?.channelName ?? null,
          thumbnailUrl: meta?.thumbnailUrl ?? thumbnailUrlFor(digest.videoId),
          durationSeconds: meta?.durationSeconds ?? null,
          status: digest.status,
          targetLang: digest.targetLang,
          segmentCount: digest.segmentCount,
          keywords: summary?.keywords ?? [],
          hasSummary: summary !== undefined,
          updatedAt: digest.updatedAt,
          // 두 맵 모두 이미 이 파일의 단일 진실이다 — 새 상태를 만들지 않는다.
          inFlight:
            inFlightTranslations.has(digest.videoId) || inFlightSummaries.has(digest.videoId),
        };
      });

      entries.sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.videoId.localeCompare(b.videoId),
      );
      return entries as AppResponseMap[T];
    }
    case 'DELETE_LIBRARY_ENTRY': {
      const { payload } = msg as Extract<AppMessage, { type: 'DELETE_LIBRARY_ENTRY' }>;
      // 패널도 `inFlight`로 trash를 비활성화하지만, 그 값은 목록을 읽은 시점의
      // 스냅샷이라 낡을 수 있다. 진짜 방어선은 여기다.
      if (
        inFlightTranslations.has(payload.videoId) ||
        inFlightSummaries.has(payload.videoId)
      ) {
        return { ok: false, error: 'job in flight' } as AppResponseMap[T];
      }
      await deleteVideoData(payload.videoId);
      return { ok: true } as AppResponseMap[T];
    }
```

`errorResponseFor`의 switch에 더한다(이 switch는 exhaustive라 빠뜨리면 타입 에러가 난다):

```ts
    case 'GET_LIBRARY':
      return [];
    case 'DELETE_LIBRARY_ENTRY':
      return { ok: false, error: message };
```

- [ ] **Step 5: 통과를 확인한다**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS 전부.

- [ ] **Step 6: 커밋**

```bash
git add src/types/message.ts entrypoints/background.ts src/background.test.ts
git commit -m "Serve the library list and per-video delete from background"
```

---

### Task 4: 검색·표시 순수 함수

**왜 순수 함수인가:** 이 저장소에는 컴포넌트 렌더 테스트 하니스가 없다
(`@testing-library` 미설치, `*.test.tsx` 0개). 결정 로직을 컴포넌트에 인라인하면
검증할 방법이 없다. `src/lib/playback-sync.ts`, `src/lib/summary.ts`가 같은 이유로
분리돼 있다.

**Files:**
- Create: `src/lib/library.ts`
- Test: `src/lib/library.test.ts`

**Interfaces:**
- Consumes: `LibraryEntry` (`~/types/library`), `formatTimestamp` (`~/lib/transcript-parse`),
  `TARGET_LANG_LABELS` (`~/lib/target-lang`)
- Produces:
  - `filterLibrary(entries: LibraryEntry[], query: string): LibraryEntry[]`
  - `matchedKeywords(entry: LibraryEntry, query: string): string[]`
  - `MAX_MATCHED_KEYWORDS: number`
  - `entryBadge(status: TranslationStatus): { tone: 'error' | 'warn' | 'muted'; label: string } | null`
  - `formatEntryMeta(entry: LibraryEntry, now: Date): string`
  - `formatCountLabel(shown: number, total: number): string`
  - `formatStorageLine(count: number, estimate: StorageEstimateLike | null): string`
  - `deleteErrorMessage(error: string): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/library.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LibraryEntry } from '~/types/library';
import {
  MAX_MATCHED_KEYWORDS,
  entryBadge,
  filterLibrary,
  formatCountLabel,
  formatEntryMeta,
  formatStorageLine,
  matchedKeywords,
} from './library';

function makeEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    videoId: 'abc123',
    title: 'Attention Is All You Need 해설',
    channelName: '어떤채널',
    thumbnailUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
    durationSeconds: 1334,
    status: 'done',
    targetLang: 'ko',
    segmentCount: 142,
    keywords: ['transformer', 'attention'],
    hasSummary: true,
    updatedAt: '2026-07-29T04:05:06.000Z',
    inFlight: false,
    ...overrides,
  };
}

describe('filterLibrary', () => {
  it('returns everything for an empty query', () => {
    const entries = [makeEntry(), makeEntry({ videoId: 'b' })];
    expect(filterLibrary(entries, '')).toEqual(entries);
  });

  it('returns everything for a whitespace-only query', () => {
    const entries = [makeEntry()];
    expect(filterLibrary(entries, '   ')).toEqual(entries);
  });

  it('matches a substring of the title', () => {
    const entries = [makeEntry({ videoId: 'a', title: 'Rust 비동기 런타임' }), makeEntry({ videoId: 'b', title: 'Go 스케줄러' })];
    expect(filterLibrary(entries, '비동기').map((e) => e.videoId)).toEqual(['a']);
  });

  it('matches a keyword even when the title does not contain it', () => {
    const entries = [
      makeEntry({ videoId: 'a', title: '제목에 없음', keywords: ['tokio'] }),
      makeEntry({ videoId: 'b', title: '제목에 없음', keywords: ['gRPC'] }),
    ];
    expect(filterLibrary(entries, 'tokio').map((e) => e.videoId)).toEqual(['a']);
  });

  it('ignores case on both sides', () => {
    const entries = [makeEntry({ title: 'Attention Is All You Need 해설' })];
    expect(filterLibrary(entries, 'ATTENTION')).toHaveLength(1);
    expect(filterLibrary([makeEntry({ title: 'x', keywords: ['Transformer'] })], 'transformer')).toHaveLength(1);
  });

  it('drops entries that match neither title nor keywords', () => {
    expect(filterLibrary([makeEntry()], '전혀없는말')).toEqual([]);
  });

  it('trims the query before comparing', () => {
    expect(filterLibrary([makeEntry({ title: 'Rust' })], '  rust  ')).toHaveLength(1);
  });
});

describe('matchedKeywords', () => {
  it('returns only the keywords that matched', () => {
    const entry = makeEntry({ keywords: ['tokio', 'executor', 'async'] });
    expect(matchedKeywords(entry, 'to')).toEqual(['tokio', 'executor']);
  });

  it('returns an empty array for an empty query', () => {
    expect(matchedKeywords(makeEntry(), '')).toEqual([]);
  });

  it('returns an empty array when only the title matched', () => {
    const entry = makeEntry({ title: 'Rust 런타임', keywords: ['tokio'] });
    expect(matchedKeywords(entry, 'rust')).toEqual([]);
  });

  it(`caps the result at ${MAX_MATCHED_KEYWORDS}`, () => {
    const entry = makeEntry({ keywords: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    expect(matchedKeywords(entry, 'a')).toHaveLength(MAX_MATCHED_KEYWORDS);
  });
});

describe('entryBadge', () => {
  it('has no badge for a finished translation', () => {
    expect(entryBadge('done')).toBeNull();
  });

  it('marks a failed translation', () => {
    expect(entryBadge('failed')).toEqual({ tone: 'error', label: '실패' });
  });

  it('marks a running translation', () => {
    expect(entryBadge('analyzing')).toEqual({ tone: 'warn', label: '진행 중' });
    expect(entryBadge('translating')).toEqual({ tone: 'warn', label: '진행 중' });
  });

  it('falls back to 미완료 for the statuses the pipeline never persists', () => {
    expect(entryBadge('idle')).toEqual({ tone: 'muted', label: '미완료' });
    expect(entryBadge('extracting')).toEqual({ tone: 'muted', label: '미완료' });
  });
});

describe('formatEntryMeta', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');

  it('joins channel, duration, language and date', () => {
    const entry = makeEntry({ channelName: '어떤채널', durationSeconds: 1334, updatedAt: '2026-07-29T04:05:06.000Z' });
    expect(formatEntryMeta(entry, now)).toBe('어떤채널 · 22:14 · 한국어 · 7월 29일');
  });

  it('omits the duration entirely when it is null', () => {
    // VideoMeta.durationSeconds의 null 규약: 0:00은 확신에 찬 거짓말이다.
    const entry = makeEntry({ durationSeconds: null });
    expect(formatEntryMeta(entry, now)).toBe('어떤채널 · 한국어 · 7월 29일');
  });

  it('omits the channel when it is null', () => {
    const entry = makeEntry({ channelName: null });
    expect(formatEntryMeta(entry, now)).toBe('22:14 · 한국어 · 7월 29일');
  });

  it('spells out the year for an entry from another year', () => {
    const entry = makeEntry({ updatedAt: '2025-12-31T04:00:00.000Z' });
    expect(formatEntryMeta(entry, now)).toContain('2025년 12월 31일');
  });

  it('uses the record language, not always Korean', () => {
    expect(formatEntryMeta(makeEntry({ targetLang: 'ja' }), now)).toContain('일본어');
  });
});

describe('formatCountLabel', () => {
  it('shows just the total when nothing is filtered out', () => {
    expect(formatCountLabel(12, 12)).toBe('12편');
  });

  it('shows shown / total while searching', () => {
    expect(formatCountLabel(3, 12)).toBe('3 / 12편');
  });
});

describe('formatStorageLine', () => {
  it('shows the count with usage and quota', () => {
    expect(formatStorageLine(12, { usage: 2202009, quota: 10995116277 })).toBe(
      '영상 12편 · 2.1 MB / 10.2 GB',
    );
  });

  it('falls back to the count alone when the estimate is unavailable', () => {
    expect(formatStorageLine(12, null)).toBe('영상 12편');
  });

  it('falls back to the count alone when the estimate has no numbers', () => {
    expect(formatStorageLine(12, {})).toBe('영상 12편');
  });
});

describe('deleteErrorMessage', () => {
  it('explains the in-flight refusal in the user\'s own terms', () => {
    expect(deleteErrorMessage('job in flight')).toBe(
      '진행 중이라 지울 수 없어요. 끝난 뒤에 다시 시도해주세요',
    );
  });

  it('falls back for any other reason rather than claiming a wrong cause', () => {
    expect(deleteErrorMessage('some IDB failure')).toBe('지우지 못했어요. 다시 시도해주세요');
  });
});
```

위 import 구문에 `deleteErrorMessage`도 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/lib/library.test.ts`
Expected: FAIL — `Failed to resolve import "./library"`.

- [ ] **Step 3: 구현한다**

`src/lib/library.ts`:

```ts
// 라이브러리 뷰(spec 2026-08-01)의 결정·표시 로직 전부. 이 저장소에는 컴포넌트
// 렌더 테스트 하니스가 없으므로(@testing-library 미설치), `LibraryView`가 내리는
// 판단은 하나도 컴포넌트 안에 두지 않고 여기에서 테스트한다 —
// `playback-sync.ts`/`summary.ts`와 같은 규율이다.
import { TARGET_LANG_LABELS } from '~/lib/target-lang';
import { formatTimestamp } from '~/lib/transcript-parse';
import type { LibraryEntry } from '~/types/library';
import type { TranslationStatus } from '~/types/transcript';

/** 검색어와 제목/키워드를 같은 방식으로 정규화한다. */
function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function matches(entry: LibraryEntry, needle: string): boolean {
  if (entry.title.toLowerCase().includes(needle)) return true;
  return entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle));
}

/**
 * 제목 **또는** 요약 키워드 부분일치. 채널명과 자막 본문은 대상이 아니다 —
 * spec §2가 검색 기준을 이 둘로 못박았다.
 *
 * 디바운스하지 않는다: 대상이 로컬 배열 수십 건이라 입력마다 다시 훑어도 무시할
 * 수 있는 비용이고, 디바운스는 타이핑에 지연만 더한다.
 */
export function filterLibrary(entries: LibraryEntry[], query: string): LibraryEntry[] {
  const needle = normalize(query);
  if (needle === '') return entries;
  return entries.filter((entry) => matches(entry, needle));
}

export const MAX_MATCHED_KEYWORDS = 3;

/**
 * 이 행이 검색어에 걸린 이유가 키워드였다면 그 키워드들. 목록 행에 키워드가 평소
 * 보이지 않기 때문에, 이게 없으면 제목과 무관해 보이는 결과가 이유 없이 튀어나온
 * 것처럼 읽힌다.
 */
export function matchedKeywords(entry: LibraryEntry, query: string): string[] {
  const needle = normalize(query);
  if (needle === '') return [];
  return entry.keywords
    .filter((keyword) => keyword.toLowerCase().includes(needle))
    .slice(0, MAX_MATCHED_KEYWORDS);
}

export interface EntryBadge {
  tone: 'error' | 'warn' | 'muted';
  label: string;
}

/**
 * `done`은 정상이라 뱃지를 달지 않는다 — 목록 대부분이 done이므로 전부에 뱃지를
 * 달면 신호가 사라진다.
 */
export function entryBadge(status: TranslationStatus): EntryBadge | null {
  if (status === 'done') return null;
  if (status === 'failed') return { tone: 'error', label: '실패' };
  if (status === 'analyzing' || status === 'translating') return { tone: 'warn', label: '진행 중' };
  return { tone: 'muted', label: '미완료' };
}

function formatEntryDate(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) return `${month}월 ${day}일`;
  return `${date.getFullYear()}년 ${month}월 ${day}일`;
}

/**
 * 행의 둘째 줄. 값이 없는 조각은 자리를 비우는 게 아니라 **통째로 뺀다** —
 * `durationSeconds`가 `null`일 때 `0:00`을 그리는 것은 `VideoMeta`의 문서화된
 * 규약이 금지하는 "확신에 찬 거짓말"이다.
 */
export function formatEntryMeta(entry: LibraryEntry, now: Date): string {
  const parts: string[] = [];
  if (entry.channelName !== null && entry.channelName !== '') parts.push(entry.channelName);
  if (entry.durationSeconds !== null) parts.push(formatTimestamp(entry.durationSeconds));
  parts.push(TARGET_LANG_LABELS[entry.targetLang]);
  const date = formatEntryDate(entry.updatedAt, now);
  if (date !== '') parts.push(date);
  return parts.join(' · ');
}

export function formatCountLabel(shown: number, total: number): string {
  return shown === total ? `${total}편` : `${shown} / ${total}편`;
}

/** `navigator.storage.estimate()`의 결과 중 이 화면이 쓰는 부분만. */
export interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 목록 하단 한 줄. `usage`는 이 확장 오리진 **전체**의 사용량이라 번역본 외의
 * 것도 포함한다 — 그래서 "영상 N편이 M MB"처럼 인과로 묶지 않고 `·`로 나열한다.
 * 추정치를 못 얻으면 편수만 말한다.
 */
export function formatStorageLine(count: number, estimate: StorageEstimateLike | null): string {
  const head = `영상 ${count}편`;
  if (estimate === null) return head;
  const { usage, quota } = estimate;
  if (typeof usage !== 'number' || typeof quota !== 'number') return head;
  return `${head} · ${formatBytes(usage)} / ${formatBytes(quota)}`;
}

/**
 * 삭제 실패 사유를 사용자 문구로. background는 원문 영어 사유를 돌려주고 한국어
 * 문구는 패널이 만든다 — `translationErrorDisplay`와 같은 규약이다. 사유를
 * 구분하는 이유: 실패를 전부 "진행 중이라"로 표시하면 DB 오류일 때 사용자에게
 * 틀린 원인을 알려주게 된다.
 */
export function deleteErrorMessage(error: string): string {
  if (error === 'job in flight') return '진행 중이라 지울 수 없어요. 끝난 뒤에 다시 시도해주세요';
  return '지우지 못했어요. 다시 시도해주세요';
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/lib/library.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/library.ts src/lib/library.test.ts
git commit -m "Add the library view's search and row-formatting decisions as pure functions"
```

---

### Task 5: 목록 화면과 패널 배선

이 태스크가 끝나면 기능이 **실제 크롬에서 처음 보인다** — 목록, 검색, 사용량,
항목 클릭까지. 삭제는 Task 6이다.

**Files:**
- Create: `src/components/LibraryView.tsx`
- Modify: `entrypoints/sidepanel/App.tsx` (헤더 152-170행 영역, 본문 분기 172-190행 영역)

**Interfaces:**
- Consumes: Task 3의 `GET_LIBRARY`, Task 4의 `filterLibrary`/`matchedKeywords`/
  `entryBadge`/`formatEntryMeta`/`formatCountLabel`/`formatStorageLine`
- Produces: `LibraryView({ onOpenVideo }: { onOpenVideo: (videoId: string) => void })`

- [ ] **Step 1: 컴포넌트를 만든다**

`src/components/LibraryView.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { StatusBadge } from '~/components/StatusBadge';
import {
  entryBadge,
  filterLibrary,
  formatCountLabel,
  formatEntryMeta,
  formatStorageLine,
  matchedKeywords,
  type StorageEstimateLike,
} from '~/lib/library';
import { sendMessage } from '~/lib/messaging';
import type { LibraryEntry } from '~/types/library';

/**
 * 지금까지 자막을 만든 영상 목록 (spec 2026-08-01). 이 컴포넌트는 판단을 하지
 * 않는다 — 필터·뱃지·표기 결정은 전부 `~/lib/library`의 순수 함수가 내리고
 * 여기서는 그 결과를 그린다. 이 저장소에 컴포넌트 렌더 테스트 하니스가 없기
 * 때문에 세운 규율이다.
 */
export function LibraryView({ onOpenVideo }: { onOpenVideo: (videoId: string) => void }) {
  // `null` = 아직 안 불러옴. 빈 배열(정말 하나도 없음)과 구분해야 빈 상태 문구를
  // 로딩 중에 잘못 띄우지 않는다.
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [storage, setStorage] = useState<StorageEstimateLike | null>(null);

  useEffect(() => {
    let cancelled = false;
    void sendMessage({ type: 'GET_LIBRARY' }).then((list) => {
      if (!cancelled) setEntries(list);
    });
    // 사이드패널은 확장과 같은 오리진이라 background를 경유할 이유가 없다.
    // 거부되면 편수만 보여준다 (formatStorageLine이 null을 그렇게 다룬다).
    void navigator.storage
      ?.estimate()
      .then((estimate) => {
        if (!cancelled) setStorage(estimate);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 날짜 표기가 "올해면 연도 생략"이라 기준 시각이 필요하다. 마운트 시점에 한 번
  // 고정한다 — 렌더마다 new Date()를 만들면 useMemo가 매번 무효화된다.
  const now = useMemo(() => new Date(), []);
  const shown = useMemo(() => (entries === null ? [] : filterLibrary(entries, query)), [entries, query]);

  if (entries === null) {
    return <p className="p-6 text-sm text-neutral-500 dark:text-neutral-400">불러오는 중…</p>;
  }

  if (entries.length === 0) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 pt-10 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">아직 저장한 영상이 없어요</p>
        <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          유튜브 영상에서 AI 자막을 만들면 여기에 쌓입니다
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 pt-4">
        <h2 className="text-sm font-semibold">저장한 영상</h2>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {formatCountLabel(shown.length, entries.length)}
        </span>
      </div>

      <div className="px-4 pt-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="제목이나 키워드로 검색"
          aria-label="저장한 영상 검색"
          className="w-full rounded-[7px] border border-neutral-200 bg-white px-3 py-2 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
        />
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
          검색 결과가 없어요
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900">
          {shown.map((entry) => (
            <LibraryRow
              key={entry.videoId}
              entry={entry}
              query={query}
              now={now}
              onOpen={() => onOpenVideo(entry.videoId)}
            />
          ))}
        </ul>
      )}

      <p className="px-4 py-4 text-[10.5px] text-neutral-500 dark:text-neutral-400">
        {formatStorageLine(entries.length, storage)}
      </p>
    </div>
  );
}

function LibraryRow({
  entry,
  query,
  now,
  onOpen,
}: {
  entry: LibraryEntry;
  query: string;
  now: Date;
  onOpen: () => void;
}) {
  const badge = entryBadge(entry.status);
  const keywords = matchedKeywords(entry, query);

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <img
          src={entry.thumbnailUrl}
          alt=""
          width={64}
          height={36}
          className="mt-0.5 h-9 w-16 shrink-0 rounded object-cover"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className="line-clamp-2 text-[12.5px] font-medium leading-snug text-neutral-900 dark:text-neutral-100">
              {entry.title}
            </span>
            {badge !== null && (
              <span className="shrink-0">
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
              </span>
            )}
          </span>
          <span className="mt-1 block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
            {formatEntryMeta(entry, now)}
          </span>
          {keywords.length > 0 && (
            <span className="mt-1 block truncate text-[11px] text-neutral-600 dark:text-neutral-300">
              {keywords.join(' · ')}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
```

- [ ] **Step 2: 패널을 배선한다**

`entrypoints/sidepanel/App.tsx`:

import에 더한다:

```ts
import { LibraryView } from '~/components/LibraryView';
```

`App()` 안, `scrollContainerRef` 선언 아래에 더한다:

```ts
  // 패널의 최상위 뷰 (spec 2026-08-01 §3). 라이브러리를 열면 아래 본문 분기가
  // ReadyBody를 언마운트하고, 닫으면 새로 마운트한다 — 그래서 라이브러리에서
  // 지운 영상으로 돌아왔을 때 별도의 무효화 배관 없이 패널이 스스로 다시 읽는다.
  // 대가는 §11에 있다: 번역이 도는 중에 다녀오면 진행률 퍼센트가 다음 progress
  // 이벤트까지 최대 ~15초 비어 보인다. "번역 중"이라는 상태 자체는 저장된
  // 레코드에서 즉시 복원되고(useTranslation의 shouldResume), 다시 보내는
  // START_TRANSLATION은 background의 inFlightTranslations 중복 방지에 걸려 잡을
  // 새로 시작하지 않는다.
  const [view, setView] = useState<'video' | 'library'>('video');
```

`ready` 계산 아래에 더한다:

```ts
  // 라이브러리는 유튜브 탭이 아니어도 열려야 한다 — 이 화면의 주 용도가 "지금
  // 보고 있지 않은 영상 찾기"다. 그래서 `ready`가 아니라 `present`가 조건이다.
  const canOpenLibrary = present;

  // 목록에서 고른 영상으로 이동한다. 활성 탭이 유튜브면 그 탭을 옮기고(탭이
  // 쌓이지 않는다), 아니면 새 탭을 연다. 유튜브가 아닌 탭에서는 host_permission이
  // 없어 `tab.url`이 undefined로 오는데, 그 경우도 새 탭 경로라 동작이 옳다.
  // tabs.update/tabs.create 모두 "tabs" 권한을 요구하지 않는다.
  const openVideo = (videoId: string) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== undefined && classifyYoutubeUrl(tab.url) !== 'other') {
        void chrome.tabs.update(tab.id, { url });
      } else {
        void chrome.tabs.create({ url });
      }
      setView('video');
    });
  };
```

헤더의 `{ready && <DownloadMenu />}` **앞에** 라이브러리 버튼을 넣고, 내려받기는
라이브러리 뷰에서 숨긴다:

```tsx
          {canOpenLibrary && (
            <button
              type="button"
              onClick={() => setView(view === 'library' ? 'video' : 'library')}
              aria-label={view === 'library' ? '뒤로' : '저장한 영상'}
              className="rounded p-1 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              {view === 'library' ? <BackIcon /> : <LibraryIcon />}
            </button>
          )}
          {ready && view === 'video' && <DownloadMenu />}
```

본문 분기(현재 172-190행)를 통째로 아래로 교체한다. 기존 두 갈래는 글자 하나
바뀌지 않았고, 앞에 라이브러리 갈래만 붙었다:

```tsx
      {view === 'library' ? (
        <div className="panel-scrollbar flex-1 overflow-auto">
          <LibraryView onOpenVideo={openVideo} />
        </div>
      ) : ready ? (
        <div ref={scrollContainerRef} className="panel-scrollbar flex-1 overflow-auto">
          <ReadyBody scrollContainerRef={scrollContainerRef} />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6">
          {loading ? (
            <LoadingBody />
          ) : !present ? (
            <OnboardingBody />
          ) : pageKind === 'shorts' ? (
            <UnsupportedBanner reason="shorts" />
          ) : pageKind === 'live' ? (
            <UnsupportedBanner reason="live" />
          ) : (
            <NonYoutubeBody />
          )}
        </div>
      )}
```

파일 하단, `GearIcon` 옆에 아이콘 둘을 더한다(`GearIcon`이 있는 자리를 찾아 그
옆에 둔다):

```tsx
/** 헤더의 GearIcon/DownloadIcon과 같은 방식의 인라인 SVG — 아이콘 라이브러리를
 * 추가하지 않는다. */
function LibraryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h10" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}
```

- [ ] **Step 3: 테스트와 타입을 확인한다**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS 전부 — 이 태스크는 새 순수 로직을 만들지 않으므로 새 단위 테스트가
없다. 검증은 컨트롤러가 실제 크롬(CDP)에서 한다.

- [ ] **Step 4: 빌드가 되는지 확인한다**

Run: `npx wxt build`
Expected: 성공, `.output/chrome-mv3` 생성.

- [ ] **Step 5: 커밋**

```bash
git add src/components/LibraryView.tsx entrypoints/sidepanel/App.tsx
git commit -m "Show the videos we've already translated, searchable by title or keyword"
```

---

### Task 6: 삭제

**Files:**
- Modify: `src/components/LibraryView.tsx`

**Interfaces:**
- Consumes: Task 3의 `DELETE_LIBRARY_ENTRY`, Task 5의 `LibraryRow`

- [ ] **Step 1: 목록 쪽 상태를 더한다**

`LibraryView`의 `storage` state 아래에 더한다:

```tsx
  // 한 번에 한 행만 확인 상태다 — 다른 행의 휴지통을 누르면 이전 확인은 닫힌다.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ videoId: string; message: string } | null>(null);
```

삭제 핸들러를 `now` 선언 아래에 더한다:

```tsx
  const remove = async (videoId: string) => {
    setFailure(null);
    const res = await sendMessage({ type: 'DELETE_LIBRARY_ENTRY', payload: { videoId } });
    setConfirmingId(null);
    if (res.ok) {
      // 낙관적 제거가 아니라 응답 이후 제거다 — 전체 재조회는 필요 없다.
      setEntries((prev) => (prev === null ? prev : prev.filter((e) => e.videoId !== videoId)));
      return;
    }
    // 가장 흔한 실패는 진행 중 거부다(background가 `job in flight`로 답한다).
    // 목록은 그대로 두고 그 행에만 사유를 띄운다.
    setFailure({ videoId, message: deleteErrorMessage(res.error) });
  };
```

import 구문에 `deleteErrorMessage`를 더한다.

`LibraryRow` 호출에 prop을 더한다:

```tsx
              confirming={confirmingId === entry.videoId}
              failedMessage={failure?.videoId === entry.videoId ? failure.message : null}
              onAskDelete={() => setConfirmingId(entry.videoId)}
              onCancelDelete={() => setConfirmingId(null)}
              onConfirmDelete={() => void remove(entry.videoId)}
```

- [ ] **Step 2: `LibraryRow`를 통째로 교체한다**

Task 5의 `LibraryRow`를 아래로 **전부 대체한다** — `<li>`가 이제 세로로 쌓이는
컨테이너가 되어(확인 줄이 행 아래에 붙는다) 기존 마크업을 부분 수정하는 것보다
전체 교체가 안전하다.

```tsx
function LibraryRow({
  entry,
  query,
  now,
  confirming,
  failedMessage,
  onOpen,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  entry: LibraryEntry;
  query: string;
  now: Date;
  confirming: boolean;
  failedMessage: string | null;
  onOpen: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const badge = entryBadge(entry.status);
  const keywords = matchedKeywords(entry, query);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 확인 단계에 들어가면 포커스를 [취소]로 보낸다. [삭제]에 두면 엔터를 한 번 더
  // 누르는 것만으로 지워지는데, 이 삭제는 되돌릴 수 없고 재생성에 5~8분과 Gemini
  // 호출이 다시 든다.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <img
            src={entry.thumbnailUrl}
            alt=""
            width={64}
            height={36}
            className="mt-0.5 h-9 w-16 shrink-0 rounded object-cover"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-start gap-2">
              <span className="line-clamp-2 text-[12.5px] font-medium leading-snug text-neutral-900 dark:text-neutral-100">
                {entry.title}
              </span>
              {badge !== null && (
                <span className="shrink-0">
                  <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                </span>
              )}
            </span>
            <span className="mt-1 block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              {formatEntryMeta(entry, now)}
            </span>
            {keywords.length > 0 && (
              <span className="mt-1 block truncate text-[11px] text-neutral-600 dark:text-neutral-300">
                {keywords.join(' · ')}
              </span>
            )}
          </span>
        </button>

        {entry.inFlight ? (
          // 진행 중에는 지울 수 없다 — 번역 도중 레코드가 사라지면 다음
          // upsertBatch가 트랜잭션을 abort시켜 파이프라인이 이유 없이 죽는다.
          // background도 같은 검사를 독립적으로 한다(이 값은 목록을 읽은 시점의
          // 스냅샷이라 낡을 수 있다).
          <span
            className="shrink-0 p-1 text-neutral-300 dark:text-neutral-700"
            title="진행 중에는 지울 수 없어요"
            aria-label="진행 중에는 지울 수 없어요"
          >
            <TrashIcon />
          </span>
        ) : (
          <button
            type="button"
            onClick={onAskDelete}
            aria-label="자막 삭제"
            className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {confirming && (
        // Escape를 이 컨테이너에서 받는다 — 키 이벤트가 버블링되므로 [삭제]에
        // 포커스가 가 있어도 동작한다.
        <div
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancelDelete();
          }}
          className="mt-2 flex items-center justify-between gap-2 rounded-[7px] bg-neutral-50 px-3 py-2 dark:bg-neutral-900"
        >
          <span className="text-[11px] text-neutral-700 dark:text-neutral-300">
            이 영상의 자막을 지울까요?
          </span>
          <span className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={onConfirmDelete}
              className="rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
            >
              삭제
            </button>
            <button
              type="button"
              ref={cancelRef}
              onClick={onCancelDelete}
              className="rounded px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              취소
            </button>
          </span>
        </div>
      )}

      {failedMessage !== null && (
        <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{failedMessage}</p>
      )}
    </li>
  );
}
```

파일 하단에 아이콘을 더한다:

```tsx
/** 헤더 아이콘들과 같은 방식의 인라인 SVG. */
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

`react` import를 `import { useEffect, useMemo, useRef, useState } from 'react';`로
고친다.

- [ ] **Step 3: 테스트와 타입을 확인한다**

Run: `npx vitest run && npx tsc --noEmit && npx wxt build`
Expected: PASS 전부, 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add src/components/LibraryView.tsx
git commit -m "Let the library delete a video's captions, with an inline confirm step"
```

---

### Task 7: README 경고 문구

**Files:**
- Modify: `README.md` (설치 §2 "압축 풀기")

- [ ] **Step 1: 문구를 고친다**

현재 문장:

```
내려받은 zip의 압축을 풉니다. **압축을 푼 폴더는 앞으로 계속 그 자리에
있어야 합니다.** 나중에 폴더를 지우거나 옮기면 확장 프로그램이 사라집니다.
```

이렇게 바꾼다:

```
내려받은 zip의 압축을 풉니다. **압축을 푼 폴더는 앞으로 계속 그 자리에
있어야 합니다.** 나중에 폴더를 지우거나 옮기면 확장 프로그램이 사라질 뿐
아니라, **그때까지 만들어 둔 번역본과 요약을 전부 잃습니다** — 크롬이 폴더
위치로 확장을 구분하기 때문에, 옮긴 폴더는 아예 다른 확장으로 취급되어 이전
데이터에 접근할 수 없습니다.
```

- [ ] **Step 2: 개인정보 절에 한 줄 더한다**

"## 개인정보" 절의 마지막 항목 뒤에 붙인다:

```
- 저장된 번역본은 크롬의 「인터넷 사용 기록 삭제」로는 지워지지 않습니다. 그
  기능은 웹사이트 데이터만 지우고 확장 프로그램의 저장소는 건드리지 않습니다.
  지우려면 사이드패널의 **저장한 영상** 목록에서 영상별로 지우면 됩니다.
```

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "docs: moving the extension folder loses every translation, not just the extension"
```

---

## 마무리 검증 (컨트롤러가 실제 크롬에서 수행)

단위 테스트로는 닿지 않는 것들이다. 확장을 빌드해 dev 프로필에 리로드한 뒤 CDP로
확인한다. 스펙 §13의 목록과 같다.

1. 헤더 아이콘 클릭 → 목록이 뜨고 저장된 영상이 전부 보인다
2. 제목 일부로 검색 → 해당 행만 남고 카운트가 `N / M편`이 된다
3. **제목에 없는 요약 키워드**로 검색 → 그 영상이 나오고 키워드 줄이 보인다
4. 휴지통 → 확인 → 취소 → IndexedDB가 그대로다
5. 휴지통 → 확인 → 삭제 → 행이 사라지고, `translations`·`summaries`에서 함께
   사라지고, `videos`는 남아 있다
6. 진행 중인 영상(CDP `Fetch` 인터셉트로 Gemini 요청을 붙잡아 잡을 고정) → 휴지통이
   비활성이고, background에 직접 `DELETE_LIBRARY_ENTRY`를 보내도
   `{ ok: false, error: 'job in flight' }`로 거부되며 레코드가 남는다
7. 항목 클릭 → 활성 유튜브 탭이 그 영상으로 이동하고 패널이 그 영상 화면이 된다
8. 번역 진행 중 라이브러리를 열었다 돌아오면 "번역 중" 상태가 유지된다
9. 삭제한 영상으로 돌아가면 패널이 "AI 자막 생성" 이전 상태다
10. `geminiApiKeySavedAt === '2026-07-28T07:15:51.622Z'`,
    `permissions === ["storage","sidePanel"]` 불변
