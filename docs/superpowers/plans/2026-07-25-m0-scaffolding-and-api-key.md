# M0: Scaffolding + API Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap a wxt + React + TS + Tailwind Chrome Extension (Manifest V3) with a functional API key management flow: Options page saves/tests a Gemini API key stored in `chrome.storage.local`, and the Side Panel shows an onboarding screen when the key is missing.

**Architecture:** Chrome MV3 extension using wxt. Three entry points: `background` service worker owns API key access and Gemini calls; `options/` provides the key management UI; `sidepanel/` renders onboarding when no key is present. Options and Side Panel never call `chrome.storage` for the key directly — they exchange typed `chrome.runtime` messages with the background so the key lives in a single trusted context. Pure library code (`src/lib/*`) is unit-tested with vitest; UI is verified manually by loading the unpacked extension in Chrome.

**Tech Stack:** wxt 0.19+, React 18, TypeScript 5, Tailwind CSS 3, vitest 1, Chrome Extension MV3 APIs (`storage.local`, `sidePanel`, `runtime.onMessage`), Gemini `generativelanguage.googleapis.com` REST API (model `gemini-2.5-flash`), pnpm.

## Global Constraints

- Node.js 20+ required (wxt 0.19 minimum).
- Chrome 114+ required (Side Panel API).
- Package manager: **pnpm** (do not use npm/yarn — lockfile format matters).
- Manifest V3 only.
- API key access is **background-only**. Options and Side Panel MUST use `chrome.runtime.sendMessage`; direct `chrome.storage.local.get('geminiApiKey')` from those contexts is forbidden.
- Content Script is NOT installed in this milestone (M1 adds it). Do not create `entrypoints/content.ts` yet.
- UI copy language: **Korean**. Code identifiers, comments, commit messages: **English**.
- Never commit real API keys. `.env*` files are gitignored.
- Commit style: Conventional Commits (`feat:`, `chore:`, `test:`, `docs:`).
- Repository: `https://github.com/picpal/youtube-play-assistant.git`, branch `main`.
- Design reference: https://claude.ai/design/p/c11e446f-bf55-4360-b182-3944d84aa21d — during Tasks 9–10 fetch the current markup from `Side Panel.dc.html` and any Options-related files, then translate the layout and Tailwind classes into the React components below. If the design changes, refetch and re-apply; the component API surface stays the same.
- Working directory for all commands: `/Users/picpal/Desktop/workspace/youtube-play-assistant`.

---

## File Structure

Files created or modified in this milestone:

| Path | Responsibility |
|---|---|
| `.gitignore` | Exclude `node_modules/`, `.wxt/`, `.output/`, `.env*`, `dist/` |
| `README.md` | Repo overview + local dev instructions |
| `package.json` | Deps + scripts (`dev`, `build`, `test`) |
| `pnpm-lock.yaml` | Auto-generated |
| `tsconfig.json` | Extends wxt-generated tsconfig, adds path aliases |
| `wxt.config.ts` | Manifest, entry points, react module, permissions |
| `tailwind.config.ts` | Tailwind content globs + dark mode class strategy |
| `postcss.config.js` | Tailwind + autoprefixer PostCSS pipeline |
| `vitest.config.ts` | jsdom env, path aliases |
| `src/styles/globals.css` | Tailwind base/components/utilities directives |
| `src/types/message.ts` | Typed message union for runtime channel |
| `src/lib/storage.ts` | Typed wrapper over `chrome.storage.local` |
| `src/lib/storage.test.ts` | Unit tests for storage wrapper |
| `src/lib/gemini.ts` | Gemini REST client, error normalization |
| `src/lib/gemini.test.ts` | Unit tests for Gemini client |
| `src/lib/messaging.ts` | Typed sendMessage helper for UI contexts |
| `src/features/api-key/useApiKey.ts` | React hook: read/save/delete/test key via messaging |
| `src/components/Button.tsx` | Shared button (primary / secondary / danger) |
| `src/components/Input.tsx` | Shared text/password input |
| `src/components/StatusBadge.tsx` | Colored dot + label for key/test states |
| `entrypoints/background.ts` | Message handlers for key CRUD + Gemini test |
| `entrypoints/options/index.html` | Options page shell |
| `entrypoints/options/main.tsx` | React root for options |
| `entrypoints/options/App.tsx` | Options page UI (key input, test, layout) |
| `entrypoints/sidepanel/index.html` | Side panel shell |
| `entrypoints/sidepanel/main.tsx` | React root for side panel |
| `entrypoints/sidepanel/App.tsx` | Onboarding + header with status indicator |

---

## Task 1: Repository bootstrap

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Create: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: initialized git repository with remote `origin` pointing at GitHub, `main` branch, first commit including this plan and the existing PRD/IMPLEMENTATION_PLAN.

- [ ] **Step 1: Initialize git repository**

Run:

```bash
cd /Users/picpal/Desktop/workspace/youtube-play-assistant
git init -b main
```

Expected: `Initialized empty Git repository in .../youtube-play-assistant/.git/`

- [ ] **Step 2: Create `.gitignore`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/.gitignore`:

```gitignore
# Dependencies
node_modules/

# wxt build artifacts
.wxt/
.output/
dist/
web-ext-artifacts/

# Environment
.env
.env.*
!.env.example

# Editor / OS
.DS_Store
.vscode/
.idea/
*.log

# Test output
coverage/
```

- [ ] **Step 3: Create `README.md`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/README.md`:

```markdown
# YouTube Play Assistant

Personal-use Chrome extension that translates English YouTube tech talks into
Korean subtitles, provides a synchronized transcript, search, bookmarks, and
Markdown export.

See [PRD.md](./PRD.md) and [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)
for scope and roadmap. Per-milestone plans live in
`docs/superpowers/plans/`.

## Local development

```bash
pnpm install
pnpm dev            # loads unpacked extension for Chrome
pnpm test           # runs vitest
pnpm build          # produces .output/chrome-mv3
```

After `pnpm dev` starts, open `chrome://extensions`, enable Developer Mode,
click "Load unpacked", and select `.output/chrome-mv3-dev`.
```

- [ ] **Step 4: Create minimal `package.json`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/package.json`:

```json
{
  "name": "youtube-play-assistant",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "Personal YouTube learning Chrome extension (Korean subtitles + transcript)",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 5: Add GitHub remote**

Run:

```bash
git remote add origin https://github.com/picpal/youtube-play-assistant.git
git remote -v
```

Expected: two lines showing `origin ... (fetch)` and `origin ... (push)`.

- [ ] **Step 6: Stage + commit**

Run:

```bash
git add .gitignore README.md package.json PRD.md IMPLEMENTATION_PLAN.md docs/
git commit -m "chore: initial repository bootstrap with PRD and plans"
```

Expected: commit created listing the 5+ files.

---

## Task 2: Install dependencies

**Files:**
- Modify: `package.json` (dependency lists)
- Create: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `package.json` from Task 1
- Produces: `node_modules/` with wxt, react, typescript, tailwind, vitest installed and pinned in `pnpm-lock.yaml`.

- [ ] **Step 1: Install wxt + React runtime**

Run:

```bash
pnpm add wxt@^0.19 react@^18 react-dom@^18
```

Expected: `dependencies` block appears in `package.json` with the three packages, no errors.

- [ ] **Step 2: Install React types + wxt React module**

Run:

```bash
pnpm add -D @wxt-dev/module-react @types/react@^18 @types/react-dom@^18 typescript@^5
```

Expected: `devDependencies` block gains the four packages.

- [ ] **Step 3: Install Tailwind + PostCSS**

Run:

```bash
pnpm add -D tailwindcss@^3 postcss@^8 autoprefixer@^10
```

Expected: three more entries in `devDependencies`.

- [ ] **Step 4: Install test tooling**

Run:

```bash
pnpm add -D vitest@^1 jsdom@^24 @vitest/coverage-v8@^1
```

Expected: three more entries in `devDependencies`.

- [ ] **Step 5: Verify pnpm install succeeded**

Run:

```bash
ls node_modules/wxt node_modules/react node_modules/tailwindcss node_modules/vitest
```

Expected: four directory listings without "No such file" errors.

- [ ] **Step 6: Commit dependency lockfile**

Run:

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: install wxt, react, tailwind, vitest"
```

Expected: commit succeeds.

---

## Task 3: wxt / TypeScript / Tailwind / vitest configuration

**Files:**
- Create: `wxt.config.ts`
- Create: `tsconfig.json`
- Create: `tailwind.config.ts`
- Create: `postcss.config.js`
- Create: `vitest.config.ts`
- Create: `src/styles/globals.css`

**Interfaces:**
- Consumes: dependencies from Task 2
- Produces: `pnpm dev` builds a loadable extension; `~/*` path alias resolves to `src/*`; Tailwind classes work in `.tsx` files; `pnpm test` runs vitest with jsdom.

- [ ] **Step 1: Create `wxt.config.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/wxt.config.ts`:

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  manifest: {
    name: 'YouTube Play Assistant',
    description: 'YouTube tech talks with Korean subtitles and transcript',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
    action: {
      default_title: 'YouTube Play Assistant',
    },
  },
});
```

- [ ] **Step 2: Create `tsconfig.json`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/tsconfig.json`:

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "~/*": ["src/*"]
    },
    "types": ["chrome", "vitest/globals"]
  },
  "include": [
    "entrypoints/**/*",
    "src/**/*",
    "wxt.config.ts",
    "vitest.config.ts",
    "tailwind.config.ts",
    ".wxt/wxt.d.ts"
  ]
}
```

- [ ] **Step 3: Create `tailwind.config.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss';

export default {
  darkMode: 'media',
  content: [
    './entrypoints/**/*.{html,tsx,ts}',
    './src/**/*.{tsx,ts}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 4: Create `postcss.config.js`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/postcss.config.js`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 5: Create `src/styles/globals.css`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/styles/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html,
body {
  @apply bg-neutral-50 text-neutral-900 antialiased;
}

@media (prefers-color-scheme: dark) {
  html,
  body {
    @apply bg-neutral-950 text-neutral-100;
  }
}
```

- [ ] **Step 6: Create `vitest.config.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
    },
  },
});
```

- [ ] **Step 7: Verify configuration compiles**

Run:

```bash
pnpm wxt prepare
```

Expected: creates `.wxt/tsconfig.json` and `.wxt/wxt.d.ts` without error. If it errors about missing entrypoints, ignore for now — Task 8+ will add them.

- [ ] **Step 8: Commit configuration**

Run:

```bash
git add wxt.config.ts tsconfig.json tailwind.config.ts postcss.config.js vitest.config.ts src/styles/globals.css
git commit -m "chore: configure wxt, typescript, tailwind, vitest"
```

Expected: commit created.

---

## Task 4: Message type definitions

**Files:**
- Create: `src/types/message.ts`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces:
  - `type AppMessage` — discriminated union of all runtime messages.
  - `type AppResponse<T extends AppMessage['type']>` — response payload keyed by message type.
  - Message types: `SAVE_API_KEY`, `GET_API_KEY_STATUS`, `DELETE_API_KEY`, `TEST_API_KEY`.

- [ ] **Step 1: Create `src/types/message.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/types/message.ts`:

```ts
export type ApiKeyStatus =
  | { present: false }
  | { present: true; maskedKey: string; savedAt: string };

export type GeminiTestResult =
  | { ok: true; latencyMs: number; model: string }
  | { ok: false; reason: 'unauthorized' | 'rate_limit' | 'network' | 'unknown'; message: string };

export type AppMessage =
  | { type: 'SAVE_API_KEY'; payload: { key: string } }
  | { type: 'GET_API_KEY_STATUS' }
  | { type: 'DELETE_API_KEY' }
  | { type: 'TEST_API_KEY' };

export type AppResponseMap = {
  SAVE_API_KEY: { ok: true; status: ApiKeyStatus } | { ok: false; error: string };
  GET_API_KEY_STATUS: ApiKeyStatus;
  DELETE_API_KEY: { ok: true };
  TEST_API_KEY: GeminiTestResult;
};

export type AppResponse<T extends AppMessage['type']> = AppResponseMap[T];
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
pnpm tsc --noEmit
```

Expected: exits 0 with no errors. If `.wxt/tsconfig.json` is missing, run `pnpm wxt prepare` first.

- [ ] **Step 3: Commit**

Run:

```bash
git add src/types/message.ts
git commit -m "feat: define runtime message types"
```

Expected: commit created.

---

## Task 5: Storage wrapper (TDD)

**Files:**
- Create: `src/lib/storage.ts`
- Create: `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `chrome.storage.local` global (mocked in tests)
- Produces:
  - `saveApiKey(key: string): Promise<{ maskedKey: string; savedAt: string }>` — validates non-empty, stores `{ geminiApiKey: string, geminiApiKeySavedAt: string }`, returns masked value.
  - `getApiKeyStatus(): Promise<ApiKeyStatus>` — reads keys, returns `{ present, maskedKey, savedAt }` union.
  - `deleteApiKey(): Promise<void>` — removes both keys.
  - `maskKey(key: string): string` — returns `"••••" + last4` (or `"••••"` if shorter than 4).

- [ ] **Step 1: Write failing tests**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/lib/storage.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveApiKey, getApiKeyStatus, deleteApiKey, maskKey } from './storage';

type LocalStore = Record<string, unknown>;
let store: LocalStore;

beforeEach(() => {
  store = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn((keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: LocalStore = {};
          for (const k of arr) if (k in store) out[k] = store[k];
          return Promise.resolve(out);
        }),
        set: vi.fn((items: LocalStore) => {
          Object.assign(store, items);
          return Promise.resolve();
        }),
        remove: vi.fn((keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete store[k];
          return Promise.resolve();
        }),
      },
    },
  };
});

describe('maskKey', () => {
  it('returns bullets plus last four characters', () => {
    expect(maskKey('AIzaSyABCDEFG12345')).toBe('••••2345');
  });

  it('returns bullets alone for short keys', () => {
    expect(maskKey('abc')).toBe('••••');
  });
});

describe('saveApiKey', () => {
  it('rejects empty keys', async () => {
    await expect(saveApiKey('')).rejects.toThrow(/empty/i);
    await expect(saveApiKey('   ')).rejects.toThrow(/empty/i);
  });

  it('stores trimmed key with savedAt timestamp', async () => {
    const before = Date.now();
    const result = await saveApiKey('  AIzaSyABCDEFG12345  ');
    expect(store.geminiApiKey).toBe('AIzaSyABCDEFG12345');
    expect(result.maskedKey).toBe('••••2345');
    expect(new Date(result.savedAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('getApiKeyStatus', () => {
  it('reports absent when nothing stored', async () => {
    const status = await getApiKeyStatus();
    expect(status).toEqual({ present: false });
  });

  it('reports present with masked key when stored', async () => {
    store.geminiApiKey = 'AIzaSyABCDEFG12345';
    store.geminiApiKeySavedAt = '2026-07-25T00:00:00.000Z';
    const status = await getApiKeyStatus();
    expect(status).toEqual({
      present: true,
      maskedKey: '••••2345',
      savedAt: '2026-07-25T00:00:00.000Z',
    });
  });
});

describe('deleteApiKey', () => {
  it('removes both key and timestamp', async () => {
    store.geminiApiKey = 'AIzaSyABCDEFG12345';
    store.geminiApiKeySavedAt = '2026-07-25T00:00:00.000Z';
    await deleteApiKey();
    expect(store.geminiApiKey).toBeUndefined();
    expect(store.geminiApiKeySavedAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test src/lib/storage.test.ts
```

Expected: FAIL with "Cannot find module './storage'".

- [ ] **Step 3: Implement `src/lib/storage.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/lib/storage.ts`:

```ts
import type { ApiKeyStatus } from '~/types/message';

const KEY = 'geminiApiKey';
const SAVED_AT = 'geminiApiKeySavedAt';

export function maskKey(key: string): string {
  if (key.length < 4) return '••••';
  return '••••' + key.slice(-4);
}

export async function saveApiKey(rawKey: string): Promise<{ maskedKey: string; savedAt: string }> {
  const key = rawKey.trim();
  if (key.length === 0) throw new Error('API key must not be empty');
  const savedAt = new Date().toISOString();
  await chrome.storage.local.set({ [KEY]: key, [SAVED_AT]: savedAt });
  return { maskedKey: maskKey(key), savedAt };
}

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  const record = await chrome.storage.local.get([KEY, SAVED_AT]);
  const key = record[KEY] as string | undefined;
  const savedAt = record[SAVED_AT] as string | undefined;
  if (!key || !savedAt) return { present: false };
  return { present: true, maskedKey: maskKey(key), savedAt };
}

export async function getApiKey(): Promise<string | null> {
  const record = await chrome.storage.local.get(KEY);
  return (record[KEY] as string | undefined) ?? null;
}

export async function deleteApiKey(): Promise<void> {
  await chrome.storage.local.remove([KEY, SAVED_AT]);
}
```

- [ ] **Step 4: Re-run tests to verify they pass**

Run:

```bash
pnpm test src/lib/storage.test.ts
```

Expected: PASS with 7 tests green.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: add chrome.storage wrapper for gemini api key"
```

Expected: commit created.

---

## Task 6: Gemini REST client (TDD)

**Files:**
- Create: `src/lib/gemini.ts`
- Create: `src/lib/gemini.test.ts`

**Interfaces:**
- Consumes: `fetch` global (mocked in tests)
- Produces:
  - `testGeminiKey(key: string, opts?: { fetchImpl?: typeof fetch }): Promise<GeminiTestResult>` — sends a minimal `generateContent` request to `gemini-2.5-flash`, returns normalized result.
  - `MODEL_ID = 'gemini-2.5-flash'` exported constant.
  - Error mapping: 401 → `unauthorized`, 429 → `rate_limit`, network throw → `network`, other → `unknown`.

- [ ] **Step 1: Write failing tests**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/lib/gemini.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { testGeminiKey, MODEL_ID } from './gemini';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('testGeminiKey', () => {
  it('returns ok:true and latency on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe(MODEL_ID);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain(MODEL_ID);
    expect(url).toContain('key=AIzaFAKE');
  });

  it('returns unauthorized on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'bad key' } }, { status: 401 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      message: 'bad key',
    });
  });

  it('returns unauthorized on 403 too', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'forbidden' } }, { status: 403 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('returns rate_limit on 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'quota' } }, { status: 429 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'rate_limit',
      message: 'quota',
    });
  });

  it('returns network on fetch throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message: 'offline',
    });
  });

  it('returns unknown on unexpected status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    );
    const result = await testGeminiKey('AIzaFAKE', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test src/lib/gemini.test.ts
```

Expected: FAIL with "Cannot find module './gemini'".

- [ ] **Step 3: Implement `src/lib/gemini.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/lib/gemini.ts`:

```ts
import type { GeminiTestResult } from '~/types/message';

export const MODEL_ID = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

interface TestOptions {
  fetchImpl?: typeof fetch;
}

interface GeminiErrorBody {
  error?: { message?: string };
}

export async function testGeminiKey(
  key: string,
  opts: TestOptions = {},
): Promise<GeminiTestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: 'ping' }] }],
    generationConfig: { maxOutputTokens: 8 },
  });

  const started = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'network', message };
  }
  const latencyMs = Math.round(performance.now() - started);

  if (response.ok) {
    return { ok: true, latencyMs, model: MODEL_ID };
  }

  const errorBody = await response.json().catch(() => ({} as GeminiErrorBody)) as GeminiErrorBody;
  const message = errorBody.error?.message ?? `HTTP ${response.status}`;

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized', message };
  }
  if (response.status === 429) {
    return { ok: false, reason: 'rate_limit', message };
  }
  return { ok: false, reason: 'unknown', message };
}
```

- [ ] **Step 4: Re-run tests to verify they pass**

Run:

```bash
pnpm test src/lib/gemini.test.ts
```

Expected: PASS with 6 tests green.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/gemini.ts src/lib/gemini.test.ts
git commit -m "feat: add gemini test-key client with error normalization"
```

Expected: commit created.

---

## Task 7: Background service worker

**Files:**
- Create: `entrypoints/background.ts`

**Interfaces:**
- Consumes: `saveApiKey`, `getApiKeyStatus`, `getApiKey`, `deleteApiKey` from `~/lib/storage`; `testGeminiKey` from `~/lib/gemini`; `AppMessage`, `AppResponse` types.
- Produces: registered `chrome.runtime.onMessage` listener that handles the four message types. Configures side panel to open on action click.

- [ ] **Step 1: Create `entrypoints/background.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/entrypoints/background.ts`:

```ts
import { defineBackground } from 'wxt/sandbox';
import { saveApiKey, getApiKey, getApiKeyStatus, deleteApiKey } from '~/lib/storage';
import { testGeminiKey } from '~/lib/gemini';
import type { AppMessage, AppResponseMap } from '~/types/message';

export default defineBackground(() => {
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((err) => console.warn('sidePanel.setPanelBehavior failed', err));

  chrome.runtime.onMessage.addListener(
    (msg: AppMessage, _sender, sendResponse) => {
      handle(msg)
        .then((res) => sendResponse(res))
        .catch((err) => {
          console.error('background handler error', err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    },
  );
});

async function handle(msg: AppMessage): Promise<AppResponseMap[AppMessage['type']]> {
  switch (msg.type) {
    case 'SAVE_API_KEY': {
      try {
        await saveApiKey(msg.payload.key);
        const status = await getApiKeyStatus();
        return { ok: true, status };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'GET_API_KEY_STATUS':
      return getApiKeyStatus();
    case 'DELETE_API_KEY':
      await deleteApiKey();
      return { ok: true };
    case 'TEST_API_KEY': {
      const key = await getApiKey();
      if (!key) {
        return { ok: false, reason: 'unauthorized', message: 'API key not set' };
      }
      return testGeminiKey(key);
    }
  }
}
```

- [ ] **Step 2: Verify build produces background bundle**

Run:

```bash
pnpm wxt build
```

Expected: succeeds, output includes `.output/chrome-mv3/background.js`. If it fails with missing entrypoints for options/sidepanel, ignore — those come in later tasks. If build blocks entirely on the missing entrypoints, temporarily comment them out of `wxt.config.ts`? No — wxt auto-detects, so as long as we don't create the directories yet the build will simply skip them. If the build fails for another reason, address the specific error before proceeding.

- [ ] **Step 3: Verify no TypeScript errors**

Run:

```bash
pnpm tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Commit**

Run:

```bash
git add entrypoints/background.ts
git commit -m "feat: background sw with api key crud and gemini test handlers"
```

Expected: commit created.

---

## Task 8: Messaging helper + useApiKey hook + shared UI components

**Files:**
- Create: `src/lib/messaging.ts`
- Create: `src/features/api-key/useApiKey.ts`
- Create: `src/components/Button.tsx`
- Create: `src/components/Input.tsx`
- Create: `src/components/StatusBadge.tsx`

**Interfaces:**
- Consumes: `chrome.runtime.sendMessage`, message types from Task 4.
- Produces:
  - `sendMessage<T extends AppMessage['type']>(msg: Extract<AppMessage, { type: T }>): Promise<AppResponse<T>>`
  - `useApiKey()` → `{ status, saveState, testState, save, remove, test, refresh }` where states are discriminated unions (`{ kind: 'idle' | 'saving' | 'success' | 'error', message?: string }` and `{ kind: 'idle' | 'testing' | 'ok' | 'unauthorized' | 'rate_limit' | 'network' | 'unknown', ... }`).
  - `<Button variant="primary"|"secondary"|"danger" size="sm"|"md">`
  - `<Input type="text"|"password" masked onToggleMasked>`
  - `<StatusBadge tone="ok"|"warn"|"error"|"muted">`

- [ ] **Step 1: Create `src/lib/messaging.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/lib/messaging.ts`:

```ts
import type { AppMessage, AppResponse } from '~/types/message';

export async function sendMessage<T extends AppMessage['type']>(
  msg: Extract<AppMessage, { type: T }>,
): Promise<AppResponse<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<AppResponse<T>>;
}
```

- [ ] **Step 2: Create `src/features/api-key/useApiKey.ts`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/features/api-key/useApiKey.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import type { ApiKeyStatus, GeminiTestResult } from '~/types/message';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; savedAt: string }
  | { kind: 'error'; message: string };

export type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; latencyMs: number; model: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'rate_limit'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'unknown'; message: string };

export function useApiKey() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    const next = await sendMessage({ type: 'GET_API_KEY_STATUS' });
    setStatus(next);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async (key: string) => {
    setSaveState({ kind: 'saving' });
    const res = await sendMessage({ type: 'SAVE_API_KEY', payload: { key } });
    if (res.ok) {
      setStatus(res.status);
      const savedAt = res.status.present ? res.status.savedAt : new Date().toISOString();
      setSaveState({ kind: 'success', savedAt });
      setTestState({ kind: 'idle' });
    } else {
      setSaveState({ kind: 'error', message: res.error });
    }
  }, []);

  const remove = useCallback(async () => {
    await sendMessage({ type: 'DELETE_API_KEY' });
    setStatus({ present: false });
    setSaveState({ kind: 'idle' });
    setTestState({ kind: 'idle' });
  }, []);

  const test = useCallback(async () => {
    setTestState({ kind: 'testing' });
    const res: GeminiTestResult = await sendMessage({ type: 'TEST_API_KEY' });
    if (res.ok) {
      setTestState({ kind: 'ok', latencyMs: res.latencyMs, model: res.model });
    } else {
      setTestState({ kind: res.reason, message: res.message });
    }
  }, []);

  return { status, saveState, testState, save, remove, test, refresh };
}
```

- [ ] **Step 3: Create `src/components/Button.tsx`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/components/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';
type Size = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  'inline-flex items-center justify-center rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-neutral-50 dark:focus:ring-offset-neutral-950';

const variants: Record<Variant, string> = {
  primary:
    'bg-neutral-900 text-white hover:bg-neutral-800 focus:ring-neutral-500 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200',
  secondary:
    'bg-neutral-200 text-neutral-900 hover:bg-neutral-300 focus:ring-neutral-400 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700',
  danger:
    'bg-red-600 text-white hover:bg-red-500 focus:ring-red-500',
};

const sizes: Record<Size, string> = {
  sm: 'text-sm px-3 py-1.5',
  md: 'text-sm px-4 py-2',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}
```

- [ ] **Step 4: Create `src/components/Input.tsx`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/components/Input.tsx`:

```tsx
import { forwardRef, useState, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helper?: string;
  revealable?: boolean;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, helper, revealable, type = 'text', className = '', id, ...rest },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  const effectiveType = revealable && revealed ? 'text' : type;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={id}
          className="text-xs font-medium text-neutral-600 dark:text-neutral-400"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={id}
          type={effectiveType}
          className={`w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-600 ${revealable ? 'pr-16' : ''} ${className}`}
          {...rest}
        />
        {revealable && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {revealed ? '숨김' : '표시'}
          </button>
        )}
      </div>
      {helper && (
        <p className="text-xs text-neutral-500 dark:text-neutral-500">{helper}</p>
      )}
    </div>
  );
});
```

- [ ] **Step 5: Create `src/components/StatusBadge.tsx`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/src/components/StatusBadge.tsx`:

```tsx
import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'error' | 'muted';

interface Props {
  tone: Tone;
  children: ReactNode;
}

const dot: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  muted: 'bg-neutral-400',
};

const text: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-700 dark:text-red-400',
  muted: 'text-neutral-600 dark:text-neutral-400',
};

export function StatusBadge({ tone, children }: Props) {
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${text[tone]}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot[tone]}`} />
      {children}
    </span>
  );
}
```

- [ ] **Step 6: Verify no TypeScript errors**

Run:

```bash
pnpm tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/lib/messaging.ts src/features/api-key/useApiKey.ts src/components/
git commit -m "feat: add messaging helper, useApiKey hook, shared UI components"
```

Expected: commit created.

---

## Task 9: Options page

**Files:**
- Create: `entrypoints/options/index.html`
- Create: `entrypoints/options/main.tsx`
- Create: `entrypoints/options/App.tsx`

**Interfaces:**
- Consumes: `useApiKey` hook, `Button`, `Input`, `StatusBadge`, `~/styles/globals.css`
- Produces: registered `options_page` in the built manifest. UI covers:
  - Header: "설정"
  - Section "Gemini API 키" — Input (revealable), Save + Delete buttons, save-state feedback, masked+savedAt display when present
  - Section "연결 테스트" — Test button, test-state feedback
  - Section "무료 티어 안내" — link to Google AI Studio and pricing note

- [ ] **Step 1: Create `entrypoints/options/index.html`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/entrypoints/options/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>YouTube Play Assistant — 설정</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `entrypoints/options/main.tsx`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/entrypoints/options/main.tsx`:

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

- [ ] **Step 3: Create `entrypoints/options/App.tsx`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/entrypoints/options/App.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '~/components/Button';
import { Input } from '~/components/Input';
import { StatusBadge } from '~/components/StatusBadge';
import { useApiKey } from '~/features/api-key/useApiKey';

export function App() {
  const { status, saveState, testState, save, remove, test } = useApiKey();
  const [draft, setDraft] = useState('');

  const isPresent = status?.present === true;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">설정</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          YouTube Play Assistant를 사용하려면 Gemini API 키를 등록해주세요.
        </p>
      </header>

      <section className="mb-10 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium">Gemini API 키</h2>
          {isPresent && status && (
            <StatusBadge tone="ok">
              {status.maskedKey} 저장됨 · {new Date(status.savedAt).toLocaleDateString('ko-KR')}
            </StatusBadge>
          )}
        </div>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          Google AI Studio에서 무료로 발급받을 수 있습니다.{' '}
          <a
            className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
          >
            API 키 발급받기 →
          </a>
        </p>
        <div className="flex flex-col gap-4">
          <Input
            id="gemini-key"
            label="API 키"
            type="password"
            revealable
            placeholder={isPresent ? '새 키로 교체하려면 여기에 입력' : 'AIza…'}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              onClick={() => save(draft).then(() => setDraft(''))}
              disabled={saveState.kind === 'saving' || draft.trim().length === 0}
            >
              {saveState.kind === 'saving' ? '저장 중…' : '저장'}
            </Button>
            {isPresent && (
              <Button variant="danger" onClick={remove}>
                삭제
              </Button>
            )}
            {saveState.kind === 'success' && (
              <StatusBadge tone="ok">저장되었습니다. 연결 테스트를 권장합니다.</StatusBadge>
            )}
            {saveState.kind === 'error' && (
              <StatusBadge tone="error">저장 실패: {saveState.message}</StatusBadge>
            )}
          </div>
        </div>
      </section>

      <section className="mb-10 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-3 text-lg font-medium">연결 테스트</h2>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          저장된 키로 Gemini API에 짧은 요청을 보내 응답을 확인합니다.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={test}
            disabled={!isPresent || testState.kind === 'testing'}
          >
            {testState.kind === 'testing' ? '테스트 중…' : '테스트 요청 보내기'}
          </Button>
          <TestStateBadge state={testState} />
        </div>
      </section>

      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-2 text-lg font-medium">무료 티어 안내</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Gemini 2.5 Flash 무료 티어는 분당·일별 요청 수 제한이 있습니다. 자세한 한도는{' '}
          <a
            className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
            href="https://ai.google.dev/pricing"
            target="_blank"
            rel="noreferrer"
          >
            공식 요금 페이지
          </a>
          에서 확인하세요.
        </p>
      </section>
    </main>
  );
}

function TestStateBadge({ state }: { state: ReturnType<typeof useApiKey>['testState'] }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'testing':
      return <StatusBadge tone="muted">요청 중…</StatusBadge>;
    case 'ok':
      return (
        <StatusBadge tone="ok">
          ✓ 정상 응답 · {state.latencyMs}ms · {state.model}
        </StatusBadge>
      );
    case 'unauthorized':
      return <StatusBadge tone="error">✗ 401 · API 키를 확인해주세요 ({state.message})</StatusBadge>;
    case 'rate_limit':
      return <StatusBadge tone="warn">⚠ 429 · 잠시 후 다시 시도해주세요 ({state.message})</StatusBadge>;
    case 'network':
      return <StatusBadge tone="error">네트워크 오류: {state.message}</StatusBadge>;
    case 'unknown':
      return <StatusBadge tone="error">알 수 없는 오류: {state.message}</StatusBadge>;
  }
}
```

- [ ] **Step 4: Verify build includes options page**

Run:

```bash
pnpm wxt build
```

Expected: succeeds; `.output/chrome-mv3/options.html` exists.

Verify:

```bash
ls .output/chrome-mv3/options.html
```

Expected: file listed with no error.

- [ ] **Step 5: Manual verification in Chrome**

1. Run `pnpm dev` (leave running).
2. Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", select `.output/chrome-mv3-dev`.
3. Right-click the extension icon → "Options" (or click "세부정보 → 확장 프로그램 옵션").
4. Verify:
   - Header "설정" renders.
   - Empty state: no masked key badge in the section header.
   - Input accepts text, "표시"/"숨김" toggle switches masking.
   - "저장" is disabled while input is empty; enabled after typing.
   - After entering a bogus key (e.g. `AIzaTESTKEY`) and clicking 저장, "저장되었습니다" badge appears and the section header shows the masked value + today's date.
   - "삭제" removes the badge and returns to empty state.
   - Re-save the bogus key, then click "테스트 요청 보내기" → expect the `✗ 401` or `⚠ 429` badge (bogus key will 401).

- [ ] **Step 6: Commit**

Run:

```bash
git add entrypoints/options/
git commit -m "feat: options page with api key CRUD and connection test"
```

Expected: commit created.

---

## Task 10: Side panel — onboarding + header

**Files:**
- Create: `entrypoints/sidepanel/index.html`
- Create: `entrypoints/sidepanel/main.tsx`
- Create: `entrypoints/sidepanel/App.tsx`

**Interfaces:**
- Consumes: `useApiKey` (for status), `Button`, `StatusBadge`, `~/styles/globals.css`
- Produces: side panel registered via `entrypoints/sidepanel/` (wxt auto-injects `side_panel.default_path`). UI:
  - Header (persistent): title "YouTube Play Assistant" + status indicator (ok / warn) + settings gear button that calls `chrome.runtime.openOptionsPage()`.
  - Body when key absent: onboarding screen (icon placeholder, headline, description, "설정 열기" primary button, "API 키 발급받기" link, footer note).
  - Body when key present: placeholder message "M1에서 영상 인식 기능이 추가됩니다."

- [ ] **Step 1: Create `entrypoints/sidepanel/index.html`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/entrypoints/sidepanel/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>YouTube Play Assistant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `entrypoints/sidepanel/main.tsx`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/entrypoints/sidepanel/main.tsx`:

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

- [ ] **Step 3: Create `entrypoints/sidepanel/App.tsx`**

Create `/Users/picpal/Desktop/workspace/youtube-play-assistant/entrypoints/sidepanel/App.tsx`:

```tsx
import { Button } from '~/components/Button';
import { StatusBadge } from '~/components/StatusBadge';
import { useApiKey } from '~/features/api-key/useApiKey';

export function App() {
  const { status } = useApiKey();
  const loading = status === null;
  const present = status?.present === true;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">YouTube Play Assistant</h1>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge tone={loading ? 'muted' : present ? 'ok' : 'warn'}>
            {loading ? '확인 중' : present ? '준비됨' : '설정 필요'}
          </StatusBadge>
          <button
            type="button"
            onClick={() => chrome.runtime.openOptionsPage()}
            aria-label="설정 열기"
            className="rounded p-1 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {loading ? <LoadingBody /> : present ? <ReadyBody /> : <OnboardingBody />}
      </div>
    </div>
  );
}

function LoadingBody() {
  return (
    <p className="text-sm text-neutral-500 dark:text-neutral-400">불러오는 중…</p>
  );
}

function ReadyBody() {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
      M1에서 영상 인식과 자막 생성 기능이 추가됩니다.
    </div>
  );
}

function OnboardingBody() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
        <KeyIcon />
      </div>
      <div>
        <h2 className="text-base font-semibold">API 키를 등록해주세요</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          번역과 요약을 위해 Gemini API 키가 필요합니다. 개인 학습용이라면 Google AI Studio에서 무료로 발급할 수 있습니다.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Button onClick={() => chrome.runtime.openOptionsPage()}>설정 열기</Button>
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          API 키 발급받기 →
        </a>
      </div>
      <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">
        키는 이 브라우저에만 저장되며 외부로 전송되지 않습니다.
      </p>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.05a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.05a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.05a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
```

- [ ] **Step 4: Verify build produces side panel**

Run:

```bash
pnpm wxt build
```

Expected: succeeds; `.output/chrome-mv3/sidepanel.html` exists and `manifest.json` in that directory contains a `side_panel.default_path` entry pointing to it.

Verify:

```bash
grep -A1 side_panel .output/chrome-mv3/manifest.json
```

Expected: at least one line mentioning `default_path` and `sidepanel.html`.

- [ ] **Step 5: Manual verification in Chrome**

With `pnpm dev` running and the extension loaded (from Task 9 Step 5):

1. Click the extension's toolbar icon → side panel opens on the right.
2. If a key is currently saved (from Task 9), remove it via Options.
3. Confirm side panel body shows the onboarding screen: key icon, "API 키를 등록해주세요" headline, "설정 열기" button, "API 키 발급받기 →" link, footer note.
4. Header shows warn-tone badge "설정 필요" and a gear icon.
5. Click "설정 열기" → Options page opens in a new tab.
6. Save a key in Options; return to the side panel and refresh (close/reopen the panel) → header now shows ok-tone "준비됨" and body says "M1에서 영상 인식과 자막 생성 기능이 추가됩니다."
7. Click the gear icon in the header → Options page opens.

- [ ] **Step 6: Commit**

Run:

```bash
git add entrypoints/sidepanel/
git commit -m "feat: side panel with onboarding and status header"
```

Expected: commit created.

---

## Task 11: Full regression, tests, push

**Files:**
- No new files; verifies the full milestone and pushes to GitHub.

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: `main` branch pushed to `origin` with a `v0.1.0-m0` tag.

- [ ] **Step 1: Run full test suite**

Run:

```bash
pnpm test
```

Expected: all tests from `storage.test.ts` and `gemini.test.ts` pass (13 tests total).

- [ ] **Step 2: Type-check entire project**

Run:

```bash
pnpm tsc --noEmit
```

Expected: exits 0 with no errors.

- [ ] **Step 3: Production build**

Run:

```bash
pnpm build
```

Expected: succeeds; `.output/chrome-mv3/` contains `manifest.json`, `background.js`, `options.html`, `sidepanel.html`, and static assets.

- [ ] **Step 4: Load production build in Chrome and re-verify**

1. In `chrome://extensions` remove the dev-loaded extension.
2. Click "Load unpacked" → select `.output/chrome-mv3`.
3. Repeat the manual verification from Task 9 Step 5 and Task 10 Step 5. Expected: identical behavior.

- [ ] **Step 5: Push to GitHub**

Run:

```bash
git log --oneline
```

Expected: at least 8 commits from Tasks 1–10.

Then:

```bash
git push -u origin main
```

Expected: push succeeds. If it rejects because the remote is not empty, resolve with `git pull --rebase origin main` first, re-verify, then push.

- [ ] **Step 6: Tag milestone**

Run:

```bash
git tag -a v0.1.0-m0 -m "M0: scaffolding and API key management"
git push origin v0.1.0-m0
```

Expected: tag appears in `git tag` output and on GitHub.

- [ ] **Step 7: Capture screenshots (documentation)**

1. Take a screenshot of the Options page (empty state and saved state).
2. Take a screenshot of the side panel (onboarding and ready state).
3. Save them to `docs/screenshots/m0/` and commit:

```bash
mkdir -p docs/screenshots/m0
# (place PNG files in that directory)
git add docs/screenshots/m0
git commit -m "docs: add M0 screenshots"
git push
```

Expected: screenshots committed. If you prefer to skip screenshots for now, mark this step complete and move on.

---

## Self-Review Notes

**Spec coverage checked against PRD §7.12:**
- ✅ Options page with password input + reveal toggle → Task 9
- ✅ Save/delete/masked display → Task 9
- ✅ Save-state 4-way (idle/saving/success/error) → useApiKey (Task 8) + App.tsx (Task 9)
- ✅ Connection test with 3-way result (ok/401/429) plus network/unknown → Tasks 6, 8, 9
- ✅ Side Panel onboarding with CTA → Task 10
- ✅ Side Panel header with status indicator → Task 10
- ✅ chrome.storage.local only, background-only access → Tasks 5, 7 (UI goes through messaging)
- ✅ Google AI Studio link → Tasks 9, 10
- ✅ Local-only storage disclosure → Task 10

**Placeholder scan:** no TBD/TODO left in code; every step has runnable commands or full source.

**Type consistency:** `AppMessage` union, `AppResponse<T>`, `ApiKeyStatus`, `GeminiTestResult`, `SaveState`, `TestState` names used consistently across Tasks 4–10. `saveApiKey` return shape matches what `useApiKey.save` reads.

**Gaps intentionally left to later milestones:**
- Content Script for YouTube page injection → M1
- Video recognition, transcript extraction, translation pipeline → M1/M2
- Google Cloud Console "Chrome extension ID restriction" for the key — cannot enforce in code; documented in PRD §7.12 as a manual step to perform after loading the built extension (extension ID is only known once loaded).
