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

### UI preview (no browser extension load required)

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

### Real Chrome (`pnpm dev:chrome`) — manifest wiring, real messaging, real storage

```bash
pnpm dev:chrome         # build if stale, launch Chrome, load the extension, print IDs/URLs
pnpm dev:chrome:check   # verify a running instance end-to-end
pnpm dev:chrome:stop    # stop the dev Chrome instance
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
- **`pnpm dev:chrome:check`** asserts the background service worker target
  exists, then drives `SAVE_API_KEY` → `GET_API_KEY_STATUS` →
  `DELETE_API_KEY` through `chrome.runtime.sendMessage` on a real
  `options.html` page target — exercising the actual messaging path,
  `chrome.storage.local`, and `handle()` in `entrypoints/background.ts`. It
  uses an obviously-fake key (`AIzaFAKE_DEVCHECK_0000`) and always attempts
  the delete cleanup, even if an earlier assertion failed. It then
  screenshots `options.html` and `sidepanel.html` to gitignored
  `.chrome-dev-output/`.
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
  is currently no way to verify the docked panel via CDP automation; it
  must be checked manually by clicking the extension's toolbar icon.
- **Extension ID is stable** across runs for the same absolute build path
  (verified by repeated runs) — but a fresh profile also loads Chrome's own
  built-in component extensions, each with their own `service_worker`
  target, so the tooling identifies *our* service worker by matching the
  script filename declared in `manifest.json`'s `background.service_worker`
  (normally `background.js`), not just "any extension service worker".
- Stop with `pnpm dev:chrome:stop` (matches processes by the isolated
  `--user-data-dir`; never touches your real Chrome) or `Ctrl+C`-adjacent:
  since Chrome runs detached, closing the terminal does not stop it —
  always use the stop command.
- Override the Chrome binary with `CHROME_PATH=...` or the debug port with
  `CHROME_DEBUG_PORT=...` if the defaults don't fit your machine.