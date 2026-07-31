# Language Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop assuming English source and Korean target: translation/glossary/summary prompts become source-agnostic and target-parameterized (ko/en/ja/zh), the target language is a single global setting editable from both the panel and Options, and cached records carry a `targetLang` stamp with a mismatch banner + 다시 생성 flow.

**Architecture:** New `src/lib/target-lang.ts` setting module (panel-prefs pattern). `gemini.ts`/`summary.ts` prompt builders take an explicit `targetLang`. Background reads the setting once per job, threads it through the pipeline, and stamps records; resume honors the record's stamp, and a language-mismatched restart is a fresh start. Panel adds a 번역 언어 select + mismatch banners; Options adds a 기본 번역 언어 section.

**Tech Stack:** WXT + React 19 + TypeScript, vitest, chrome.storage.local, Gemini API.

**Spec:** `docs/superpowers/specs/2026-07-31-lang-generalization-design.md`

## Global Constraints

- UI copy is Korean (content language is what changes, never the UI language).
- **Rules of Hooks:** every hook added to ReadyBody sits above the no-metadata early return (`if (!loading && video === null)`) in `entrypoints/sidepanel/App.tsx`.
- Storage key exactly `translationTargetLang`; values exactly `'ko' | 'en' | 'ja' | 'zh'`; default `'ko'`. Legacy records without `targetLang` are treated as `'ko'` everywhere.
- Only user actions write the setting (select onChange in panel/Options). Reading never writes.
- Automatic re-translation is forbidden: changing the language never starts a job by itself — the banner + existing 다시 생성 button is the only path.
- Do not change: DB version/store shapes (the new record field is optional — no migration), API-key storage, host_permissions, surfaces, `?key=` transport (stays as-is this cycle).
- Prompt output-shape contracts (JSON schemas' field names other than `keepEnglish`→`keepOriginal`) unchanged.
- Gates before every commit: `npx tsc --noEmit` (0), `npx vitest run` (all pass); tasks touching `entrypoints/` also `npm run build`.

---

### Task 1: target-lang setting module

**Files:**
- Create: `src/lib/target-lang.ts`
- Test: `src/lib/target-lang.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `type TargetLang = 'ko' | 'en' | 'ja' | 'zh'`
  - `const DEFAULT_TARGET_LANG: TargetLang = 'ko'`
  - `const TARGET_LANGS: readonly TargetLang[]`
  - `const TARGET_LANG_LABELS: Record<TargetLang, string>` — `{ ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' }`
  - `const TARGET_LANG_NAMES: Record<TargetLang, string>` — `{ ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese (Simplified)' }`
  - `getTargetLang(): Promise<TargetLang>` (missing/invalid → `'ko'`)
  - `saveTargetLang(lang: TargetLang): Promise<void>`
  - `const TARGET_LANG_STORAGE_KEY = 'translationTargetLang'` (exported — the panel's storage.onChanged listener needs it)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/target-lang.test.ts` with the chrome mock copied from `src/lib/panel-prefs.test.ts`'s beforeEach (in-memory `store` fake with get/set), then:

```ts
describe('getTargetLang', () => {
  it('returns ko when nothing is stored', async () => {
    expect(await getTargetLang()).toBe('ko');
  });
  it('returns each stored valid value', async () => {
    for (const lang of ['ko', 'en', 'ja', 'zh']) {
      store.translationTargetLang = lang;
      expect(await getTargetLang()).toBe(lang);
    }
  });
  it('falls back to ko on invalid values', async () => {
    store.translationTargetLang = 'fr';
    expect(await getTargetLang()).toBe('ko');
    store.translationTargetLang = 42;
    expect(await getTargetLang()).toBe('ko');
  });
});
describe('saveTargetLang', () => {
  it('writes only its own key and round-trips', async () => {
    store.panelDisplayMode = 'ko';
    await saveTargetLang('ja');
    expect(store.translationTargetLang).toBe('ja');
    expect(store.panelDisplayMode).toBe('ko');
    expect(await getTargetLang()).toBe('ja');
  });
});
describe('label tables', () => {
  it('cover every TargetLang', () => {
    for (const lang of TARGET_LANGS) {
      expect(TARGET_LANG_LABELS[lang]).toBeTruthy();
      expect(TARGET_LANG_NAMES[lang]).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/target-lang.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// The translation TARGET language — a pipeline setting, not a panel display
// preference (background reads it per job), which is why it lives apart
// from panel-prefs. One global value, edited from both the panel's 번역
// 언어 select and the Options page's 기본 번역 언어 select — both write
// this same key.
export const TARGET_LANG_STORAGE_KEY = 'translationTargetLang';

export type TargetLang = 'ko' | 'en' | 'ja' | 'zh';

export const TARGET_LANGS: readonly TargetLang[] = ['ko', 'en', 'ja', 'zh'];
export const DEFAULT_TARGET_LANG: TargetLang = 'ko';

/** UI labels (the panel/Options UI itself stays Korean). */
export const TARGET_LANG_LABELS: Record<TargetLang, string> = {
  ko: '한국어',
  en: '영어',
  ja: '일본어',
  zh: '중국어',
};

/** English language names, for embedding in Gemini prompts. */
export const TARGET_LANG_NAMES: Record<TargetLang, string> = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese (Simplified)',
};

export async function getTargetLang(): Promise<TargetLang> {
  const record = await chrome.storage.local.get(TARGET_LANG_STORAGE_KEY);
  const raw = record[TARGET_LANG_STORAGE_KEY];
  return TARGET_LANGS.includes(raw as TargetLang) ? (raw as TargetLang) : DEFAULT_TARGET_LANG;
}

export async function saveTargetLang(lang: TargetLang): Promise<void> {
  await chrome.storage.local.set({ [TARGET_LANG_STORAGE_KEY]: lang });
}
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Gates + commit**

```bash
git add src/lib/target-lang.ts src/lib/target-lang.test.ts
git commit -m "feat(lang): target-lang setting module (ko/en/ja/zh, storage-backed)"
```

---

### Task 2: Generalize Gemini prompts (translate + glossary), keepEnglish → keepOriginal

**Files:**
- Modify: `src/lib/gemini.ts` (ANALYZE_GLOSSARY_SCHEMA ~:235, `buildAnalyzeGlossaryPrompt` ~:256, `isGlossaryEntry` ~:272, `analyzeGlossary` ~:292, TRANSLATION_RULES ~:363, `buildGlossaryBlock` ~:371, `buildTranslateBatchPrompt` ~:381, `translateBatch` export)
- Modify: `src/types/transcript.ts` (`GlossaryEntry.keepEnglish` → `keepOriginal`)
- Modify: `src/lib/gemini.test.ts` + any other test/`pipeline.ts` site referencing `keepEnglish` (grep)
- Test: extend `src/lib/gemini.test.ts`

**Interfaces:**
- Consumes (Task 1): `type TargetLang`, `TARGET_LANG_NAMES` from `~/lib/target-lang`.
- Produces (Task 3/bg rely on): `analyzeGlossary(fullText, key, targetLang, opts?)`, `translateBatch(segs, glossary, key, targetLang, opts?)` — `targetLang` as a new required positional param BEFORE `opts`. `GlossaryEntry { term; translation; keepOriginal: boolean }`.

- [ ] **Step 1: Update the type** — in `src/types/transcript.ts` rename `keepEnglish` to `keepOriginal` on `GlossaryEntry` (keep the doc comment's meaning: "keep the original-language term as-is instead of translating it").

- [ ] **Step 2: Update tests first** — in `src/lib/gemini.test.ts`: rename every `keepEnglish` fixture/assertion to `keepOriginal`; add/adjust prompt assertions:

```ts
it('embeds the target language name in the translate prompt', () => {
  const p = buildTranslateBatchPrompt(segs, [], 'ja');
  expect(p).toContain('into Japanese');
  expect(p).not.toMatch(/\bKorean convention\b/);
  expect(p).toContain('Japanese convention');
});
it('embeds the target language in the glossary prompt and keepOriginal in its schema shape', () => {
  const p = buildAnalyzeGlossaryPrompt('hello world', 'zh');
  expect(p).toContain('Chinese (Simplified)');
  expect(p).toContain('keepOriginal');
  expect(p).not.toContain('keepEnglish');
});
```

(Export `buildAnalyzeGlossaryPrompt`/`buildTranslateBatchPrompt` for tests if not already exported — follow the file's existing export style for tested internals.)

- [ ] **Step 3: Implement the generalization.** Exact new prompt texts:

`buildAnalyzeGlossaryPrompt(fullText: string, targetLang: TargetLang)` — with `const name = TARGET_LANG_NAMES[targetLang]`:

```
You are analyzing the transcript of a technical YouTube video (it may be in any language) to prepare a ${name}-translation glossary.

Identify:
1. The video's topic, as one concise sentence.
2. Key technical terms (library/product names, jargon, recurring concepts) that should be translated consistently, with the recommended ${name} handling for each: the ${name} translation to use, and whether the original term should be kept as-is (keepOriginal: true) instead of translated.

Respond with JSON only, matching this shape:
{"topic": string, "glossary": [{"term": string, "translation": string, "keepOriginal": boolean}]}

Transcript:
"""
${fullText}
"""
```

`ANALYZE_GLOSSARY_SCHEMA`: rename the `keepEnglish` property and `required` entry to `keepOriginal`. `isGlossaryEntry`: check `keepOriginal`.

`TRANSLATION_RULES` becomes `translationRulesFor(name: string)` returning:

```
Translation rules:
- Do not translate code, commands, URLs, or library/product names.
- For technical terms, prefer the established ${name} convention; add the original term in parentheses when it helps clarity.
- Keep terminology consistent with the glossary below — reuse its translations exactly wherever a listed term appears.
- Do not add any AI commentary, opinions, or explanations. Translate only.
- Translate each segment's text independently; do not merge, split, or reorder segments.
```

`buildGlossaryBlock`: `keepOriginal` branch renders `- ${entry.term} -> keep in original language`.

`buildTranslateBatchPrompt(segs, glossary, targetLang)` — with `const name = TARGET_LANG_NAMES[targetLang]`:

```
You are translating YouTube transcript segments into ${name}. The source may be in any language.

${translationRulesFor(name)}

Glossary:
${buildGlossaryBlock(glossary)}

Translate each numbered segment below into ${name}. Respond with JSON only: an array of {"index": number, "translatedText": string}, one entry per segment below, using the exact same index numbers.

Segments:
${segmentsText}
```

`analyzeGlossary` and `translateBatch` gain the `targetLang: TargetLang` positional param (before `opts`) and pass it to their prompt builders. Fix every caller/reference that `grep -rn "keepEnglish" src entrypoints` still finds (pipeline comments included).

- [ ] **Step 4: Gates** — tsc will flag the bg/pipeline call sites of `analyzeGlossary`/`translateBatch` still passing the old arity: patch those call sites MINIMALLY by passing `'ko'` as a placeholder literal with a `// Task 3 threads the real setting` comment (Task 3 replaces them — this keeps Task 2 self-contained and green). `npx vitest run` all pass.

- [ ] **Step 5: Commit** — `git commit -m "feat(lang): target-parameterized translate/glossary prompts, keepOriginal semantics"`

---

### Task 3: Thread targetLang through background + pipeline + summary; stamp records

**Files:**
- Modify: `src/types/transcript.ts` (`TranslationRecord` gains `targetLang?: TargetLang`), `src/types/summary.ts` (`VideoSummary` gains `targetLang?: TargetLang`)
- Modify: `src/lib/summary.ts` (`buildSummaryPrompt(segments, targetLang)`) and `src/lib/gemini.ts` `generateSummary` (gains `targetLang` positional param before `opts`, passes to the prompt)
- Modify: `src/features/translation/pipeline.ts` (params gain `targetLang: TargetLang`; record-construction sites stamp it; resume + mismatch-restart rules below)
- Modify: `entrypoints/background.ts` (`START_TRANSLATION` + auto-resume path + `runSummaryGeneration` read the language and thread it; replace Task 2's `'ko'` placeholders)
- Test: `src/lib/summary.test.ts`, `src/background.test.ts`, pipeline tests (`src/features/translation/*.test.ts` if present — follow existing patterns)

**Interfaces:**
- Consumes: Task 1's `getTargetLang`/`TargetLang`; Task 2's new signatures.
- Produces: records persisted with `targetLang`; `buildSummaryPrompt(segments, targetLang)`.

- [ ] **Step 1: Types** — add `targetLang?: TargetLang;` to `TranslationRecord` and `VideoSummary` with a comment: optional because pre-existing records lack it; every reader treats `undefined` as `'ko'`.

- [ ] **Step 2: Summary prompt** — `buildSummaryPrompt(segments, targetLang)`: with `const name = TARGET_LANG_NAMES[targetLang]`, the opening line becomes `You are summarizing the transcript of a technical YouTube video (it may be in any language) for a learner who reads ${name}.`, the output-language rule becomes `- Write ALL output values in ${name} (keep well-known technical terms in their original form where natural).`, and the trailing `Transcript ([startSec] English text):` label becomes `Transcript ([startSec] source text):`. Structure/shape/guardrails otherwise unchanged. Update `summary.test.ts` accordingly and add: `expect(buildSummaryPrompt(segs, 'ja')).toContain('Japanese')`.

- [ ] **Step 3: Pipeline threading** — `runTranslationPipeline` params gain `targetLang: TargetLang`. Inside:
  - Every site that CONSTRUCTS a `TranslationRecord` object literal stamps `targetLang` (find them all — grep for `videoId,` + `status:` literals; the reviewer will check for missed sites).
  - **Resume consistency:** where the pipeline loads an existing non-terminal record to resume, the EFFECTIVE language for the rest of the job is `existing.targetLang ?? 'ko'`, not the incoming param — assign it once to a local and use that local everywhere below (prompt calls via deps + stamps).
  - **Mismatch restart:** where the pipeline decides it can reuse the existing record's glossary/completed batches, add the guard: if `(existing.targetLang ?? 'ko') !== targetLang` (the incoming job's), treat the record as absent — full fresh start, no glossary reuse, no batch reuse, and the fresh record stamps the incoming `targetLang`.
  - **Precedence between the two rules — record state decides:** a NON-terminal record (job interrupted mid-flight, e.g. SW eviction) always RESUMES in its stamped language, even if the setting changed meanwhile; the mismatch-restart guard applies only to TERMINAL records (`done`/`failed`), where a differing language means the user deliberately switched and wants a fresh result.
  - Deps signatures gain a `targetLang` LAST param — `analyzeGlossary: (fullText, key, targetLang)`, `translateBatch: (segs, glossary, key, targetLang)` — and the pipeline passes its effective local into every call. Do NOT have background close over the language when building deps: the effective language is decided INSIDE the pipeline (resume rule above), so it must flow through the call, not the closure. Update the deps interface + bg injections + test fakes accordingly.
- [ ] **Step 4: Background** — `START_TRANSLATION`: `const targetLang = await getTargetLang();` after the key check, passed in pipeline params; deps injections forward their `targetLang` arg to the real `analyzeGlossary`/`translateBatch` (replacing Task 2's `'ko'` placeholders). Auto-resume path (the handler that restarts unfinished jobs, if it constructs params separately) does the same — the pipeline's resume rule overrides with the record's stamp anyway. `runSummaryGeneration`: read `getTargetLang()`, pass to `generateSummary`, stamp the persisted summary `{ ..., targetLang }`.

- [ ] **Step 5: Tests** — update fakes/mocks for new arities. Add:
  - background.test.ts: GENERATE_SUMMARY stamps the stored summary with the configured language (set `translationTargetLang: 'ja'` in the fake storage; assert `putSummary` received `targetLang: 'ja'`).
  - pipeline tests (in the existing file that tests `runTranslationPipeline`, same fake-deps pattern): ① fresh run stamps records with the param language ② NON-terminal existing record (mid-flight resume after eviction) stamped `'ko'` + param `'ja'` → job completes in `'ko'` (assert deps received `'ko'`) — record state decides: non-terminal means resume, and resume honors the record's language ③ TERMINAL record (`done` or `failed`) stamped `'ko'` + param `'ja'` → fresh restart in `'ja'`: no glossary/batch reuse (assert `analyzeGlossary` called again) and the new record stamps `'ja'`.

- [ ] **Step 6: Gates + commit** — `git commit -m "feat(lang): thread targetLang through pipeline/summary, stamp records, resume-safe"`

---

### Task 4: Panel UI — 번역 언어 select, neutral labels, mismatch banners

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx`

**Interfaces:**
- Consumes: Task 1 (`getTargetLang`, `saveTargetLang`, `TARGET_LANGS`, `TARGET_LANG_LABELS`, `TARGET_LANG_STORAGE_KEY`, `TargetLang`), records' `targetLang` (Task 3).

- [ ] **Step 1: State + sync (hooks above the early return).** In ReadyBody, next to the panel-prefs load:

```ts
  // 번역 언어 — the global translation target (spec 2026-07-31-lang-…).
  // Mirrors chrome.storage so a change made on the Options page while the
  // panel is open is reflected here too (and vice versa — both surfaces
  // edit the same key). Reading never writes; only the select's onChange
  // persists.
  const [targetLang, setTargetLang] = useState<TargetLang>(DEFAULT_TARGET_LANG);
  useEffect(() => {
    let cancelled = false;
    void getTargetLang().then((lang) => {
      if (!cancelled) setTargetLang(lang);
    }).catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !(TARGET_LANG_STORAGE_KEY in changes)) return;
      const next = changes[TARGET_LANG_STORAGE_KEY].newValue;
      if (TARGET_LANGS.includes(next as TargetLang)) setTargetLang(next as TargetLang);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
```

- [ ] **Step 2: The select.** Restructure the 자막 표시 block into a two-column row (keep the existing segmented buttons markup as-is inside its column):

```tsx
      <div className="flex gap-3 px-4">
        <div className="min-w-0 flex-1">
          {/* existing 자막 표시 label + segmented buttons, unchanged */}
        </div>
        <div className="flex w-[104px] shrink-0 flex-col">
          <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
            번역 언어
          </span>
          <select
            value={targetLang}
            onChange={(e) => {
              const lang = e.target.value as TargetLang;
              setTargetLang(lang);
              void saveTargetLang(lang).catch(() => {});
            }}
            className="mt-2 w-full rounded-[7px] border border-neutral-200 bg-white py-2 pl-2 pr-1 text-[11.5px] text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100"
          >
            {TARGET_LANGS.map((lang) => (
              <option key={lang} value={lang}>
                {TARGET_LANG_LABELS[lang]}
              </option>
            ))}
          </select>
        </div>
      </div>
```

- [ ] **Step 3: Neutral labels + copy.** `DISPLAY_MODE_OPTIONS` labels: `원문+한국어`→`원문+번역`, `한국어만`→`번역만`. In `processingLabel`, both `한국어 번역 중…` literals → `번역 중…`.

- [ ] **Step 4: Mismatch banners.** Derivation (plain consts, after `showSummaryTab`): `const translationLangMismatch = showTranscriptList && record !== null && (record.targetLang ?? 'ko') !== targetLang;` and `const summaryLangMismatch = summaryState.summary !== null && ((summaryState.summary.targetLang ?? 'ko') !== targetLang);`. Render a shared banner element (small, non-blocking, above `TranscriptList` inside the transcript tab and above `SummaryPanel` content — place at the top of the tab section content, one per tab):

```tsx
{translationLangMismatch && (
  <p className="mx-4 mt-3 rounded-[7px] bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
    이 번역은 {TARGET_LANG_LABELS[record?.targetLang ?? 'ko']}본입니다 · 현재 설정 {TARGET_LANG_LABELS[targetLang]} — 다시 생성으로 교체할 수 있어요
  </p>
)}
```

(The summary banner mirrors it with `summaryState.summary?.targetLang ?? 'ko'` and sits inside the summary tab branch. No action buttons — the existing 다시 생성 affordances are the path. Adjust placement so it does not break the sticky tab bar.)

- [ ] **Step 5: Gates (`tsc`, `vitest`, `build`) + commit** — `git commit -m "feat(panel): 번역 언어 select, neutral labels, language-mismatch banners"`

---

### Task 5: Options — 기본 번역 언어 section

**Files:**
- Modify: `entrypoints/options/App.tsx`

**Interfaces:**
- Consumes: Task 1 exports only.

- [ ] **Step 1:** Below the existing API-key section (inside the same `max-w-[660px]` content column), add a `번역 설정` section following the page's existing section/typography classes:

```tsx
          <section className="flex flex-col gap-3.5 border-t border-[#eeeeef] pt-6 dark:border-[#262626]">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-sm font-semibold tracking-tight text-[#17181a] dark:text-[#ededed]">
                번역 설정
              </h2>
              <p className="text-[12.5px] leading-relaxed text-[#6c6f74] dark:text-[#9a9a9a]">
                새 번역·요약이 이 언어로 생성됩니다. 사이드패널에서도 바꿀 수 있어요.
              </p>
            </div>
            <label className="flex items-center gap-3 text-[12.5px] text-[#3d4045] dark:text-[#c9c9c9]">
              기본 번역 언어
              <select
                value={targetLang ?? DEFAULT_TARGET_LANG}
                onChange={(e) => {
                  const lang = e.target.value as TargetLang;
                  setTargetLangState(lang);
                  void saveTargetLang(lang).catch(() => {});
                }}
                className="rounded-[7px] border border-[#e4e4e6] bg-white px-2.5 py-1.5 text-[12.5px] text-[#17181a] dark:border-[#292929] dark:bg-[#1e1e1e] dark:text-[#ededed]"
              >
                {TARGET_LANGS.map((lang) => (
                  <option key={lang} value={lang}>
                    {TARGET_LANG_LABELS[lang]}
                  </option>
                ))}
              </select>
            </label>
          </section>
```

With state at the top of the component: `const [targetLang, setTargetLangState] = useState<TargetLang | null>(null);` loaded via the same mount effect + `chrome.storage.onChanged` listener pattern as Task 4 Step 1 (null renders as default until loaded).

- [ ] **Step 2: Gates (`tsc`, `vitest`, `build`) + commit** — `git commit -m "feat(options): 기본 번역 언어 setting section"`

---

### Task 6 (controller-run): Real-Chrome CDP verification

Deploy, then: ① panel select ↔ Options select cross-sync (change one, read the other via storage + rendered value) ② with cached ko translation, switch to ja → both banners appear; 다시 생성 → new record `targetLang: 'ja'`, banner clears, transcript rows in Japanese; summary 다시 생성 → Japanese summary ③ a Japanese-source video: translate with target ko — rows render Korean ④ API-key savedAt invariant ⑤ reset setting to ko afterward.
