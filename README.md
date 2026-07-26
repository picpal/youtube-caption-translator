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
built extension into real Chrome via `pnpm dev`/`pnpm build`.