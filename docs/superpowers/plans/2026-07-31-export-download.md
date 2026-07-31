# 내려받기 (Markdown / PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드패널 헤더의 ⬇ 버튼으로, 현재 영상의 번역 스크립트와 요약을 Markdown 파일로 즉시 저장하거나 인쇄 페이지를 열어 PDF로 저장한다.

**Architecture:** 문서 조립은 `src/lib/export-doc.ts`의 순수 함수 하나로 모으고, 패널(Markdown)과 인쇄 페이지(PDF)가 **같은 모델**을 소비한다. 데이터는 background가 소유한 IndexedDB에서 `GET_VIDEO_META`/`GET_TRANSLATION`/`GET_SUMMARY` 세 요청으로만 읽으며, 두 소비자가 `fetchExportData(videoId)` 하나를 공유한다. PDF는 라이브러리 없이 확장 페이지 + `window.print()`로 만든다.

**Tech Stack:** WXT 0.19 · React 18 · TypeScript · Tailwind 3 · vitest + fake-indexeddb. **새 런타임 의존성 없음.**

설계 근거: `docs/superpowers/specs/2026-07-31-export-download-design.md`

## Global Constraints

- **새 권한을 추가하지 않는다.** `manifest.permissions`는 `['storage', 'sidePanel']` 그대로. `downloads`, `tabs` 모두 추가 금지. `host_permissions`도 무변경.
- **새 npm 의존성을 추가하지 않는다.** `npm install`을 실행하지 않는다. `package-lock.json`을 만들지 않는다(레포에 없음 — 생기면 커밋 전에 삭제).
- **DB 직접 접근 금지.** 패널·Options·export 페이지는 `~/lib/db`를 import하지 않는다. 데이터는 `~/lib/messaging`의 `sendMessage`로만 읽는다. `~/lib/db`를 쓰는 곳은 `entrypoints/background.ts`뿐이다.
- **외부 전송 없음.** 이 기능은 Gemini를 포함한 어떤 네트워크 호출도 추가하지 않는다.
- **Rules of Hooks:** React 컴포넌트/훅의 모든 hook 호출은 어떤 early return보다 위에 있어야 한다. 조건부 hook 호출 금지.
- **`.env.local`, `.chrome-dev-profile/`, `.chrome-dev-output/`, `.output/`을 읽거나 수정하지 않는다. `scripts/dev-chrome.mjs`를 실행하지 않는다.**
- 사용자 문구는 한국어. 기존 패널 카피 톤(`다시 생성`, `번역 완료 후…`)을 따른다.
- 매 태스크 종료 조건: `npx tsc --noEmit` 0 errors · `npx vitest run` 전부 통과 · `npm run build` 성공.
- 기준 커밋: `2bc2a07` (스펙 커밋). 시작 시 테스트 375 passed가 baseline.

---

### Task 1: `GET_VIDEO_META` 메시지 + background 핸들러

videoId로 캐시된 비디오 메타를 읽는 요청. 기존 `GET_CURRENT_VIDEO`는 tabId 기반이라 유튜브 탭이 아닌 곳(`export.html`)에서 쓸 수 없다.

**Files:**
- Modify: `src/types/message.ts` (AppMessage 유니온 + AppResponseMap + `errorResponseFor`가 참조하는 스위치는 background에 있음)
- Modify: `entrypoints/background.ts` (`handle()` 스위치 + `errorResponseFor()` 스위치)
- Test: `src/background.test.ts`

**Interfaces:**
- Consumes: `getVideo(videoId): Promise<VideoMeta | null>` (`~/lib/db`, 이미 존재)
- Produces: `{ type: 'GET_VIDEO_META'; payload: { videoId: string } }` → `VideoMeta | null`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/background.test.ts` 맨 끝에 추가한다. 파일 상단 import에 `VIDEO_DETECTED` 테스트가 이미 쓰는 `getVideo`가 있으므로 추가 import는 필요 없다.

```ts
describe('GET_VIDEO_META', () => {
  it('returns the cached VideoMeta for a videoId', async () => {
    const tabId = freshTabId();
    await handle(
      { type: 'VIDEO_DETECTED', payload: { status: 'settled', meta: SETTLED_META } },
      senderFor(tabId),
    );

    const res = await handle(
      { type: 'GET_VIDEO_META', payload: { videoId: SETTLED_META.videoId } },
      senderFor(undefined),
    );

    expect(res).not.toBeNull();
    expect((res as { title: string }).title).toBe(SETTLED_META.title);
    expect((res as { videoId: string }).videoId).toBe(SETTLED_META.videoId);
  });

  it('returns null for a videoId that was never cached', async () => {
    const res = await handle(
      { type: 'GET_VIDEO_META', payload: { videoId: 'nEvErSeEn11' } },
      senderFor(undefined),
    );

    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/background.test.ts`
Expected: FAIL — `handle()`의 스위치가 `GET_VIDEO_META`를 모르므로 타입 에러 또는 throw.

- [ ] **Step 3: 메시지 타입 추가**

`src/types/message.ts`의 `AppMessage` 유니온에서 `GET_SUMMARY` 바로 아래에 추가:

```ts
  // panel/export page -> background: read the cached VideoMeta by videoId.
  // Deliberately videoId-scoped, unlike the tabId-scoped GET_CURRENT_VIDEO:
  // the export page (export.html) is its own tab and has no YouTube tabId to
  // ask about, and both surfaces must read the SAME record or the exported
  // document would disagree with the panel. `null` follows GET_TRANSLATION's
  // convention — nothing cached for this video yet.
  | { type: 'GET_VIDEO_META'; payload: { videoId: string } }
```

`AppResponseMap`에서 `GET_SUMMARY` 아래에 추가:

```ts
  GET_VIDEO_META: VideoMeta | null;
```

`VideoMeta`가 이 파일에 아직 import되어 있지 않으면 `import type { VideoMeta } from '~/types/video';`를 파일 상단 import 블록에 추가한다(이미 있으면 그대로 둔다).

- [ ] **Step 4: background 핸들러 추가**

`entrypoints/background.ts`의 `handle()` 스위치에서 `case 'GET_SUMMARY'` 바로 위에 추가:

```ts
    case 'GET_VIDEO_META': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_VIDEO_META' }>;
      return (await getVideo(payload.videoId)) as AppResponseMap[T];
    }
```

같은 파일의 `errorResponseFor()` 스위치에서 `case 'GET_SUMMARY':` 위에 추가:

```ts
    case 'GET_VIDEO_META':
      return null;
```

파일 상단의 `~/lib/db` import에 `getVideo`를 추가한다(현재 `putVideo, getTranslation, putTranslation, upsertBatch, getSummary, putSummary`).

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/background.test.ts`
Expected: PASS (신규 2개 포함)

- [ ] **Step 6: 전체 검증 + 커밋**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add src/types/message.ts entrypoints/background.ts src/background.test.ts
git commit -m "feat(bg): add GET_VIDEO_META message for videoId-scoped meta reads"
```

---

### Task 2: `src/lib/export-doc.ts` — 순수 문서 빌더

이 기능의 로직 전부와 안전망 전부가 여기 있다. chrome API도 DOM도 쓰지 않는다.

**Files:**
- Create: `src/lib/export-doc.ts`
- Test: `src/lib/export-doc.test.ts`

**Interfaces:**
- Consumes: `formatTimestamp(totalSeconds: number): string` (`~/lib/transcript-parse`), `TARGET_LANG_LABELS: Record<TargetLang, string>` (`~/lib/target-lang`), `DisplayMode = 'both' | 'ko'` (`~/components/TranscriptList`), `TranslationRecord`/`TranscriptSegment` (`~/types/transcript`), `VideoSummary` (`~/types/summary`), `VideoMeta` (`~/types/video`)
- Produces:
  - `buildExportModel(input: ExportInput): ExportModel`
  - `renderMarkdown(model: ExportModel): string`
  - `buildFileBaseName(title: string, videoId: string): string`
  - 타입 `ExportInput`, `ExportModel`, `ExportSegmentLine` (Task 3·4·5가 import한다)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/export-doc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildExportModel, buildFileBaseName, renderMarkdown } from './export-doc';
import type { ExportInput } from './export-doc';
import type { TranslationRecord, TranscriptSegment } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import type { VideoMeta } from '~/types/video';

const VIDEO_ID = 'zjkBMFhNj_g';
const EXPORTED_AT = new Date('2026-07-31T19:20:00+09:00');

const VIDEO: VideoMeta = {
  videoId: VIDEO_ID,
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  title: 'Intro to Large Language Models',
  channelName: 'Andrej Karpathy',
  thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  durationSeconds: 3588,
  captionAvailability: 'auto-only',
  fetchedAt: '2026-07-31T10:00:00.000Z',
};

function seg(index: number, startSec: number, sourceText: string, translatedText: string | null): TranscriptSegment {
  return {
    segmentId: `${VIDEO_ID}:${index}`,
    videoId: VIDEO_ID,
    index,
    startSec,
    endSec: startSec + 10,
    sourceText,
    translatedText,
  };
}

const RECORD: TranslationRecord = {
  videoId: VIDEO_ID,
  captionHash: 'hash',
  sourceLang: 'en',
  status: 'done',
  segments: [
    seg(0, 12, "Let's talk about vector search.", '벡터 검색에 대해 이야기해 봅시다.'),
    seg(1, 3671, 'Embeddings map text to coordinates.', '임베딩은 텍스트를 좌표로 바꿉니다.'),
  ],
  glossary: [],
  completedBatches: 1,
  totalBatches: 1,
  targetLang: 'ko',
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T10:05:00.000Z',
};

const SUMMARY: VideoSummary = {
  videoId: VIDEO_ID,
  purpose: '대규모 언어 모델의 동작 원리를 개괄한다.',
  mainArguments: ['모델은 다음 토큰을 예측한다.', '정렬 단계가 유용성을 만든다.'],
  sections: [{ startSec: 12, title: '도입' }, { startSec: 600, title: '학습 과정' }],
  keywords: ['LLM', '토크나이저'],
  conclusion: '사전학습과 정렬을 나눠 이해하라.',
  model: 'gemini-x',
  targetLang: 'ko',
  createdAt: '2026-07-31T10:10:00.000Z',
};

function input(over: Partial<ExportInput> = {}): ExportInput {
  return { video: VIDEO, record: RECORD, summary: SUMMARY, displayMode: 'both', exportedAt: EXPORTED_AT, ...over };
}

describe('buildFileBaseName', () => {
  it('joins a sanitized title with the videoId', () => {
    expect(buildFileBaseName('Intro to LLMs', VIDEO_ID)).toBe(`Intro_to_LLMs_${VIDEO_ID}`);
  });

  it('replaces filesystem-forbidden characters but keeps hyphens and Hangul', () => {
    expect(buildFileBaseName('a/b:c*d?e"f<g>h|i', VIDEO_ID)).toBe(`a_b_c_d_e_f_g_h_i_${VIDEO_ID}`);
    expect(buildFileBaseName('벡터-검색 입문', VIDEO_ID)).toBe(`벡터-검색_입문_${VIDEO_ID}`);
  });

  it('truncates the title part to 80 chars and always keeps the full videoId', () => {
    const name = buildFileBaseName('x'.repeat(200), VIDEO_ID);
    expect(name).toBe(`${'x'.repeat(80)}_${VIDEO_ID}`);
    expect(name.endsWith(VIDEO_ID)).toBe(true);
  });

  it('falls back to the videoId alone when nothing survives sanitizing', () => {
    expect(buildFileBaseName('///', VIDEO_ID)).toBe(VIDEO_ID);
    expect(buildFileBaseName('   ', VIDEO_ID)).toBe(VIDEO_ID);
  });
});

describe('buildExportModel', () => {
  it("drops sourceText when displayMode is 'ko'", () => {
    const model = buildExportModel(input({ displayMode: 'ko' }));
    expect(model.segments[0].sourceText).toBeNull();
    expect(model.segments[0].translatedText).toBe('벡터 검색에 대해 이야기해 봅시다.');
  });

  it("keeps both texts when displayMode is 'both'", () => {
    const model = buildExportModel(input());
    expect(model.segments[0].sourceText).toBe("Let's talk about vector search.");
    expect(model.segments[0].translatedText).toBe('벡터 검색에 대해 이야기해 봅시다.');
  });

  it('builds a per-segment seek url and a matching timestamp label', () => {
    const model = buildExportModel(input());
    expect(model.segments[0].url).toBe(`https://youtu.be/${VIDEO_ID}?t=12`);
    expect(model.segments[0].timestamp).toBe('0:12');
    expect(model.segments[1].timestamp).toBe('1:01:11');
  });

  it("keeps an untranslated segment in 'both' mode but omits it entirely in 'ko' mode", () => {
    const partial = { ...RECORD, segments: [seg(0, 12, 'Only source.', null)] };
    expect(buildExportModel(input({ record: partial })).segments).toHaveLength(1);
    expect(buildExportModel(input({ record: partial, displayMode: 'ko' })).segments).toHaveLength(0);
  });

  it('formats exportedAt from the injected date, not the clock', () => {
    expect(buildExportModel(input()).exportedAtText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("labels a legacy record with no targetLang as 한국어", () => {
    const legacy = { ...RECORD };
    delete (legacy as { targetLang?: unknown }).targetLang;
    expect(buildExportModel(input({ record: legacy })).targetLangLabel).toBe('한국어');
  });

  it('labels a Japanese record as 일본어', () => {
    expect(buildExportModel(input({ record: { ...RECORD, targetLang: 'ja' } })).targetLangLabel).toBe('일본어');
  });

  it('leaves durationText null when the duration is unknown', () => {
    expect(buildExportModel(input({ video: { ...VIDEO, durationSeconds: null } })).durationText).toBeNull();
  });
});

describe('renderMarkdown', () => {
  it('opens with the title and a meta line without dangling separators', () => {
    const md = renderMarkdown(buildExportModel(input({ video: { ...VIDEO, channelName: null, durationSeconds: null } })));
    expect(md.startsWith('# Intro to Large Language Models\n')).toBe(true);
    expect(md).toContain(`https://youtu.be/${VIDEO_ID}`);
    expect(md).not.toContain('· ·');
    expect(md.split('\n').some((line) => line.trim().startsWith('·') || line.trim().endsWith('·'))).toBe(false);
  });

  it('renders every summary section when a summary exists', () => {
    const md = renderMarkdown(buildExportModel(input()));
    expect(md).toContain('## 요약');
    expect(md).toContain('### 이 영상이 다루는 문제');
    expect(md).toContain('### 핵심 주장');
    expect(md).toContain('- 모델은 다음 토큰을 예측한다.');
    expect(md).toContain('### 발표 흐름');
    expect(md).toContain('### 키워드');
    expect(md).toContain('LLM · 토크나이저');
    expect(md).toContain('### 결론');
  });

  it('omits the whole summary block when there is no summary', () => {
    const md = renderMarkdown(buildExportModel(input({ summary: null })));
    expect(md).not.toContain('## 요약');
    expect(md).toContain('## 스크립트');
  });

  it('omits an empty summary field together with its heading', () => {
    const thin = { ...SUMMARY, mainArguments: [], keywords: [], conclusion: '' };
    const md = renderMarkdown(buildExportModel(input({ summary: thin })));
    expect(md).toContain('### 이 영상이 다루는 문제');
    expect(md).not.toContain('### 핵심 주장');
    expect(md).not.toContain('### 키워드');
    expect(md).not.toContain('### 결론');
  });

  it('ends the source line with a markdown hard break so the translation stays on its own line', () => {
    const md = renderMarkdown(buildExportModel(input()));
    expect(md).toContain(`**[0:12](https://youtu.be/${VIDEO_ID}?t=12)** Let's talk about vector search.  \n벡터 검색에 대해 이야기해 봅시다.`);
  });

  it("writes no trailing hard break when only the translation is present ('ko' mode)", () => {
    const md = renderMarkdown(buildExportModel(input({ displayMode: 'ko' })));
    expect(md).toContain(`**[0:12](https://youtu.be/${VIDEO_ID}?t=12)** 벡터 검색에 대해 이야기해 봅시다.`);
    expect(md).not.toContain('  \n');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/lib/export-doc.test.ts`
Expected: FAIL — `./export-doc` 모듈이 없다.

- [ ] **Step 3: 구현**

`src/lib/export-doc.ts`:

```ts
import { formatTimestamp } from '~/lib/transcript-parse';
import { TARGET_LANG_LABELS } from '~/lib/target-lang';
import type { DisplayMode } from '~/components/TranscriptList';
import type { TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import type { VideoMeta } from '~/types/video';

/** 제목 부분의 최대 길이. videoId는 이 한도 밖에서 항상 온전히 붙는다. */
const MAX_TITLE_CHARS = 80;

export interface ExportInput {
  video: VideoMeta;
  /** 호출자가 `status === 'done'`을 이미 확인한 레코드. */
  record: TranslationRecord;
  /** `null`이면 요약 블록을 통째로 생략한다. */
  summary: VideoSummary | null;
  displayMode: DisplayMode;
  /** 주입받는다 — 이 모듈은 시계를 읽지 않는다(테스트 결정성). */
  exportedAt: Date;
}

export interface ExportSegmentLine {
  startSec: number;
  timestamp: string;
  url: string;
  /** `displayMode === 'ko'`이면 항상 null. */
  sourceText: string | null;
  translatedText: string | null;
}

export interface ExportModel {
  title: string;
  channelName: string | null;
  durationText: string | null;
  videoUrl: string;
  targetLangLabel: string;
  exportedAtText: string;
  summary: VideoSummary | null;
  segments: ExportSegmentLine[];
  fileBaseName: string;
}

export function buildFileBaseName(title: string, videoId: string): string {
  const sanitized = title
    // 윈도우·macOS 파일명 금지문자만 치환한다. 하이픈과 한글은 보존.
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, MAX_TITLE_CHARS);
  return sanitized ? `${sanitized}_${videoId}` : videoId;
}

/** 로컬 시간 기준 `YYYY-MM-DD HH:mm`. */
function formatExportedAt(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function buildExportModel({
  video,
  record,
  summary,
  displayMode,
  exportedAt,
}: ExportInput): ExportModel {
  const videoUrl = `https://youtu.be/${video.videoId}`;
  const showSource = displayMode === 'both';

  const segments: ExportSegmentLine[] = [];
  for (const segment of record.segments) {
    const sourceText = showSource ? segment.sourceText : null;
    // 'ko' 모드에서 아직 번역되지 않은 세그먼트는 타임스탬프만 남으므로 통째로 뺀다.
    if (sourceText === null && segment.translatedText === null) continue;
    segments.push({
      startSec: segment.startSec,
      timestamp: formatTimestamp(segment.startSec),
      url: `${videoUrl}?t=${Math.floor(segment.startSec)}`,
      sourceText,
      translatedText: segment.translatedText,
    });
  }

  return {
    title: video.title,
    channelName: video.channelName,
    durationText: video.durationSeconds === null ? null : formatTimestamp(video.durationSeconds),
    videoUrl,
    targetLangLabel: TARGET_LANG_LABELS[record.targetLang ?? 'ko'],
    exportedAtText: formatExportedAt(exportedAt),
    summary,
    segments,
    fileBaseName: buildFileBaseName(video.title, video.videoId),
  };
}

export function renderMarkdown(model: ExportModel): string {
  const lines: string[] = [`# ${model.title}`, ''];

  // 값이 없는 항목은 구분점째로 빠진다 — "· ·"나 앞뒤에 남는 "·"가 생기지 않도록
  // 존재하는 조각만 모아 join한다.
  const metaParts = [model.channelName, model.durationText, model.videoUrl].filter(
    (part): part is string => part !== null && part !== '',
  );
  lines.push(metaParts.join(' · '));
  lines.push(`번역 ${model.targetLangLabel} · 내보낸 날짜 ${model.exportedAtText}`);
  lines.push('');

  const summary = model.summary;
  if (summary) {
    lines.push('## 요약', '');
    if (summary.purpose) {
      lines.push('### 이 영상이 다루는 문제', summary.purpose, '');
    }
    if (summary.mainArguments.length > 0) {
      lines.push('### 핵심 주장');
      for (const argument of summary.mainArguments) lines.push(`- ${argument}`);
      lines.push('');
    }
    if (summary.sections.length > 0) {
      lines.push('### 발표 흐름');
      for (const section of summary.sections) {
        const at = Math.floor(section.startSec);
        lines.push(`- [${formatTimestamp(section.startSec)}](${model.videoUrl}?t=${at}) ${section.title}`);
      }
      lines.push('');
    }
    if (summary.keywords.length > 0) {
      lines.push('### 키워드', summary.keywords.join(' · '), '');
    }
    if (summary.conclusion) {
      lines.push('### 결론', summary.conclusion, '');
    }
  }

  lines.push('## 스크립트', '');
  for (const segment of model.segments) {
    const head = `**[${segment.timestamp}](${segment.url})**`;
    if (segment.sourceText !== null && segment.translatedText !== null) {
      // 원문 줄 끝의 공백 2칸은 마크다운 hard break — 없으면 렌더러가 원문과 번역을
      // 한 문단으로 이어 붙여 한 줄로 보인다.
      lines.push(`${head} ${segment.sourceText}  `, segment.translatedText, '');
    } else {
      lines.push(`${head} ${segment.sourceText ?? segment.translatedText ?? ''}`, '');
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/lib/export-doc.test.ts`
Expected: PASS (전부)

- [ ] **Step 5: 전체 검증 + 커밋**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add src/lib/export-doc.ts src/lib/export-doc.test.ts
git commit -m "feat(export): pure markdown/document builder for transcript + summary"
```

---

### Task 3: `fetchExportData` + `useExportData`

패널 메뉴와 인쇄 페이지가 함께 쓰는 단일 페치 경로.

**Files:**
- Create: `src/features/export/useExportData.ts`
- Test: `src/features/export/useExportData.test.ts`

**Interfaces:**
- Consumes: `sendMessage` (`~/lib/messaging`), `parseVideoId` (`~/lib/youtube`), Task 1의 `GET_VIDEO_META`
- Produces:
  - `type ExportDataState`
  - `fetchExportData(videoId: string): Promise<ExportDataState>`
  - `useExportData(enabled: boolean): ExportDataState`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/features/export/useExportData.test.ts` — `fetchExportData`만 테스트한다(순수 async 함수). 훅은 React 렌더 하니스가 이 레포에 없으므로 CDP 수용 검증(Task 6)에서 확인한다.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchExportData } from './useExportData';

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('~/lib/messaging', () => ({ sendMessage }));

const VIDEO_ID = 'zjkBMFhNj_g';
const VIDEO = { videoId: VIDEO_ID, title: 't', channelName: null, durationSeconds: null };
const DONE = { videoId: VIDEO_ID, status: 'done', segments: [] };

function routeResponses(over: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    GET_VIDEO_META: VIDEO,
    GET_TRANSLATION: DONE,
    GET_SUMMARY: null,
    ...over,
  };
  sendMessage.mockImplementation((msg: { type: string }) => Promise.resolve(table[msg.type]));
}

describe('fetchExportData', () => {
  beforeEach(() => {
    sendMessage.mockReset();
  });

  it('returns ready with all three records when the translation is done', async () => {
    routeResponses({ GET_SUMMARY: { videoId: VIDEO_ID } });
    const state = await fetchExportData(VIDEO_ID);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') throw new Error('unreachable');
    expect(state.video).toEqual(VIDEO);
    expect(state.summary).toEqual({ videoId: VIDEO_ID });
  });

  it('is still ready when there is no summary', async () => {
    routeResponses();
    const state = await fetchExportData(VIDEO_ID);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') throw new Error('unreachable');
    expect(state.summary).toBeNull();
  });

  it("reports not-done when the record isn't finished", async () => {
    routeResponses({ GET_TRANSLATION: { videoId: VIDEO_ID, status: 'translating', segments: [] } });
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'not-done' });
  });

  it('reports not-done when there is no record at all', async () => {
    routeResponses({ GET_TRANSLATION: null });
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'not-done' });
  });

  it('reports no-video when the meta was never cached', async () => {
    routeResponses({ GET_VIDEO_META: null });
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'no-video' });
  });

  it('sends the three reads concurrently, not one after another', async () => {
    routeResponses();
    await fetchExportData(VIDEO_ID);
    const types = sendMessage.mock.calls.map(([msg]) => msg.type).sort();
    expect(types).toEqual(['GET_SUMMARY', 'GET_TRANSLATION', 'GET_VIDEO_META']);
  });

  it('reports no-video when a read rejects', async () => {
    sendMessage.mockRejectedValue(new Error('extension context invalidated'));
    expect(await fetchExportData(VIDEO_ID)).toEqual({ status: 'unavailable', reason: 'no-video' });
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/features/export/useExportData.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/features/export/useExportData.ts`:

```ts
import { useEffect, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import { parseVideoId } from '~/lib/youtube';
import type { TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import type { VideoMeta } from '~/types/video';

export type ExportDataState =
  | { status: 'loading' }
  | { status: 'unavailable'; reason: 'no-video' | 'not-done' }
  | {
      status: 'ready';
      video: VideoMeta;
      record: TranslationRecord;
      summary: VideoSummary | null;
    };

/**
 * 내보내기에 필요한 세 레코드를 한 번에 읽는다. 패널의 메뉴와 `export.html`이
 * 같은 함수를 쓴다 — 두 소비자가 서로 다른 경로로 읽으면 같은 영상에 대해 다른
 * 문서가 나올 수 있다.
 *
 * 실패(수신자 없음, 컨텍스트 무효화 등)는 `no-video`로 접는다. 이 화면에서
 * 사용자가 할 수 있는 행동은 어느 실패든 동일하기 때문에 사유를 더 쪼개지 않는다.
 */
export async function fetchExportData(videoId: string): Promise<ExportDataState> {
  try {
    const [video, record, summary] = await Promise.all([
      sendMessage({ type: 'GET_VIDEO_META', payload: { videoId } }),
      sendMessage({ type: 'GET_TRANSLATION', payload: { videoId } }),
      sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }),
    ]);

    if (!video) return { status: 'unavailable', reason: 'no-video' };
    if (!record || record.status !== 'done') return { status: 'unavailable', reason: 'not-done' };
    return { status: 'ready', video, record, summary: summary ?? null };
  } catch {
    return { status: 'unavailable', reason: 'no-video' };
  }
}

/**
 * `enabled`가 true로 바뀔 때(=메뉴가 열릴 때) 1회 조회한다. 상시 구독하지 않는 이유:
 * 헤더는 패널 본문(ReadyBody)의 번역 상태에 접근할 수 없고, 이 정보가 필요한
 * 순간은 메뉴가 열려 있는 동안뿐이다. 닫았다 열면 다시 읽는다 — 그사이 번역이
 * 끝났을 수 있다.
 */
export function useExportData(enabled: boolean): ExportDataState {
  const [state, setState] = useState<ExportDataState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'loading' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const videoId = parseVideoId(tab?.url);
      if (cancelled) return;
      if (!videoId) {
        setState({ status: 'unavailable', reason: 'no-video' });
        return;
      }
      const next = await fetchExportData(videoId);
      if (!cancelled) setState(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/features/export/useExportData.test.ts`
Expected: PASS (7개)

- [ ] **Step 5: 전체 검증 + 커밋**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add src/features/export/useExportData.ts src/features/export/useExportData.test.ts
git commit -m "feat(export): shared fetchExportData + useExportData hook"
```

---

### Task 4: `DownloadMenu` + 헤더 배치

**Files:**
- Create: `src/components/DownloadMenu.tsx`
- Modify: `entrypoints/sidepanel/App.tsx` (헤더 `<div className="flex items-center gap-3">` 안, `GearIcon` 버튼 **앞**)

**Interfaces:**
- Consumes: `useExportData`/`ExportDataState` (Task 3), `buildExportModel`/`renderMarkdown` (Task 2), `loadPanelPrefs` (`~/lib/panel-prefs`), `parseVideoId` (`~/lib/youtube`)
- Produces: `export function DownloadMenu(): JSX.Element`

- [ ] **Step 1: 컴포넌트 작성**

`src/components/DownloadMenu.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { buildExportModel, renderMarkdown } from '~/lib/export-doc';
import { loadPanelPrefs } from '~/lib/panel-prefs';
import { useExportData } from '~/features/export/useExportData';
import type { ExportDataState } from '~/features/export/useExportData';

/**
 * 헤더의 내려받기 버튼. 열릴 때만 데이터를 읽고(`useExportData(open)`), 두 포맷 중
 * 하나를 고르게 한다. Markdown은 이 자리에서 Blob으로 바로 저장하고, PDF는 인쇄용
 * 확장 페이지를 새 탭으로 연다 — 두 경로 모두 새 권한을 쓰지 않는다.
 */
export function DownloadMenu() {
  const [open, setOpen] = useState(false);
  const data = useExportData(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 바깥 클릭 / Escape로 닫기. 열려 있을 때만 문서 리스너를 붙인다.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const ready = data.status === 'ready';

  const downloadMarkdown = async () => {
    if (data.status !== 'ready') return;
    const { displayMode } = await loadPanelPrefs();
    const model = buildExportModel({
      video: data.video,
      record: data.record,
      summary: data.summary,
      displayMode,
      exportedAt: new Date(),
    });
    const blob = new Blob([renderMarkdown(model)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${model.fileBaseName}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setOpen(false);
  };

  const openPrintPage = () => {
    if (data.status !== 'ready') return;
    void chrome.tabs.create({
      url: chrome.runtime.getURL(`export.html?videoId=${encodeURIComponent(data.video.videoId)}`),
    });
    setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="내려받기"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded p-1 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        <DownloadIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-[7px] border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          <MenuItem disabled={!ready} onClick={downloadMarkdown}>
            Markdown (.md)
          </MenuItem>
          <MenuItem disabled={!ready} onClick={openPrintPage}>
            PDF (인쇄)
          </MenuItem>
          <p className="border-t border-neutral-100 px-3 py-2 text-[10.5px] leading-relaxed text-neutral-500 dark:border-neutral-900 dark:text-neutral-400">
            {hintFor(data)}
          </p>
        </div>
      )}
    </div>
  );
}

function hintFor(data: ExportDataState): string {
  if (data.status === 'loading') return '확인 중…';
  if (data.status === 'unavailable') {
    return data.reason === 'not-done' ? '번역 완료 후 내려받을 수 있어요' : '영상을 인식하지 못했어요';
  }
  return data.summary ? '스크립트와 요약이 함께 담깁니다' : '요약 없음 — 스크립트만 포함';
}

function MenuItem({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="block w-full px-3 py-2 text-left text-[12px] text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-400 dark:text-neutral-200 dark:hover:bg-neutral-900 dark:disabled:text-neutral-600"
    >
      {children}
    </button>
  );
}

/** 헤더의 GearIcon과 같은 방식의 인라인 SVG — 아이콘 라이브러리를 추가하지 않는다. */
function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}
```

- [ ] **Step 2: 헤더에 배치**

`entrypoints/sidepanel/App.tsx` 상단 import에 추가:

```ts
import { DownloadMenu } from '~/components/DownloadMenu';
```

헤더의 `<div className="flex items-center gap-3">` 안에서 `StatusBadge` 블록과 기어 `<button>` **사이**에 삽입한다. 기어 버튼은 그대로 둔다:

```tsx
          {ready && <DownloadMenu />}
          <button
            type="button"
            onClick={() => chrome.runtime.openOptionsPage()}
```

`ready`는 이미 이 컴포넌트에 있는 지역 변수(`present && pageKind === 'watch'`)다. 새로 만들지 않는다.

- [ ] **Step 3: 검증 + 커밋**

렌더 테스트 하니스가 이 레포에 없으므로 이 태스크의 자동 검증은 타입·빌드까지다. 동작은 Task 6(실 Chrome)에서 확인한다.

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add src/components/DownloadMenu.tsx entrypoints/sidepanel/App.tsx
git commit -m "feat(panel): header download menu (markdown / print-to-PDF)"
```

---

### Task 5: `export.html` 인쇄 페이지

**Files:**
- Create: `entrypoints/export/index.html`
- Create: `entrypoints/export/main.tsx`
- Create: `entrypoints/export/App.tsx`
- Create: `src/components/ExportDocument.tsx`

**Interfaces:**
- Consumes: `fetchExportData` (Task 3), `buildExportModel`/`ExportModel` (Task 2), `loadPanelPrefs`
- Produces: `export.html` 엔트리포인트 (WXT가 `entrypoints/export/index.html`을 `export.html`로 빌드한다 — `entrypoints/options/index.html` → `options.html`과 같은 규칙)

- [ ] **Step 1: HTML 엔트리포인트**

`entrypoints/export/index.html` — `entrypoints/options/index.html`과 같은 형태:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>YouTube Play Assistant — 내보내기</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`entrypoints/export/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '~/styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 2: 페이지 컴포넌트**

`entrypoints/export/App.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { ExportDocument } from '~/components/ExportDocument';
import { buildExportModel } from '~/lib/export-doc';
import type { ExportModel } from '~/lib/export-doc';
import { loadPanelPrefs } from '~/lib/panel-prefs';
import { fetchExportData } from '~/features/export/useExportData';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; model: ExportModel };

export function App() {
  const [state, setState] = useState<PageState>({ status: 'loading' });
  // 인쇄는 딱 한 번만 자동 호출한다. StrictMode의 이중 마운트로 대화상자가 두 번
  // 열리는 것을 막는 가드이기도 하다.
  const printedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const videoId = new URLSearchParams(location.search).get('videoId');
      if (!videoId) {
        setState({ status: 'error', message: '내보낼 영상을 찾지 못했어요.' });
        return;
      }
      const [data, prefs] = await Promise.all([fetchExportData(videoId), loadPanelPrefs()]);
      if (cancelled) return;
      if (data.status !== 'ready') {
        setState({
          status: 'error',
          message:
            data.status === 'unavailable' && data.reason === 'not-done'
              ? '번역이 완료된 뒤에 내보낼 수 있어요.'
              : '내보낼 데이터를 찾지 못했어요.',
        });
        return;
      }
      setState({
        status: 'ready',
        model: buildExportModel({
          video: data.video,
          record: data.record,
          summary: data.summary,
          displayMode: prefs.displayMode,
          exportedAt: new Date(),
        }),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.status !== 'ready' || printedRef.current) return;
    printedRef.current = true;
    // 인쇄 대화상자의 기본 파일명은 document.title에서 나온다 — Markdown 쪽
    // 파일명과 같은 문자열을 쓴다.
    document.title = state.model.fileBaseName;
    void document.fonts.ready.then(() => window.print());
  }, [state]);

  if (state.status === 'loading') {
    return <p className="p-8 text-sm text-neutral-500">불러오는 중…</p>;
  }
  if (state.status === 'error') {
    return <p className="p-8 text-sm text-neutral-700">{state.message}</p>;
  }

  return (
    <>
      <div className="no-print sticky top-0 flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-6 py-3 text-[12.5px] text-neutral-700">
        <span>
          인쇄 대화상자에서 <strong>대상 → PDF로 저장</strong>을 선택하세요.
        </span>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-[7px] border border-neutral-300 bg-white px-3 py-1.5 font-semibold hover:bg-neutral-100"
        >
          다시 인쇄
        </button>
      </div>
      <ExportDocument model={state.model} />
    </>
  );
}
```

- [ ] **Step 3: 문서 렌더 컴포넌트 + 인쇄 CSS**

`src/components/ExportDocument.tsx`:

```tsx
import type { ExportModel } from '~/lib/export-doc';

/**
 * 화면과 인쇄에 같은 마크업을 쓴다. 인쇄 규칙은 이 파일 안의 <style>로만 둔다 —
 * Tailwind의 print: 변형으로는 @page 여백과 break-inside를 표현할 수 없다.
 */
export function ExportDocument({ model }: { model: ExportModel }) {
  const metaParts = [model.channelName, model.durationText].filter(
    (part): part is string => part !== null && part !== '',
  );

  return (
    <article className="mx-auto max-w-[760px] px-6 py-8 text-[13px] leading-relaxed text-neutral-900">
      <style>{PRINT_CSS}</style>

      <h1 className="text-[20px] font-bold leading-snug">{model.title}</h1>
      <p className="mt-1 text-[12px] text-neutral-600">
        {metaParts.join(' · ')}
        {metaParts.length > 0 ? ' · ' : ''}
        <a href={model.videoUrl}>{model.videoUrl}</a>
      </p>
      <p className="mt-0.5 text-[12px] text-neutral-600">
        번역 {model.targetLangLabel} · 내보낸 날짜 {model.exportedAtText}
      </p>

      {model.summary && (
        <section className="mt-7">
          <h2 className="text-[16px] font-bold">요약</h2>
          {model.summary.purpose && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">이 영상이 다루는 문제</h3>
              <p className="mt-1">{model.summary.purpose}</p>
            </>
          )}
          {model.summary.mainArguments.length > 0 && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">핵심 주장</h3>
              <ul className="mt-1 list-disc pl-5">
                {model.summary.mainArguments.map((argument, i) => (
                  <li key={i}>{argument}</li>
                ))}
              </ul>
            </>
          )}
          {model.summary.sections.length > 0 && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">발표 흐름</h3>
              <ul className="mt-1 list-disc pl-5">
                {model.summary.sections.map((section, i) => (
                  <li key={i}>
                    <a href={`${model.videoUrl}?t=${Math.floor(section.startSec)}`}>{section.title}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {model.summary.keywords.length > 0 && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">키워드</h3>
              <p className="mt-1">{model.summary.keywords.join(' · ')}</p>
            </>
          )}
          {model.summary.conclusion && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">결론</h3>
              <p className="mt-1">{model.summary.conclusion}</p>
            </>
          )}
        </section>
      )}

      <section className="mt-7">
        <h2 className="text-[16px] font-bold">스크립트</h2>
        <div className="mt-3">
          {model.segments.map((segment) => (
            <div key={segment.startSec} className="seg mb-3">
              <a href={segment.url} className="mr-2 font-mono text-[11.5px] text-neutral-500">
                [{segment.timestamp}]
              </a>
              {segment.sourceText !== null && <span>{segment.sourceText}</span>}
              {segment.sourceText !== null && segment.translatedText !== null && <br />}
              {segment.translatedText !== null && <span>{segment.translatedText}</span>}
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}

const PRINT_CSS = `
  @page { margin: 14mm; }
  a { color: inherit; text-decoration: none; }
  @media print {
    .no-print { display: none !important; }
    .seg { break-inside: avoid; }
    h2, h3 { break-after: avoid; }
  }
`;
```

- [ ] **Step 4: 빌드에 엔트리포인트가 잡히는지 확인**

Run: `npm run build && ls .output/chrome-mv3/export.html`
Expected: `export.html`이 존재한다. 없으면 WXT가 엔트리포인트를 인식하지 못한 것이므로 디렉터리/파일명을 `entrypoints/options/`와 정확히 대조한다.

- [ ] **Step 5: 전체 검증 + 커밋**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add entrypoints/export src/components/ExportDocument.tsx
git commit -m "feat(export): print-ready export page for PDF output"
```

---

### Task 6: 실 Chrome 수용 검증

자동 테스트가 닿지 않는 부분(헤더 배치, 메뉴 상태 분기, 실제 파일 저장, 인쇄 페이지)을 CDP로 확인한다. **이 태스크는 컨트롤러가 직접 수행한다** — 구현 서브에이전트에게 위임하지 않는다(개발 프로필과 API 키 상태를 다루기 때문).

- [ ] **Step 1: 빌드 배포 + 확장 리로드**

`.output/chrome-mv3`를 메인 체크아웃 경로로 동기화한 뒤 `Extensions.loadUnpacked` + SW 컨텍스트 `chrome.runtime.reload()`로 리로드한다. `scripts/dev-chrome.mjs`는 쓰지 않는다.

- [ ] **Step 2: 헤더 배치 확인**

패널에서 `aria-label="내려받기"` 버튼이 존재하고, 그 rect의 `right`가 `aria-label="설정 열기"` 버튼의 `left`보다 작은지(= 왼쪽에 있는지) 확인한다.

- [ ] **Step 3: 메뉴 상태 분기 확인**

번역 완료된 영상에서 메뉴를 열어 두 항목이 활성이고 힌트가 요약 유무에 맞는지 확인한다. 이어서 번역 레코드가 없는 영상(또는 임의의 새 영상)에서 두 항목이 비활성 + "번역 완료 후 내려받을 수 있어요"가 뜨는지 확인한다.

- [ ] **Step 4: Markdown 실제 저장 확인**

`Page.setDownloadBehavior`로 다운로드 경로를 스크래치패드로 지정하고 `Markdown (.md)`를 클릭한 뒤, 파일이 생성됐는지와 첫 줄이 `# `로 시작하고 `## 스크립트`를 포함하는지 확인한다. 파일명이 `{제목}_{videoId}.md` 규칙과 맞는지도 본다.

- [ ] **Step 5: 인쇄 페이지 확인**

`window.print`를 스텁으로 바꿔 카운트한 상태에서 `PDF (인쇄)`를 클릭하고, 새 탭 URL이 `export.html?videoId=…`이며 `document.title`이 Markdown 파일명(확장자 제외)과 같고, 본문에 요약·스크립트가 렌더되며 `print`가 정확히 1회 호출됐는지 확인한다.

- [ ] **Step 6: 불변 확인**

`chrome.storage.local`의 `geminiApiKeySavedAt`이 `2026-07-28T07:15:51.622Z` 그대로인지, `manifest.permissions`가 `['storage','sidePanel']` 그대로인지 확인한다.

---

## 자기 검토 결과

**스펙 커버리지** — §0 제약(권한·의존성·외부전송)은 Global Constraints, §1 파일 구조는 Task 1~5, §2 빌더는 Task 2, §3 훅은 Task 3, §4 메뉴는 Task 4, §5 인쇄 페이지는 Task 5, §6 오류 처리는 Task 3(`fetchExportData` 분기)·Task 4(`hintFor`)·Task 5(에러 렌더), §7 테스트는 Task 2·3의 단위 테스트와 Task 6의 CDP 검증에 각각 대응한다. §8(제외 범위)은 어느 태스크도 건드리지 않는다.

**타입 일관성** — `ExportDataState`/`ExportModel`/`ExportInput`의 필드명과 `fetchExportData`/`buildExportModel`/`renderMarkdown`/`buildFileBaseName`의 시그니처는 Task 2·3에서 정의한 그대로 Task 4·5가 소비한다. `video`는 세 곳 모두 `VideoMeta`(`ExtractedVideoMeta` 아님)로 통일했다.

**남은 판단** — `DownloadMenu`와 `ExportDocument`에는 렌더 테스트가 없다(레포에 컴포넌트 테스트 하니스 자체가 없음 — M3 백로그의 기존 이월 항목). 그래서 Task 6의 CDP 검증이 이 두 파일의 유일한 실행 검증이며, 생략하면 안 된다.
