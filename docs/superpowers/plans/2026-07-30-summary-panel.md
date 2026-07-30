# Summary 패널 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 번역 done 영상에서 버튼 1회로 한국어 요약(문제·핵심 주장·발표 흐름·키워드·결론)을 생성·캐시하고 패널의 Summary 탭에 렌더하며, 발표 흐름 행 클릭으로 영상을 시크한다.

**Architecture:** 패널 → bg `GENERATE_SUMMARY` sendMessage → bg가 번역 레코드의 영어 원문으로 Gemini 1회 호출(JSON responseSchema) → IndexedDB `summaries` 스토어(v3)에 영속 → 응답. 조회는 `GET_SUMMARY`. 프롬프트·검증·재시도 정책은 `src/lib/summary.ts` 순수 함수로 분리해 TDD. UI는 ReadyBody의 Transcript | Summary 탭 전환, 발표 흐름 시크는 기존 `usePlaybackSync.seek` 재사용.

**Tech Stack:** WXT + React 18 + TS 5 + Tailwind, vitest(+fake-indexeddb). Chrome MV3.

**Spec:** `docs/superpowers/specs/2026-07-30-summary-panel-design.md` (승인됨)

## Global Constraints

- API 키는 background에서만 접근(`getApiKey()` — `src/lib/storage.ts`). 패널에서 Gemini 직접 호출 금지.
- Gemini 모델은 기존 `MODEL_ID`(`gemini-3.5-flash-lite`), 호출은 gemini.ts의 기존 `callGeminiJson` 경유. `generationConfig`에 `thinkingConfig` 넣지 말 것(analyzeGlossary 주석 참조 — 400 남).
- 번역 레코드(`translations` 스토어) 스키마 무변경. 요약은 `summaries` 스토어에만.
- 순수 로직(`src/lib/`)은 TDD (실패 테스트 → RED 확인 → 구현 → GREEN).
- 각 태스크 후 게이트: `pnpm tsc --noEmit` 0 · `pnpm test` 전체 통과 · `pnpm wxt build` 성공.
- UI 문구 한국어 / 코드·주석·커밋 영어. Conventional Commits, 태스크 마지막 스텝에서만 커밋.
- **ReadyBody(App.tsx)의 모든 훅 호출은 `no-metadata` early return(`if (!loading && video === null)`) 위에 있어야 한다** — playback-sync 최종 리뷰 C1(Rules of Hooks 크래시)의 재발 방지. 새 훅(useSummary, 탭 useState, useElapsedSeconds 추가분)도 전부 그 위에.
- `.env.local`, `.chrome-dev-profile/`, `.chrome-dev-output/`, `.superpowers/` 읽기·커밋 금지.
- 브랜치: `feat/summary-panel` (main에서 분기).

---

### Task 1: VideoSummary 타입 + IndexedDB v3 (`summaries` 스토어)

**Files:**
- Create: `src/types/summary.ts`
- Modify: `src/lib/db.ts` (DB_VERSION 2→3, 스토어 추가, put/get)
- Test: `src/lib/db.test.ts` (append)

**Interfaces:**
- Consumes: 기존 db.ts의 `openDb` 패턴, db.test.ts의 `makeRecord`/`deleteDb` 헬퍼.
- Produces (이후 태스크가 그대로 사용):
  - `interface SummarySection { startSec: number; title: string }` (`~/types/summary`)
  - `interface VideoSummary { videoId: string; purpose: string; mainArguments: string[]; sections: SummarySection[]; keywords: string[]; conclusion: string; model: string; createdAt: string }` — `createdAt`은 ISO 문자열 (스펙 초안의 `number`에서 의도적 이탈: TranslationRecord의 `createdAt`/`updatedAt` ISO 관례를 따른다)
  - `putSummary(summary: VideoSummary): Promise<void>` / `getSummary(videoId: string): Promise<VideoSummary | null>` (`~/lib/db`)
  - `export const SUMMARIES_STORE = 'summaries'`, `DB_VERSION = 3`

- [ ] **Step 1: 타입 파일 작성**

`src/types/summary.ts`:

```ts
// PRD §10 `VideoSummary`, narrowed to what the summary panel renders
// (spec 2026-07-30 §2). `createdAt` is an ISO string — the repo's
// TranslationRecord convention — a deliberate deviation from the spec
// sketch's `number`.
export interface SummarySection {
  startSec: number;
  title: string;
}

export interface VideoSummary {
  videoId: string;
  purpose: string;
  mainArguments: string[];
  sections: SummarySection[];
  keywords: string[];
  conclusion: string;
  model: string;
  createdAt: string;
}
```

- [ ] **Step 2: 실패 테스트 작성**

`src/lib/db.test.ts`에 append (기존 import에 `SUMMARIES_STORE`는 불필요 — `putSummary`, `getSummary`를 `./db` import에, `VideoSummary`를 `~/types/summary` import로 추가):

```ts
function makeSummary(overrides: Partial<VideoSummary> = {}): VideoSummary {
  return {
    videoId: 'zjkBMFhNj_g',
    purpose: 'Explains how LLMs are trained and used.',
    mainArguments: ['Training is compression.', 'Fine-tuning aligns behavior.'],
    sections: [
      { startSec: 0, title: '문제 정의' },
      { startSec: 620, title: '모델 구조' },
    ],
    keywords: ['LLM', 'Fine-tuning'],
    conclusion: 'LLMs are becoming an OS-like platform.',
    model: 'gemini-3.5-flash-lite',
    createdAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

// Seeds a v2 database (videos + translations, as db.ts shipped in M2) with
// raw indexedDB calls, so the v3 migration test exercises a real 2->3
// onupgradeneeded transition — mirrors seedV1Database above.
function seedV2Database(rec: TranslationRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
      db.createObjectStore(TRANSLATIONS_STORE, { keyPath: 'videoId' });
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

describe('v2 -> v3 migration', () => {
  it('adds the summaries store without touching existing translations data', async () => {
    const rec = makeRecord({ status: 'done' });
    await seedV2Database(rec);
    await putSummary(makeSummary());
    expect(await getSummary('zjkBMFhNj_g')).toEqual(makeSummary());
    expect(await getTranslation('zjkBMFhNj_g')).toEqual(rec);
  });
});

describe('putSummary / getSummary', () => {
  it('round-trips a stored summary', async () => {
    const summary = makeSummary();
    await putSummary(summary);
    expect(await getSummary(summary.videoId)).toEqual(summary);
  });

  it('returns null for an absent videoId', async () => {
    expect(await getSummary('missing')).toBeNull();
  });

  it('overwrites rather than duplicating on repeated put (regeneration path)', async () => {
    await putSummary(makeSummary({ purpose: 'first' }));
    await putSummary(makeSummary({ purpose: 'second' }));
    expect((await getSummary('zjkBMFhNj_g'))?.purpose).toBe('second');
  });
});
```

- [ ] **Step 3: RED 확인**

Run: `pnpm vitest run src/lib/db.test.ts`
Expected: FAIL — `putSummary`/`getSummary` export 없음 (import 단계에서 실패).

- [ ] **Step 4: db.ts 구현**

`src/lib/db.ts` 수정:

1. 상수 (13행 근처):

```ts
export const DB_VERSION = 3;
```

```ts
// M3: one Korean summary per video, generated on demand from a `done`
// translation record (spec 2026-07-30 §2). Keyed like the other stores so
// regeneration is a plain overwrite of the same key.
export const SUMMARIES_STORE = 'summaries';
```

2. `openDb`의 `onupgradeneeded` 안, 기존 두 guard 아래에:

```ts
      if (!db.objectStoreNames.contains(SUMMARIES_STORE)) {
        db.createObjectStore(SUMMARIES_STORE, { keyPath: 'videoId' });
      }
```

3. 파일 끝에 (putTranslation/getTranslation과 동일 골격):

```ts
export async function putSummary(summary: VideoSummary): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARIES_STORE, 'readwrite');
    tx.objectStore(SUMMARIES_STORE).put(summary);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getSummary(videoId: string): Promise<VideoSummary | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARIES_STORE, 'readonly');
    const request = tx.objectStore(SUMMARIES_STORE).get(videoId);
    let result: VideoSummary | null = null;
    request.onsuccess = () => {
      result = (request.result as VideoSummary | undefined) ?? null;
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
```

4. import에 `import type { VideoSummary } from '~/types/summary';` 추가.

- [ ] **Step 5: GREEN 확인**

Run: `pnpm vitest run src/lib/db.test.ts`
Expected: PASS (기존 스위트 포함 전부).

- [ ] **Step 6: 게이트 + 커밋**

```bash
pnpm tsc --noEmit && pnpm test && pnpm wxt build
git add src/types/summary.ts src/lib/db.ts src/lib/db.test.ts
git commit -m "feat(db): summaries store (v3) with VideoSummary type"
```

---

### Task 2: 순수 로직 — 프롬프트 빌더 · 응답 정규화 · 재시도 정책

**Files:**
- Create: `src/lib/summary.ts`
- Test: `src/lib/summary.test.ts`

**Interfaces:**
- Consumes: `TranscriptSegment`(`startSec`, `sourceText`) — `~/types/transcript`; `VideoSummary` — Task 1.
- Produces (Task 3이 그대로 사용):
  - `type SummaryPayload = Pick<VideoSummary, 'purpose' | 'mainArguments' | 'sections' | 'keywords' | 'conclusion'>`
  - `buildSummaryPrompt(segments: readonly Pick<TranscriptSegment, 'startSec' | 'sourceText'>[]): string`
  - `normalizeSummaryPayload(parsed: unknown, maxStartSec: number): SummaryPayload | undefined`
  - `summaryRetryPlan(reason: 'bad_json' | 'rate_limit' | 'unauthorized' | 'network' | 'unknown', attempt: number, retryDelayMs?: number): { retry: boolean; delayMs: number }`
  - 상수 `SUMMARY_MAX_ATTEMPTS = 3`, `SUMMARY_RATE_LIMIT_MAX_DELAY_MS = 60_000`, `SUMMARY_DEFAULT_RETRY_DELAY_MS = 5_000`

- [ ] **Step 1: 실패 테스트 작성**

`src/lib/summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  SUMMARY_MAX_ATTEMPTS,
  buildSummaryPrompt,
  normalizeSummaryPayload,
  summaryRetryPlan,
} from './summary';

const seg = (startSec: number, sourceText: string) => ({ startSec, sourceText });

describe('buildSummaryPrompt', () => {
  it('renders one [startSec] line per segment in order', () => {
    const prompt = buildSummaryPrompt([seg(0, 'hello world'), seg(11, 'second line')]);
    expect(prompt).toContain('[0] hello world\n[11] second line');
  });

  it('includes the PRD guardrails, Korean-output rule, and the JSON shape', () => {
    const prompt = buildSummaryPrompt([seg(0, 'x')]);
    expect(prompt).toContain('Do NOT add your own opinions');
    expect(prompt).toContain('Korean');
    expect(prompt).toContain('"purpose": string');
  });
});

const validPayload = () => ({
  purpose: '문제 설명',
  mainArguments: ['주장 1', '주장 2'],
  sections: [
    { startSec: 620, title: '실패 원인' },
    { startSec: 0, title: '문제 정의' },
  ],
  keywords: ['Agent'],
  conclusion: '결론',
});

describe('normalizeSummaryPayload', () => {
  it('accepts a valid payload and sorts sections by startSec ascending', () => {
    const result = normalizeSummaryPayload(validPayload(), 3600);
    expect(result?.sections.map((s) => s.startSec)).toEqual([0, 620]);
    expect(result?.purpose).toBe('문제 설명');
  });

  it('clamps section startSec into [0, maxStartSec]', () => {
    const p = validPayload();
    p.sections = [
      { startSec: 99999, title: '끝' },
      { startSec: -5, title: '시작' },
    ];
    const result = normalizeSummaryPayload(p, 3600);
    expect(result?.sections.map((s) => s.startSec)).toEqual([0, 3600]);
  });

  it('drops malformed section entries but keeps valid ones', () => {
    const p = validPayload();
    (p.sections as unknown[]) = [
      { startSec: 10, title: '유효' },
      { startSec: Number.NaN, title: '무효' },
      { startSec: 20, title: '' },
    ];
    const result = normalizeSummaryPayload(p, 3600);
    expect(result?.sections).toEqual([{ startSec: 10, title: '유효' }]);
  });

  it('rejects when sections is empty or has no valid entry (spec §6)', () => {
    expect(normalizeSummaryPayload({ ...validPayload(), sections: [] }, 3600)).toBeUndefined();
    expect(
      normalizeSummaryPayload({ ...validPayload(), sections: [{ startSec: 'x', title: '' }] }, 3600),
    ).toBeUndefined();
  });

  it('rejects missing or empty required fields', () => {
    expect(normalizeSummaryPayload({ ...validPayload(), purpose: ' ' }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload({ ...validPayload(), mainArguments: [] }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload({ ...validPayload(), keywords: undefined }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload({ ...validPayload(), conclusion: 42 }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload(null, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload('not an object', 3600)).toBeUndefined();
  });

  it('trims whitespace on string fields', () => {
    const p = validPayload();
    p.purpose = '  문제  ';
    p.mainArguments = ['  주장  '];
    const result = normalizeSummaryPayload(p, 3600);
    expect(result?.purpose).toBe('문제');
    expect(result?.mainArguments).toEqual(['주장']);
  });
});

describe('summaryRetryPlan', () => {
  it('retries bad_json immediately, exactly once (spec §4)', () => {
    expect(summaryRetryPlan('bad_json', 1)).toEqual({ retry: true, delayMs: 0 });
    expect(summaryRetryPlan('bad_json', 2)).toEqual({ retry: false, delayMs: 0 });
  });

  it('retries rate_limit with the hinted delay, capped at 60s, default 5s', () => {
    expect(summaryRetryPlan('rate_limit', 1, 55_000)).toEqual({ retry: true, delayMs: 55_000 });
    expect(summaryRetryPlan('rate_limit', 2, 120_000)).toEqual({ retry: true, delayMs: 60_000 });
    expect(summaryRetryPlan('rate_limit', 1, undefined)).toEqual({ retry: true, delayMs: 5_000 });
  });

  it('never exceeds SUMMARY_MAX_ATTEMPTS and never retries terminal reasons', () => {
    expect(summaryRetryPlan('rate_limit', SUMMARY_MAX_ATTEMPTS)).toEqual({ retry: false, delayMs: 0 });
    expect(summaryRetryPlan('unauthorized', 1)).toEqual({ retry: false, delayMs: 0 });
    expect(summaryRetryPlan('network', 1)).toEqual({ retry: false, delayMs: 0 });
    expect(summaryRetryPlan('unknown', 1)).toEqual({ retry: false, delayMs: 0 });
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm vitest run src/lib/summary.test.ts`
Expected: FAIL — 모듈 `./summary` 없음.

- [ ] **Step 3: 구현**

`src/lib/summary.ts`:

```ts
import type { TranscriptSegment } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';

// The model-facing payload: VideoSummary minus the fields background stamps
// itself (videoId / model / createdAt). Task 3's generateSummary returns
// this; the GENERATE_SUMMARY handler completes it into a VideoSummary.
export type SummaryPayload = Pick<
  VideoSummary,
  'purpose' | 'mainArguments' | 'sections' | 'keywords' | 'conclusion'
>;

// One manual generation is at most 3 Gemini attempts: bad_json retries once
// immediately (spec §4), rate_limit waits the server hint capped at 60s so
// the panel's 180s safety timeout (spec §5) still bounds the whole run.
export const SUMMARY_MAX_ATTEMPTS = 3;
export const SUMMARY_RATE_LIMIT_MAX_DELAY_MS = 60_000;
export const SUMMARY_DEFAULT_RETRY_DELAY_MS = 5_000;

export function buildSummaryPrompt(
  segments: readonly Pick<TranscriptSegment, 'startSec' | 'sourceText'>[],
): string {
  const lines = segments.map((s) => `[${s.startSec}] ${s.sourceText}`).join('\n');
  return `You are summarizing the English transcript of a technical YouTube video for a Korean-speaking learner.

Rules:
- Base every statement strictly on the transcript content. Do NOT add your own opinions, commentary, or outside knowledge.
- Write ALL output values in Korean (keep well-known English technical terms as-is where natural).
- "sections" must follow the talk's actual flow in order. Each section's startSec MUST be one of the [startSec] values present in the transcript below.

Respond with JSON only, matching this shape:
{"purpose": string, "mainArguments": string[], "sections": [{"startSec": number, "title": string}], "keywords": string[], "conclusion": string}

- purpose: what problem this video addresses, one or two sentences.
- mainArguments: 3-5 core claims, one sentence each.
- sections: 4-8 entries covering the talk's flow.
- keywords: 4-8 key technical terms.
- conclusion: the talk's conclusion, one or two sentences.

Transcript ([startSec] English text):
"""
${lines}
"""`;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function nonEmptyStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
  return items.length > 0 ? items : undefined;
}

function isRawSection(v: unknown): v is { startSec: number; title: string } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.startSec === 'number' &&
    Number.isFinite(o.startSec) &&
    typeof o.title === 'string' &&
    o.title.trim().length > 0
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// Validates + normalizes a parsed model response (spec §4): every field
// present and non-empty, section startSec clamped into [0, maxStartSec] and
// sorted ascending, malformed section entries dropped. Returns undefined —
// never throws — so the caller can turn broken output into a bad_json retry.
export function normalizeSummaryPayload(
  parsed: unknown,
  maxStartSec: number,
): SummaryPayload | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const purpose = nonEmptyString(obj.purpose);
  const conclusion = nonEmptyString(obj.conclusion);
  const mainArguments = nonEmptyStringArray(obj.mainArguments);
  const keywords = nonEmptyStringArray(obj.keywords);
  if (!purpose || !conclusion || !mainArguments || !keywords) return undefined;
  if (!Array.isArray(obj.sections)) return undefined;
  const sections = obj.sections
    .filter(isRawSection)
    .map((s) => ({ startSec: clamp(s.startSec, 0, maxStartSec), title: s.title.trim() }))
    .sort((a, b) => a.startSec - b.startSec);
  if (sections.length === 0) return undefined;
  return { purpose, mainArguments, sections, keywords, conclusion };
}

// Bounded retry policy for one manual generation. `attempt` is the 1-based
// attempt that just failed.
export function summaryRetryPlan(
  reason: 'bad_json' | 'rate_limit' | 'unauthorized' | 'network' | 'unknown',
  attempt: number,
  retryDelayMs?: number,
): { retry: boolean; delayMs: number } {
  if (attempt >= SUMMARY_MAX_ATTEMPTS) return { retry: false, delayMs: 0 };
  if (reason === 'bad_json') return { retry: attempt === 1, delayMs: 0 };
  if (reason === 'rate_limit') {
    return {
      retry: true,
      delayMs: Math.min(retryDelayMs ?? SUMMARY_DEFAULT_RETRY_DELAY_MS, SUMMARY_RATE_LIMIT_MAX_DELAY_MS),
    };
  }
  return { retry: false, delayMs: 0 };
}
```

- [ ] **Step 4: GREEN 확인**

Run: `pnpm vitest run src/lib/summary.test.ts`
Expected: PASS 전부.

- [ ] **Step 5: 게이트 + 커밋**

```bash
pnpm tsc --noEmit && pnpm test && pnpm wxt build
git add src/lib/summary.ts src/lib/summary.test.ts
git commit -m "feat(summary): prompt builder, payload normalizer, retry plan (TDD)"
```

---

### Task 3: `generateSummary` Gemini 호출 + 메시지 타입 + background 핸들러

**Files:**
- Modify: `src/lib/gemini.ts` (generateSummary — translateBatch 섹션 뒤에 append)
- Modify: `src/types/message.ts` (AppMessage 2건 + AppResponseMap 2건)
- Modify: `entrypoints/background.ts` (in-flight Map, runSummaryGeneration, handle 케이스 2개)
- Test: `src/lib/gemini.test.ts` (append)

**Interfaces:**
- Consumes: Task 2의 `buildSummaryPrompt`/`normalizeSummaryPayload`/`summaryRetryPlan`/`SummaryPayload`; Task 1의 `VideoSummary`/`putSummary`/`getSummary`; gemini.ts 내부 `callGeminiJson`/`parseJsonResponseText`/`GeminiCallOptions`; background.ts의 `acquireKeepalive`/`releaseKeepalive`/`getApiKey`/`getTranslation`.
- Produces (Task 4가 그대로 사용):
  - `generateSummary(segments: readonly Pick<TranscriptSegment, 'startSec' | 'sourceText'>[], key: string, opts?: GeminiCallOptions): Promise<GenerateSummaryResult>` — `GenerateSummaryResult = { ok: true; payload: SummaryPayload } | { ok: false; reason: GeminiErrorReason | 'bad_json'; message: string; retryDelayMs?: number }`
  - 메시지: `{ type: 'GET_SUMMARY'; payload: { videoId: string } }` → `VideoSummary | null` / `{ type: 'GENERATE_SUMMARY'; payload: { videoId: string } }` → `{ ok: true; summary: VideoSummary } | { ok: false; error: string }`
  - 키 부재 시 `error` 문자열은 정확히 `'API key not set'` (error-display 매핑 키).

- [ ] **Step 1: 실패 테스트 작성 (generateSummary)**

`src/lib/gemini.test.ts`에 append — 파일 상단 import에 `generateSummary` 추가:

```ts
describe('generateSummary', () => {
  const segs = [
    { startSec: 0, sourceText: 'intro' },
    { startSec: 620, sourceText: 'main point' },
  ];
  const payload = {
    purpose: '문제',
    mainArguments: ['주장'],
    sections: [{ startSec: 620, title: '본론' }],
    keywords: ['Agent'],
    conclusion: '결론',
  };

  it('returns the normalized payload on a valid JSON response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({ ok: true, payload });
    const body = requestBody(fetchImpl);
    expect(body.contents[0].parts[0].text).toContain('[620] main point');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('clamps out-of-range section startSec to the last segment start', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ ...payload, sections: [{ startSec: 99999, title: '끝' }] }) }] } }],
      }),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.ok && result.payload.sections[0].startSec).toBe(620);
  });

  it('returns bad_json when the response is not a parseable summary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'bad_json',
      message: 'Could not parse summary response',
    });
  });

  it('propagates rate_limit with structured retryDelayMs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: 'quota exceeded',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '55s' }],
          },
        },
        { status: 429 },
      ),
    );
    const result = await generateSummary(segs, 'AIzaFAKE', { fetchImpl });
    expect(!result.ok && result.reason).toBe('rate_limit');
    expect(!result.ok && result.retryDelayMs).toBe(55_000);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm vitest run src/lib/gemini.test.ts`
Expected: FAIL — `generateSummary` export 없음.

- [ ] **Step 3: gemini.ts 구현**

`src/lib/gemini.ts` — 파일 끝(translateBatch 섹션 뒤)에 append, import에 `buildSummaryPrompt`, `normalizeSummaryPayload`와 `type SummaryPayload`(`./summary`) 추가:

```ts
// ---------------------------------------------------------------------------
// generateSummary — ONE call: whole-video Korean summary (M3 summary panel,
// spec 2026-07-30 §4). Mirrors analyzeGlossary's skeleton; parse/validation
// lives in src/lib/summary.ts so it is unit-testable without fetch.
// ---------------------------------------------------------------------------

export type GenerateSummaryReason = GeminiErrorReason | 'bad_json';

export type GenerateSummaryResult =
  | { ok: true; payload: SummaryPayload }
  | { ok: false; reason: GenerateSummaryReason; message: string; retryDelayMs?: number };

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    purpose: { type: 'STRING' },
    mainArguments: { type: 'ARRAY', items: { type: 'STRING' } },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          startSec: { type: 'NUMBER' },
          title: { type: 'STRING' },
        },
        required: ['startSec', 'title'],
      },
    },
    keywords: { type: 'ARRAY', items: { type: 'STRING' } },
    conclusion: { type: 'STRING' },
  },
  required: ['purpose', 'mainArguments', 'sections', 'keywords', 'conclusion'],
};

export async function generateSummary(
  segments: readonly Pick<TranscriptSegment, 'startSec' | 'sourceText'>[],
  key: string,
  opts: GeminiCallOptions = {},
): Promise<GenerateSummaryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestBody = {
    contents: [{ parts: [{ text: buildSummaryPrompt(segments) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: SUMMARY_SCHEMA,
      // No `thinkingConfig`, for the same reason documented on
      // analyzeGlossary above (explicit budgets 400 on this model).
    },
  };

  const result = await callGeminiJson(key, requestBody, fetchImpl);
  if (!result.ok) return result;

  const maxStartSec = segments.length > 0 ? segments[segments.length - 1].startSec : 0;
  const payload = normalizeSummaryPayload(parseJsonResponseText(result.text), maxStartSec);
  if (!payload) {
    return { ok: false, reason: 'bad_json', message: 'Could not parse summary response' };
  }
  return { ok: true, payload };
}
```

- [ ] **Step 4: GREEN 확인**

Run: `pnpm vitest run src/lib/gemini.test.ts`
Expected: PASS 전부.

- [ ] **Step 5: 메시지 타입 추가**

`src/types/message.ts`:

1. 파일 상단 import에 `import type { VideoSummary } from './summary';` 추가.
2. `AppMessage` union 마지막(`GET_TRANSLATION` 항목 뒤)에:

```ts
  // panel -> background: read the cached summary for a video (summary spec
  // §3). `null` follows GET_TRANSLATION's convention — nothing cached yet.
  | { type: 'GET_SUMMARY'; payload: { videoId: string } }
  // panel -> background: generate (or regenerate — same-key overwrite) the
  // Korean summary for an already-`done` translation. Resolves once the
  // summary is persisted or generation failed; a lost response (SW evicted)
  // is covered by the panel's safety-timeout GET_SUMMARY refetch (spec §5).
  | { type: 'GENERATE_SUMMARY'; payload: { videoId: string } };
```

3. `AppResponseMap`에 (GET_TRANSLATION 항목 뒤):

```ts
  GET_SUMMARY: VideoSummary | null;
  // `error` is the raw English reason message; the panel maps it to Korean
  // via translationErrorDisplay. A missing key is exactly 'API key not set'.
  GENERATE_SUMMARY: { ok: true; summary: VideoSummary } | { ok: false; error: string };
```

- [ ] **Step 6: background 핸들러 구현**

`entrypoints/background.ts`:

1. import 추가: `generateSummary`(기존 gemini import에), `MODEL_ID`(gemini), `getSummary`, `putSummary`(기존 db import에), `summaryRetryPlan`(`~/lib/summary`), `import type { VideoSummary } from '~/types/summary';`
2. `inFlightTranslations` 선언 아래에:

```ts
// Summary spec §3 — GENERATE_SUMMARY dedup: concurrent requests for the same
// video share one in-flight Promise instead of firing a second Gemini call
// (the panel's retry-after-timeout path joins the running job for free).
// The entry is removed when the promise settles, so a retry after a real
// failure starts a fresh run.
const inFlightSummaries = new Map<string, Promise<AppResponseMap['GENERATE_SUMMARY']>>();

async function runSummaryGeneration(videoId: string): Promise<AppResponseMap['GENERATE_SUMMARY']> {
  const key = await getApiKey();
  if (key === null) return { ok: false, error: 'API key not set' };

  const record = await getTranslation(videoId);
  if (!record || record.status !== 'done' || record.segments.length === 0) {
    // The panel gates the Summary tab on a done record, so reaching this is
    // a caller bug or a race with cache clearing — fail explicitly.
    return { ok: false, error: 'No completed translation for this video' };
  }

  // Same keepalive discipline as the translation pipeline (Task R4): hold
  // the SW open for the duration of the (possibly retried) Gemini call.
  acquireKeepalive();
  try {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await generateSummary(record.segments, key);
      if (result.ok) {
        const summary: VideoSummary = {
          videoId,
          ...result.payload,
          model: MODEL_ID,
          createdAt: new Date().toISOString(),
        };
        await putSummary(summary);
        return { ok: true, summary };
      }
      const plan = summaryRetryPlan(result.reason, attempt, result.retryDelayMs);
      if (!plan.retry) return { ok: false, error: result.message };
      if (plan.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
      }
    }
  } finally {
    releaseKeepalive();
  }
}
```

3. `handle()`의 switch에 `GET_TRANSLATION` 케이스 뒤로 추가:

```ts
    case 'GET_SUMMARY': {
      const { payload } = msg as Extract<AppMessage, { type: 'GET_SUMMARY' }>;
      return (await getSummary(payload.videoId)) as AppResponseMap[T];
    }
    case 'GENERATE_SUMMARY': {
      const { payload } = msg as Extract<AppMessage, { type: 'GENERATE_SUMMARY' }>;
      let job = inFlightSummaries.get(payload.videoId);
      if (!job) {
        job = runSummaryGeneration(payload.videoId).finally(() => {
          inFlightSummaries.delete(payload.videoId);
        });
        inFlightSummaries.set(payload.videoId, job);
      }
      return (await job) as AppResponseMap[T];
    }
```

- [ ] **Step 7: 게이트 + 커밋**

```bash
pnpm tsc --noEmit && pnpm test && pnpm wxt build
git add src/lib/gemini.ts src/lib/gemini.test.ts src/types/message.ts entrypoints/background.ts
git commit -m "feat(bg): GENERATE_SUMMARY/GET_SUMMARY with single-flight and bounded retry"
```

---

### Task 4: 패널 — `useSummary` 훅 · `SummaryPanel` · ReadyBody 탭

**Files:**
- Create: `src/features/summary/useSummary.ts`
- Create: `src/components/SummaryPanel.tsx`
- Modify: `entrypoints/sidepanel/App.tsx` (ReadyBody — 탭 + 훅 배선)

**Interfaces:**
- Consumes: Task 3의 메시지 계약; `sendMessage(msg)`(`~/lib/messaging` — **메시지 객체 하나를 받는다**: `sendMessage({ type: 'GET_SUMMARY', payload: { videoId } })`); `formatTimestamp(startSec)`(`~/lib/transcript-parse`); `translationErrorDisplay(reason)`(`~/features/translation/error-display`); ReadyBody의 기존 `playback`(usePlaybackSync)·`showTranscriptList`·`useElapsedSeconds`.
- Produces:
  - `useSummary({ videoId: string | null; enabled: boolean }): { summary: VideoSummary | null; status: 'idle' | 'loading' | 'generating' | 'done' | 'failed'; error: string | null; generate(): void }`
  - `<SummaryPanel summary status error elapsedSeconds onGenerate onSeekSection />`

- [ ] **Step 1: useSummary 훅 작성**

`src/features/summary/useSummary.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import type { VideoSummary } from '~/types/summary';

export type SummaryStatus = 'idle' | 'loading' | 'generating' | 'done' | 'failed';

// Spec §5 — panel-side safety net. If the GENERATE_SUMMARY response never
// arrives (SW evicted / channel dropped mid-call), refetch the cache once
// after this long and converge: cache hit -> done, still nothing -> failed.
// Longer than bg's common path (one 120s-capped fetch + one immediate
// bad_json retry); a user retry after this joins bg's in-flight job via the
// single-flight map, so no double billing.
export const SUMMARY_SAFETY_TIMEOUT_MS = 180_000;

interface UseSummaryParams {
  videoId: string | null;
  enabled: boolean;
}

export interface UseSummaryResult {
  summary: VideoSummary | null;
  status: SummaryStatus;
  error: string | null;
  generate: () => void;
}

export function useSummary({ videoId, enabled }: UseSummaryParams): UseSummaryResult {
  const [summary, setSummary] = useState<VideoSummary | null>(null);
  const [status, setStatus] = useState<SummaryStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // Cycle counter: a response or timer from a previous videoId/enabled cycle
  // must not touch current state — same discipline as useTranslation's
  // generation guards and usePlaybackSync's cancelled flag.
  const cycleRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    cycleRef.current += 1;
    const cycle = cycleRef.current;
    clearTimer();
    setSummary(null);
    setError(null);
    if (!enabled || videoId === null) {
      setStatus('idle');
      return clearTimer;
    }
    setStatus('loading');
    void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
      (cached) => {
        if (cycleRef.current !== cycle) return;
        setSummary(cached);
        setStatus(cached ? 'done' : 'idle');
      },
      () => {
        if (cycleRef.current !== cycle) return;
        setStatus('idle');
      },
    );
    return clearTimer;
  }, [videoId, enabled]);

  const generate = useCallback(() => {
    if (videoId === null) return;
    const cycle = cycleRef.current;
    setStatus('generating');
    setError(null);
    clearTimer();
    timerRef.current = setTimeout(() => {
      void sendMessage({ type: 'GET_SUMMARY', payload: { videoId } }).then(
        (cached) => {
          if (cycleRef.current !== cycle) return;
          if (cached) {
            setSummary(cached);
            setStatus('done');
          } else {
            setStatus('failed');
            setError('Summary generation timed out');
          }
        },
        () => {
          if (cycleRef.current !== cycle) return;
          setStatus('failed');
          setError('Summary generation timed out');
        },
      );
    }, SUMMARY_SAFETY_TIMEOUT_MS);
    void sendMessage({ type: 'GENERATE_SUMMARY', payload: { videoId } }).then(
      (res) => {
        if (cycleRef.current !== cycle) return;
        clearTimer();
        if (res.ok) {
          setSummary(res.summary);
          setStatus('done');
        } else {
          setStatus('failed');
          setError(res.error);
        }
      },
      () => {
        // A rejected sendMessage usually means the SW dropped the channel,
        // not that generation failed — leave the safety timer to decide.
      },
    );
  }, [videoId]);

  return { summary, status, error, generate };
}
```

- [ ] **Step 2: SummaryPanel 컴포넌트 작성**

`src/components/SummaryPanel.tsx`:

```tsx
import { translationErrorDisplay } from '~/features/translation/error-display';
import { formatTimestamp } from '~/lib/transcript-parse';
import type { SummaryStatus } from '~/features/summary/useSummary';
import type { VideoSummary } from '~/types/summary';

// Section label style matches App.tsx's existing "자막 표시"/"번역 결과"
// micro-labels; row hover/press affordances mirror TranscriptList's rows.
const LABEL_CLS =
  'text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500';

interface SummaryPanelProps {
  summary: VideoSummary | null;
  status: SummaryStatus;
  error: string | null;
  elapsedSeconds: number;
  onGenerate: () => void;
  onSeekSection: (startSec: number) => void;
}

export function SummaryPanel({
  summary,
  status,
  error,
  elapsedSeconds,
  onGenerate,
  onSeekSection,
}: SummaryPanelProps) {
  if (status === 'loading') {
    return <p className="px-4 py-6 text-[12px] text-neutral-400 dark:text-neutral-500">요약 불러오는 중…</p>;
  }

  if (status === 'generating') {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 dark:border-neutral-700 dark:border-t-neutral-200" />
        <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
          요약 생성 중… {elapsedSeconds}초
        </p>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-6">
        <p className="text-[12.5px] leading-relaxed text-red-600 dark:text-red-400">
          {translationErrorDisplay(error ?? '')}
        </p>
        <button
          type="button"
          onClick={onGenerate}
          className="rounded-[7px] border border-neutral-200 px-4 py-2 text-[12.5px] font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          다시 시도
        </button>
      </div>
    );
  }

  if (summary === null) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          이 영상의 핵심 요약을 만들 수 있어요.
          <br />
          문제·핵심 주장·발표 흐름·키워드·결론으로 정리됩니다.
        </p>
        <button
          type="button"
          onClick={onGenerate}
          className="rounded-[7px] bg-neutral-900 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-black dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          요약 생성
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <div className="flex items-center justify-between">
        <span className={LABEL_CLS}>이 영상이 다루는 문제</span>
        <button
          type="button"
          onClick={onGenerate}
          className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
        >
          다시 생성
        </button>
      </div>
      <p className="-mt-3 text-[12.5px] leading-relaxed text-neutral-800 dark:text-neutral-200">
        {summary.purpose}
      </p>

      <div className="flex flex-col gap-2">
        <span className={LABEL_CLS}>핵심 주장</span>
        {summary.mainArguments.map((arg, i) => (
          <div key={i} className="flex gap-2">
            <span className="pt-[2px] font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="text-[12.5px] leading-relaxed text-neutral-800 dark:text-neutral-200">
              {arg}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <span className={LABEL_CLS}>발표 흐름</span>
        {summary.sections.map((section, i) => (
          <div
            key={i}
            role="button"
            tabIndex={0}
            onClick={() => onSeekSection(section.startSec)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSeekSection(section.startSec);
              }
            }}
            className="flex cursor-pointer gap-2.5 border-b border-neutral-100 py-1.5 last:border-b-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900"
          >
            <span className="w-[38px] flex-none font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(section.startSec)}
            </span>
            <span className="text-[12.5px] text-neutral-800 dark:text-neutral-200">{section.title}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <span className={LABEL_CLS}>주요 키워드</span>
        <div className="flex flex-wrap gap-1.5">
          {summary.keywords.map((keyword, i) => (
            <span
              key={i}
              className="rounded border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
            >
              {keyword}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <span className={LABEL_CLS}>결론</span>
        <p className="text-[12.5px] leading-relaxed text-neutral-800 dark:text-neutral-200">
          {summary.conclusion}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: ReadyBody 배선 (App.tsx)**

`entrypoints/sidepanel/App.tsx` 수정:

1. import 추가:

```ts
import { SummaryPanel } from '~/components/SummaryPanel';
import { useSummary } from '~/features/summary/useSummary';
```

2. ReadyBody 안, **`usePlaybackSync` 호출/`activeIndex` 계산 바로 아래, `no-metadata` early return(`if (!loading && video === null)`) 위**에 (Global Constraints의 훅 규칙 — 모든 훅은 early return 위):

```ts
  // Summary tab (M3 spec §5). All three hooks live above the no-metadata
  // early return for the same Rules-of-Hooks reason documented on
  // showTranscriptList above.
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary'>('transcript');
  const summaryState = useSummary({ videoId, enabled: showTranscriptList });
  const summaryElapsedSeconds = useElapsedSeconds(summaryState.status === 'generating');
```

3. 기존 `번역 결과` 블록(`{showTranscriptList && record !== null && (...)}`) 전체를 다음으로 교체:

```tsx
      {showTranscriptList && record !== null && (
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          <div className="flex border-b border-neutral-200 dark:border-neutral-800" role="tablist">
            {(
              [
                ['transcript', 'Transcript'],
                ['summary', 'Summary'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 border-0 py-2.5 text-[12px] ${
                  activeTab === tab
                    ? 'font-semibold text-neutral-900 shadow-[inset_0_-2px_0_0_currentColor] dark:text-neutral-100'
                    : 'text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {activeTab === 'transcript' ? (
            <TranscriptList
              segments={record.segments}
              displayMode={displayMode}
              activeIndex={activeIndex}
              onSeekRow={(segment) => playback.seek(segment.startSec)}
            />
          ) : (
            <SummaryPanel
              summary={summaryState.summary}
              status={summaryState.status}
              error={summaryState.error}
              elapsedSeconds={summaryElapsedSeconds}
              onGenerate={summaryState.generate}
              onSeekSection={(startSec) => playback.seek(startSec)}
            />
          )}
        </div>
      )}
```

(기존 `번역 결과` 마이크로 라벨 `<div className="px-4 pt-3.5">…</div>`는 탭 바가 대체하므로 삭제.)

- [ ] **Step 4: 게이트**

Run: `pnpm tsc --noEmit && pnpm test && pnpm wxt build`
Expected: 전부 통과 — 기존 TranscriptList/App 테스트 무수정 통과. **주의**: 훅 순서 규칙 — ReadyBody의 어떤 훅도 early return 아래로 내려가면 안 된다. 수정 후 ReadyBody를 위에서 아래로 읽어 `return`문 위에 모든 훅이 있는지 눈으로 재확인하고, 그 확인 결과를 보고서에 한 줄로 남겨라.

- [ ] **Step 5: 커밋**

```bash
git add src/features/summary/useSummary.ts src/components/SummaryPanel.tsx entrypoints/sidepanel/App.tsx
git commit -m "feat(panel): Summary tab — useSummary hook, SummaryPanel, section click-to-seek"
```

---

### Task 5: 실 Chrome 검증 (컨트롤러 주도, CDP)

**Files:** 없음 (검증 전용 — 스크립트는 세션 스크래치패드에서).

**Interfaces:**
- Consumes: 빌드된 확장(`.output/chrome-mv3`), CDP(9222), 번역 `done` 레코드 보유 영상(`kwSVtQ7dziU` 322행 — 세션 확인됨).

검증 항목 (스펙 §7) — 각각 stdout 원문을 원장에 남긴다:

- [ ] **Step 1: 확장 리로드 + 패널-탭 오픈** (`Extensions.loadUnpacked` 동일 경로, YT 탭 리로드로 고아 CS 방지 — dev Chrome이 꺼져 있으면 사용자에게 실행 요청; `scripts/dev-chrome.mjs` 사용 금지).
- [ ] **Step 2: 요약 생성 실측** — done 레코드 영상에서 Summary 탭 클릭(CDP) → `요약 생성` 클릭 → generating 스피너 확인 → 완료까지 폴링(최대 180s) → 5개 섹션(`이 영상이 다루는 문제`/`핵심 주장`/`발표 흐름`/`주요 키워드`/`결론`) DOM 렌더 실측. Expected: 전부 렌더, 발표 흐름 행 ≥1개.
- [ ] **Step 3: 캐시 즉시 로드** — 패널-탭 닫고 다시 열기 → Summary 탭 → Gemini 재호출 없이(생성 스피너 없이) 즉시 렌더. Expected: `요약 생성` 버튼 대신 요약 본문이 바로 보임.
- [ ] **Step 4: 발표 흐름 클릭 시크** — 발표 흐름 행 N 클릭 → 영상 탭 `video.currentTime`이 해당 `startSec` ±1s. Expected: 일치 (하이라이트는 Transcript 탭 전환 후 확인 가능하나 본 검증 범위 아님).
- [ ] **Step 5: 키 상태 불변** — `GET_API_KEY_STATUS`로 `savedAt` 이 세션 시작값과 동일한지 확인. Expected: 불변.
- [ ] **Step 6: 원장 기록** — 각 스텝 stdout 원문 append.

---

## Self-Review 결과 (작성 후 점검)

- **스펙 커버리지**: §2(스토어·타입) → Task 1, §3(메시지·bg·in-flight·keepalive) → Task 3, §4(프롬프트·스키마·검증·재시도) → Task 2+3, §5(훅·탭·5섹션·시크·다시 생성) → Task 4, §6(에러·엣지: 키 부재 'API key not set' 문자열 → Task 3, 타임아웃 수렴 → Task 4 훅, sections 빈 배열 거부 → Task 2), §7(검증) → Task 1·2·3 테스트 + Task 5. 잔여 갭 없음.
- **플레이스홀더 스캔**: 코드 스텝 전부 실코드. 통과.
- **타입 일관성**: `VideoSummary`(T1) → db/message/bg/훅/컴포넌트 동일 시그니처; `SummaryPayload`(T2) → `generateSummary`(T3) 반환·bg 완성 지점 일치; `sendMessage`는 메시지 객체 단일 인자(T4에 명시); `summaryRetryPlan(reason, attempt, retryDelayMs)`(T2) → bg 루프(T3) 호출 일치; `formatTimestamp`는 기존 `~/lib/transcript-parse` export 재사용. `createdAt: string(ISO)`는 스펙 초안 `number`에서의 의도적 이탈로 T1에 문서화.
