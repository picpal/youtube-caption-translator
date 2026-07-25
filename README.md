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