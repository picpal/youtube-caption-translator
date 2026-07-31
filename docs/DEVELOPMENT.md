# Development

Developer-facing notes for YouTube Caption Translator. For what the
extension does and how to install it, see [README.md](../README.md).

Scope and roadmap live in [PRD.md](../PRD.md) and
[IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md); per-milestone plans are
in `docs/superpowers/plans/`.

## Local development

```bash
pnpm install
pnpm dev            # loads unpacked extension for Chrome
pnpm test           # runs vitest
pnpm build          # produces .output/chrome-mv3
```

After `pnpm dev` starts, open `chrome://extensions`, enable Developer Mode,
click "Load unpacked", and select `.output/chrome-mv3-dev`.

## UI preview (no browser extension load required)

```bash
pnpm preview     # starts a Vite dev server at http://localhost:5199
```

Open `http://localhost:5199/` for a launcher linking to `popup.html`,
`options.html`, and `sidepanel.html`. Each page serves the real
`entrypoints/*/App.tsx` unmodified, with a mock `chrome.*` object
(`preview/mock-chrome.ts`) injected in front of it so the pages don't crash
outside an extension context. A "DEV PREVIEW" panel (bottom-right corner of
every surface) lets you flip: API key present/absent, current fake tab
(YouTube watch / YouTube home / non-YouTube), the next `TEST_API_KEY` result
(ok / unauthorized / rate_limit / network / unknown), and light/dark theme —
all without touching production code under `entrypoints/` or `src/`. See
`preview/` for the harness source.

**What this does NOT verify:** manifest wiring (permissions, `action`,
`side_panel` entries), real `chrome.runtime` message passing to an actual
background service worker, or real Gemini API calls (`TEST_API_KEY` always
returns a canned result chosen by the dev panel). Those require loading the
built extension into real Chrome via `pnpm dev:chrome` (below) or a manual
"Load unpacked" via `pnpm dev`.

## Real Chrome (`pnpm dev:chrome`) — manifest wiring, real messaging, real storage

```bash
pnpm dev:chrome              # build if stale, launch Chrome, load the extension, print IDs/URLs
pnpm dev:chrome:check        # verify a running instance end-to-end (SW wake + key status)
pnpm dev:chrome:check:panel  # verify the REAL docked side panel (after you open it manually)
pnpm dev:chrome:stop         # stop the dev Chrome instance
```

This loads the actual built extension (`.output/chrome-mv3`) into a real,
isolated Chrome instance over the Chrome DevTools Protocol — specifically
`Extensions.loadUnpacked`, since **`--load-extension` no longer works on
Chrome 150 stable** (it silently does nothing; the
`--disable-features=DisableLoadExtensionCommandLineSwitch` workaround does
not help either). Chrome is launched with `--remote-debugging-port=9222
--enable-unsafe-extension-debugging` and a dedicated, gitignored
`.chrome-dev-profile/` — never your real Chrome profile. The tooling is
plain `.mjs` run by Node (24+, for its built-in global `WebSocket`/`fetch`);
zero new dependencies.

- **Build policy:** rebuilds via `wxt build` only if
  `.output/chrome-mv3/manifest.json` is missing or older than the newest
  file under `entrypoints/`, `src/`, or the relevant config files. Otherwise
  it reuses the existing build.
- **Persistent profile:** `.chrome-dev-profile/` survives across runs, so a
  saved API key (and anything else in `chrome.storage.local`) is still there
  next time. It's gitignored — never commit it.
- **Idempotent:** if something is already listening on the debug port,
  `pnpm dev:chrome` reuses it (and loads the extension into it if not
  already loaded) instead of spawning a second, conflicting Chrome.
- **Landing page:** the first tab opens a real ~1hr English tech talk —
  [Andrej Karpathy, "\[1hr Talk\] Intro to Large Language Models"](https://www.youtube.com/watch?v=zjkBMFhNj_g)
  — the product's actual target content, not a blank page. Override it with
  `DEV_CHROME_YOUTUBE_URL=<url> pnpm dev:chrome` or `pnpm dev:chrome -- <url>`.
  A second tab opens `options.html` automatically; besides being visible,
  opening any extension page also wakes the background service worker.
- **API key seeding from `.env.local`:** copy `.env.local.example` to
  `.env.local` and set `GEMINI_API_KEY=<your key>` (get one free at
  <https://aistudio.google.com/apikey>). `pnpm dev:chrome` reads it and, only
  if the dev profile's storage has **no** key yet, sends it through the
  extension's real `SAVE_API_KEY` message (the genuine write path, not a
  direct `chrome.storage.local` write). If a key is already saved, it is
  always left byte-identical — nothing is ever overwritten. If `.env.local`
  is missing or empty and no key is stored, `dev:chrome` says so and moves
  on (not an error); you can still enter a key by hand in the Options page.
  The key value itself is never printed, logged, or passed as a process
  argument — only the extension's own masked form
  (`GET_API_KEY_STATUS`/`SAVE_API_KEY`'s `maskedKey`) ever appears in
  output. Tradeoff: `.env.local` holds the key in **plaintext on disk**,
  protected only by `.gitignore` — if you'd rather not have that file at
  all, skip it and use the Options page instead. This only ever seeds the
  gitignored dev profile (`.chrome-dev-profile/`, or `CHROME_PROFILE_DIR` if
  overridden) — it cannot reach and does not touch your real Chrome
  profile.
- **Toolbar pin:** on a fresh (non-reused) launch, the tooling seeds
  `extensions.pinned_extensions` in `.chrome-dev-profile/Default/Preferences`
  *before* Chrome starts, so the action button starts pinned instead of
  hiding behind the generic puzzle-piece "Extensions" menu. This has to
  happen pre-launch — Chrome overwrites `Preferences` with its in-memory
  state on exit, so patching the file while Chrome is running doesn't stick.
  If seeding fails for any reason, or the instance was reused instead of
  freshly launched, `pnpm dev:chrome`'s banner prints a one-time manual
  pin instruction (in Korean) instead of silently doing nothing.
- **`pnpm dev:chrome:check`** first wakes the background service worker if
  it has been evicted (MV3 evicts idle service workers after ~30s — it does
  **not** assume one is already running) by deriving the extension id from
  the build path and opening an `options.html` target, then polling for the
  worker to reappear. It then checks `GET_API_KEY_STATUS` through
  `chrome.runtime.sendMessage` — exercising the real messaging path,
  `chrome.storage.local`, and `handle()` in `entrypoints/background.ts`.
  **If a real key is already saved, the check stops there** and reports the
  `SAVE_API_KEY`/`DELETE_API_KEY` round trip as skipped (printed in Korean)
  — it will never overwrite or delete a real saved key. Only when no key is
  present yet does it run the full `SAVE_API_KEY` (fake key,
  `AIzaFAKE_DEVCHECK_0000`) → `GET_API_KEY_STATUS` → `DELETE_API_KEY` round
  trip and clean up after itself. It then screenshots `options.html` and
  `sidepanel.html` to gitignored `.chrome-dev-output/`.
- **`pnpm dev:chrome:check:panel`** verifies the *actual docked* side panel
  (see limitation below) once you've opened it manually: it looks for a
  `sidepanel.html` target, asserts it rendered the READY branch (shows
  "자막 표시", shows a disabled "AI 자막 생성" button, does **not** show the
  non-YouTube message) — proving the panel is live against a real YouTube
  watch tab — and screenshots it. If no panel target exists yet, it exits
  with a Korean instruction to click the pinned toolbar icon first.
- **`TEST_API_KEY` is deliberately never called** by `dev:chrome:check` — it
  hits the real Gemini endpoint and would either fail or burn real quota.
  Verify that path manually, once, with a real key.
- **Known limitation — docked side panel:** `chrome.sidePanel.open()`
  requires a genuine user gesture from within the extension UI's own event
  handler. Testing confirmed that even a CDP-dispatched, browser-trusted
  mouse click on a tab does not satisfy this — calling `sidePanel.open()`
  from the background service worker afterward still throws
  `` `sidePanel.open()` may only be called in response to a user gesture ``.
  Navigating a tab to `chrome-extension://<id>/sidepanel.html` renders the
  same React app (useful for screenshots/messaging checks), but it is a
  normal tab, not the actual docked, `chrome.sidePanel`-hosted panel. There
  is currently no way to *open* the docked panel via CDP automation; it must
  be opened manually by clicking the extension's toolbar icon. Once it's
  open, `pnpm dev:chrome:check:panel` *can* verify it via CDP — see above,
  and see `.superpowers/sdd/dev-chrome-tooling-report.md` for what its
  `Target.getTargets()` `type` field actually reported on Chrome 150.
- **Extension ID is stable** across runs for the same absolute build path,
  and is fully deterministic: it's `sha256(absoluteBuildPath)`, first 32 hex
  characters, each hex nibble mapped to a letter `a`-`p`. The tooling
  computes this itself (`scripts/lib/extension-id.mjs`) instead of relying
  on a live target, which is what makes waking-before-asserting and
  pre-launch pin seeding possible. A fresh profile also loads Chrome's own
  built-in component extensions, each with their own `service_worker`
  target, so the tooling identifies *our* service worker by matching the
  script filename declared in `manifest.json`'s `background.service_worker`
  (normally `background.js`), not just "any extension service worker".
- Stop with `pnpm dev:chrome:stop` (matches processes by the isolated
  `--user-data-dir`; never touches your real Chrome) or `Ctrl+C`-adjacent:
  since Chrome runs detached, closing the terminal does not stop it —
  always use the stop command.
- Override the Chrome binary with `CHROME_PATH=...`, the debug port with
  `CHROME_DEBUG_PORT=...`, or the profile directory with
  `CHROME_PROFILE_DIR=...` if the defaults don't fit your machine (the
  profile override is also how this tooling was verified against a fully
  separate throwaway profile without ever touching the real one).

## Architecture at a glance

| Piece | File | Role |
| --- | --- | --- |
| Content script | `entrypoints/content.ts` | Runs on `youtube.com/*`. Reads video metadata, opens YouTube's own transcript panel and scrapes its rows, and streams playback ticks to the panel over a long-lived Port. |
| Background SW | `entrypoints/background.ts` | Owns the API key, the translation pipeline, summary generation, and all IndexedDB writes. |
| Pipeline | `src/features/translation/pipeline.ts` | Merges raw rows into segments, runs one glossary pass, then translates in sequential chunks of `MAX_SEGMENTS_PER_REQUEST` (50) — a size chosen to stay inside an MV3 service worker's lifetime. |
| Gemini client | `src/lib/gemini.ts` | `gemini-3.5-flash-lite`, JSON response schema, 120s per-request timeout (`GEMINI_FETCH_TIMEOUT_MS`). |
| Storage | `src/lib/db.ts` | IndexedDB `youtube-caption-translator`, v3, stores `videos` / `translations` / `summaries`. |
| Surfaces | `entrypoints/sidepanel`, `entrypoints/options`, `entrypoints/export` | Side panel, settings page, and the print-to-PDF page. There is deliberately no action popup — the toolbar icon opens the panel directly. |
