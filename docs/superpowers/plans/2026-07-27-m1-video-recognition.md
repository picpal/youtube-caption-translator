# M1: Video Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user is on a YouTube watch page, the side panel shows that video's real title, channel, duration, and thumbnail, reports whether English captions exist, follows SPA navigation between videos, and clearly refuses unsupported pages (Shorts, live, restricted).

**Architecture:** A new ISOLATED-world content script on `youtube.com` extracts video metadata and pushes it to the background service worker, which caches it in IndexedDB and relays it to the side panel. The panel replaces its M0 placeholders with real data. Caption availability is detected by whichever mechanism Task 1's discovery proves reliable. Nothing in M1 extracts or translates transcripts — `AI 자막 생성` stays disabled until M2.

**Tech Stack:** wxt 0.19, React 18, TypeScript 5, Tailwind 3, vitest 1, `idb` (only if Task 3 concludes it is needed), Chrome MV3 (`storage`, `sidePanel`, content scripts), Node 24, pnpm.

## Global Constraints

- Package manager: **pnpm** only.
- Node 20+, Chrome 114+ (dev machine runs Chrome 150).
- Manifest V3. Do **not** add `action.default_popup` — the popup was deliberately removed; the toolbar icon opens the side panel.
- Do **not** add the `tabs` permission. `tab.url` being unreadable off-YouTube is correct-by-construction given `host_permissions` covers only `youtube.com`.
- Surfaces: **side panel** (everything) and **Options** (settings). There is no popup.
- API key access stays **background-only**. Panel and content script reach it only via `chrome.runtime` messages.
- UI copy: **Korean**. Code identifiers, comments, commit messages: **English**.
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- Never commit: `.env.local`, `.chrome-dev-profile/`, `.chrome-dev-output/`, API keys.
- **The dev profile holds the user's real API key.** It must remain `{"present":true,"maskedKey":"••••IaDg","savedAt":"2026-07-26T16:19:11.169Z"}` throughout. Never send `SAVE_API_KEY` or `DELETE_API_KEY` against the dev profile, and never read or modify repo-root `.env.local`.
- Pure logic in `src/lib/` is **TDD**: failing test → confirm RED → implement → confirm GREEN.
- Standard fixture video: `https://www.youtube.com/watch?v=zjkBMFhNj_g` — Andrej Karpathy, "[1hr Talk] Intro to Large Language Models" (verified via oEmbed).
- Every task that changes runtime behavior must be verified in **real Chrome** via `pnpm dev:chrome`, not only in `pnpm preview`.
- Gates after every task: `pnpm tsc --noEmit` exit 0 · `pnpm test` all green · `pnpm wxt build` succeeds.

## Known operational friction

Reloading the extension (CDP `Extensions.loadUnpacked`) **closes every open extension page**, including the docked side panel. The docked panel can only be reopened by a genuine human click on the toolbar icon — `chrome.sidePanel.open()` rejects CDP-synthesized gestures. Consequences for every task:

- Batch your rebuild-and-reload cycles; do not reload casually.
- When you need the docked panel reopened, **stop and report NEEDS_CONTEXT** asking the controller to arrange a click. Do not simulate OS-level input.
- Where a check can be made deterministic by reloading the *panel page* (not the extension), prefer that — `dev-chrome-check-panel.mjs` already does this.

## Decisions already made (do not relitigate)

| Question | Decision | Rationale |
|---|---|---|
| i18n | **Skip.** Inline Korean strings. | Personal single-locale tool. `chrome.i18n` + `_locales/` adds `getMessage()` indirection at every call site for zero benefit. Revisit only if a second locale is ever wanted. |
| Popup | Removed, permanently. | See `docs/design/extension-popup.dc.html` — that file is now the **panel's** design reference. |
| Tab reactivity | Already implemented in `entrypoints/sidepanel/App.tsx` (`chrome.tabs.onActivated` + `onUpdated`), verified in real Chrome. | M1 adds content-script-level detection on top; it does not replace this. |

---

## File Structure

| Path | Responsibility |
|---|---|
| `docs/youtube-dom-findings.md` | **New.** Task 1's recorded observations of the real YouTube page: selectors, page-context objects, navigation events, with the date and Chrome version observed. Every later task cites this instead of guessing. |
| `src/lib/youtube.ts` | **Extend.** Currently exports `isYoutubeWatchUrl`. Gains `parseVideoId`, `classifyYoutubeUrl` (watch / shorts / live / other). |
| `src/lib/youtube.test.ts` | **Extend.** Unit tests for the above. |
| `src/types/video.ts` | **New.** `VideoMeta`, `CaptionAvailability`, `UnsupportedReason` types. |
| `src/types/message.ts` | **Extend.** New message variants for video metadata push/pull. |
| `src/lib/db.ts` | **New.** IndexedDB wrapper, v1 schema, `videos` store only. |
| `src/lib/db.test.ts` | **New.** Tests against `fake-indexeddb` or a thin injectable adapter — Task 3 decides which and justifies it. |
| `entrypoints/content.ts` | **New.** ISOLATED-world content script: extract metadata, detect SPA navigation, push to background. |
| `entrypoints/background.ts` | **Extend.** Handle video-metadata messages, cache to IndexedDB, relay to panel. |
| `entrypoints/sidepanel/App.tsx` | **Extend.** Render real metadata; add unsupported-page branch. |
| `src/features/video/useCurrentVideo.ts` | **New.** Hook the panel uses to subscribe to current-video state. |
| `src/components/VideoCard.tsx` | **New.** Thumbnail + title + channel + duration, extracted from the inline READY markup. |
| `src/components/UnsupportedBanner.tsx` | **New.** Shorts / live / restricted messaging. |

---

## Task 1: Discover the real YouTube page contract

**Files:**
- Create: `docs/youtube-dom-findings.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a findings document that Tasks 5–8 cite. No production code.

This is a **research task**. Its output is knowledge, not behavior. Do not write extraction code here.

- [ ] **Step 1: Confirm the dev instance is up with the fixture loaded**

Run:

```bash
pnpm dev:chrome
```

Expected: banner prints the extension ID and the Karpathy URL. If Chrome is already running it reuses the instance.

Confirm the fixture tab exists:

```bash
curl -s http://localhost:9222/json/list | python3 -c "import sys,json;[print(t['url']) for t in json.load(sys.stdin) if 'youtube.com' in t.get('url','')]"
```

Expected: a line containing `watch?v=zjkBMFhNj_g`.

- [ ] **Step 2: Record how to read title, channel, duration, thumbnail**

Using CDP `Runtime.evaluate` against the YouTube tab target, determine for **each** field, in this priority order:

1. A page-context JS object (e.g. `ytInitialPlayerResponse`) — most stable if present, but **only reachable from a MAIN-world script**.
2. A `<meta>` tag or JSON-LD in `<head>` — reachable from ISOLATED world, usually stable.
3. A DOM selector — reachable from ISOLATED world, most brittle.

For each field record: the exact expression, the value it returned on the fixture, and which world can reach it.

Also record `document.title` and the `<meta property="og:*">` tags, since those are cheap ISOLATED-world options.

- [ ] **Step 3: Determine caption availability detection**

This is the field most likely to force a MAIN-world script. Investigate at minimum:

- Whether `ytInitialPlayerResponse.captions` exists and what it contains on the fixture (which has captions).
- Whether any ISOLATED-world-reachable signal exists (a DOM attribute on the CC button, a `<meta>`, etc.).
- What the shape looks like for a video **without** captions — find one and record it. Do not assume; verify.

Record whether ISOLATED world suffices. If it does not, say so plainly — Task 4 will decide the world based on this.

- [ ] **Step 4: Determine SPA navigation signals**

YouTube navigates between videos without a full page load. Record which of these actually fire on the fixture when navigating video → video, and their timing relative to the DOM being updated:

- `yt-navigate-start` / `yt-navigate-finish` custom events on `document`
- `popstate`
- `history.pushState` (would need patching, and patching page-context history from ISOLATED world is not possible)
- A `MutationObserver` on a stable container
- `chrome.tabs.onUpdated` from the extension side (already proven to work at the panel level)

Test by navigating the tab with CDP `Page.navigate` **and** by clicking an in-page related-video link (a real SPA transition — `Page.navigate` is a full load and does **not** exercise the SPA path). Record the difference.

- [ ] **Step 5: Record Shorts and live page shapes**

Load a Shorts URL and a live-stream URL in the dev instance and record how they differ from a watch page — URL shape, and whether the metadata expressions from Step 2 still resolve. This feeds Task 5's `classifyYoutubeUrl` and Task 10's banner.

- [ ] **Step 6: Write the findings document**

Create `docs/youtube-dom-findings.md` with:

- Observation date and Chrome version (`150.0.7871.184`)
- One section per field: expression, observed value, reachable world, fallback chain
- Caption availability: mechanism, with the with-captions and without-captions shapes
- SPA navigation: which signal to use and why, with the full-load vs SPA-transition distinction called out
- Shorts / live: how to detect
- An explicit **"what I could not determine"** section — do not paper over gaps

- [ ] **Step 7: Commit**

```bash
git add docs/youtube-dom-findings.md
git commit -m "docs: record youtube page contract observed on chrome 150"
```

---

## Task 2: URL classification and video ID parsing (TDD)

**Files:**
- Modify: `src/lib/youtube.ts`
- Modify: `src/lib/youtube.test.ts`

**Interfaces:**
- Consumes: `docs/youtube-dom-findings.md` §Shorts/live.
- Produces:
  - `parseVideoId(url: string | undefined): string | null`
  - `type YoutubePageKind = 'watch' | 'shorts' | 'live' | 'other'`
  - `classifyYoutubeUrl(url: string | undefined): YoutubePageKind`
  - Existing `isYoutubeWatchUrl` stays and should be re-expressed in terms of `classifyYoutubeUrl` rather than duplicating parsing.

- [ ] **Step 1: Write failing tests**

Extend `src/lib/youtube.test.ts`. Cover at minimum:

- `parseVideoId`: standard watch URL; watch URL with extra query params and a `t=` timestamp; `youtu.be/<id>`; a Shorts URL; `undefined`; a non-YouTube URL; a URL where `v` is present but empty.
- `classifyYoutubeUrl`: watch, shorts, live (use the real live URL shape from Task 1), `youtube.com/` home, a non-YouTube URL, `undefined`.
- `isYoutubeWatchUrl`: keep the existing 9 tests passing unchanged — this is a refactor, not a behavior change.

Use the URL shapes recorded in Task 1, not invented ones.

- [ ] **Step 2: Run tests, confirm RED**

```bash
pnpm test src/lib/youtube.test.ts
```

Expected: failures naming `parseVideoId` / `classifyYoutubeUrl` as undefined. Capture the output verbatim.

- [ ] **Step 3: Implement**

Implement both functions in `src/lib/youtube.ts` and re-express `isYoutubeWatchUrl` on top of `classifyYoutubeUrl`. Use the `URL` API rather than regex where practical.

- [ ] **Step 4: Confirm GREEN**

```bash
pnpm test src/lib/youtube.test.ts
```

Expected: all tests pass, including the 9 pre-existing ones, output pristine.

- [ ] **Step 5: Commit**

```bash
git add src/lib/youtube.ts src/lib/youtube.test.ts
git commit -m "feat(lib): add video id parsing and youtube page classification"
```

---

## Task 3: IndexedDB scaffolding

**Files:**
- Create: `src/lib/db.ts`, `src/lib/db.test.ts`
- Create: `src/types/video.ts`
- Modify: `package.json` (only if a dependency is genuinely required)

**Interfaces:**
- Produces:
  - `VideoMeta` in `src/types/video.ts`: `videoId`, `url`, `title`, `channelName`, `thumbnailUrl`, `durationSeconds`, `captionAvailability`, `fetchedAt`
  - `type CaptionAvailability = 'unknown' | 'available' | 'auto-only' | 'none'` — refine against Task 1's findings
  - `putVideo(meta: VideoMeta): Promise<void>`
  - `getVideo(videoId: string): Promise<VideoMeta | null>`
  - Schema version 1, single `videos` object store keyed by `videoId`

**Before you start:** decide whether to add the `idb` package or hand-roll a thin `IDBDatabase` wrapper. Hand-rolling avoids a dependency for what is currently two operations; `idb` is friendlier if M2's transcript caching grows complex. Pick one, state the reasoning in your report, and keep the surface small either way. YAGNI applies — do not build a migration framework for a v1 schema.

- [ ] **Step 1: Write failing tests**

Decide your test strategy first and justify it: `fake-indexeddb` (a dev dependency) versus an injectable adapter so the logic is testable without IndexedDB at all. Prefer whichever gives real behavioral assertions rather than mock theater.

Cover: put-then-get round trip; get of an absent id returns `null`; put with the same `videoId` overwrites rather than duplicating; `fetchedAt` survives the round trip.

- [ ] **Step 2: Run tests, confirm RED**

```bash
pnpm test src/lib/db.test.ts
```

Capture the failure output verbatim.

- [ ] **Step 3: Implement**

Implement `src/types/video.ts` and `src/lib/db.ts`.

- [ ] **Step 4: Confirm GREEN**

```bash
pnpm test
```

Expected: all suites pass, output pristine.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/db.test.ts src/types/video.ts
git commit -m "feat(lib): add indexeddb video metadata cache"
```

If you added a dependency, include `package.json` and `pnpm-lock.yaml` in a **separate preceding** commit: `chore: add <pkg> for indexeddb access`.

---

## Task 4: Content script skeleton

**Files:**
- Create: `entrypoints/content.ts`
- Modify: `wxt.config.ts` (content script registration, if wxt needs it beyond file placement)

**Interfaces:**
- Consumes: `classifyYoutubeUrl`, `parseVideoId` from `~/lib/youtube`; Task 1's world decision.
- Produces: a content script that logs the classified page kind and video id on load. **No metadata extraction yet** — that is Task 5.

**World decision:** use ISOLATED unless Task 1 proved caption detection requires MAIN. If MAIN is required, prefer a **split**: an ISOLATED script that owns messaging plus a narrowly-scoped MAIN-world script that reads only the page-context object it must, handing the value over via `window.postMessage` with an origin check. Do not put messaging or extension-API logic in MAIN world. State which shape you chose and why.

- [ ] **Step 1: Write the content script**

Minimal: on load, classify `location.href`, parse the video id, `console.log` both with a `[ypa]` prefix. Nothing else.

- [ ] **Step 2: Build and reload**

```bash
pnpm wxt build
```

Reload the extension into the dev instance. **This closes the docked panel** — that is expected here since Task 4 does not need the panel.

- [ ] **Step 3: Verify on the fixture**

Read the YouTube tab's console via CDP and confirm the `[ypa]` line reports `watch` and `zjkBMFhNj_g`. Paste the console output.

Also confirm the script does **not** run on non-YouTube pages (navigate a tab to a non-YouTube URL and confirm no `[ypa]` line).

- [ ] **Step 4: Confirm gates**

```bash
pnpm tsc --noEmit && pnpm test && pnpm wxt build
```

- [ ] **Step 5: Commit**

```bash
git add entrypoints/content.ts wxt.config.ts
git commit -m "feat(content): add youtube content script skeleton"
```

---

## Task 5: Metadata extraction in the content script

**Files:**
- Modify: `entrypoints/content.ts`
- Create: `src/lib/video-meta.ts`, `src/lib/video-meta.test.ts`

**Interfaces:**
- Consumes: Task 1 findings §title/channel/duration/thumbnail.
- Produces: `extractVideoMeta(doc: Document, url: string): Omit<VideoMeta, 'captionAvailability' | 'fetchedAt'> | null` — a **pure function over a Document**, so it is unit-testable without a browser.

Keeping extraction pure and passing `document` in is the point: it lets the fragile part be tested against fixture HTML instead of only by hand in Chrome.

- [ ] **Step 1: Capture fixture HTML**

Via CDP, dump the fixture page's relevant `<head>` metadata (and whatever containers Task 1 identified) to a test fixture file under `src/lib/__fixtures__/`. Keep it small — extract only the nodes the parser reads, not the whole 2MB page.

- [ ] **Step 2: Write failing tests**

Test `extractVideoMeta` against the fixture via jsdom (`vitest` already runs in a jsdom environment). Cover: all four fields extracted correctly from the fixture; a document missing the primary source falls back to the secondary per Task 1's fallback chain; a document with nothing usable returns `null`.

- [ ] **Step 3: Confirm RED**, capture output.

- [ ] **Step 4: Implement `extractVideoMeta`**, then wire the content script to call it and log the result.

- [ ] **Step 5: Confirm GREEN**, then rebuild, reload, and verify against the live fixture page via CDP — the logged title must be the real `[1hr Talk] Intro to Large Language Models` and the channel `Andrej Karpathy`. Paste the console output.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/content.ts src/lib/video-meta.ts src/lib/video-meta.test.ts src/lib/__fixtures__
git commit -m "feat(content): extract video title, channel, duration, thumbnail"
```

---

## Task 6: Caption availability detection

**Files:**
- Modify: `entrypoints/content.ts` (and the MAIN-world script if Task 4 created one)
- Modify: `src/lib/video-meta.ts`, `src/lib/video-meta.test.ts`

**Interfaces:**
- Consumes: Task 1 findings §captions.
- Produces: caption availability folded into the extracted metadata as `CaptionAvailability`.

- [ ] **Step 1: Write failing tests** for the detection logic against both the with-captions fixture and a without-captions fixture (capture the second one from the real video you found in Task 1 Step 3).

- [ ] **Step 2: Confirm RED**, capture output.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Confirm GREEN.**

- [ ] **Step 5: Verify in real Chrome** on both videos — the fixture (captions present) and the no-caption video. Paste both console outputs.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/content.ts src/lib/video-meta.ts src/lib/video-meta.test.ts src/lib/__fixtures__
git commit -m "feat(content): detect english caption availability"
```

---

## Task 7: SPA navigation detection

**Files:**
- Modify: `entrypoints/content.ts`

**Interfaces:**
- Consumes: Task 1 findings §SPA navigation.
- Produces: the content script re-extracts and re-reports whenever the user navigates video → video without a page load.

- [ ] **Step 1: Implement** using the signal Task 1 identified. Guard against duplicate reports for a single navigation, and against reporting before the DOM has actually updated (Task 1 recorded the timing — respect it).

- [ ] **Step 2: Verify with a genuine SPA transition.** A CDP `Page.navigate` is a full load and does **not** exercise this path. Instead click an in-page related-video link via CDP `Runtime.evaluate` (find an anchor to another watch URL and `.click()` it), then confirm the content script logged the **new** video id without a page reload. Paste the console output showing both the old and new ids.

- [ ] **Step 3: Confirm gates**, then commit:

```bash
git add entrypoints/content.ts
git commit -m "feat(content): detect spa navigation between videos"
```

---

## Task 8: Message pipeline — content → background → panel

**Files:**
- Modify: `src/types/message.ts`, `entrypoints/background.ts`, `entrypoints/content.ts`
- Create: `src/features/video/useCurrentVideo.ts`

**Interfaces:**
- Produces:
  - Message `VIDEO_DETECTED` (content → background) carrying `VideoMeta`
  - Message `GET_CURRENT_VIDEO` (panel → background) returning `VideoMeta | null`
  - Background caches to IndexedDB on receipt and pushes to the panel
  - `useCurrentVideo()` → `{ video, kind, loading }`

Extend the existing discriminated-union pattern in `src/types/message.ts`; do not invent a parallel messaging mechanism. The background's generic `handle<T>()` must stay exhaustive.

**Panel push:** the panel needs to update when a new video is detected while it is open. Decide between `chrome.runtime.sendMessage` broadcast from background versus the panel polling on `chrome.tabs` events it already listens to. Prefer the push — polling on tab events would miss same-tab SPA transitions that the content script sees first. State your choice and why.

- [ ] **Step 1: Extend message types.** Then `pnpm tsc --noEmit` — the background switch should now fail to compile until you handle the new variants. Confirm that it does; that is the type system doing its job. Paste the error.

- [ ] **Step 2: Write an integration test** for the background handler covering the new message types (this also closes the M0 review's outstanding "no test for the message dispatch layer" gap). Assert real shapes, not mocks of your own code.

- [ ] **Step 3: Confirm RED**, capture output.

- [ ] **Step 4: Implement** background handling, content-script sending, and the `useCurrentVideo` hook.

- [ ] **Step 5: Confirm GREEN.**

- [ ] **Step 6: Verify in real Chrome** that a `VIDEO_DETECTED` message actually round-trips: with the panel open, read the panel's state via CDP and confirm it holds the fixture's real title. **If the docked panel is closed, stop and report NEEDS_CONTEXT for a click** rather than skipping this.

- [ ] **Step 7: Commit**

```bash
git add src/types/message.ts entrypoints/background.ts entrypoints/content.ts src/features/video/useCurrentVideo.ts
git commit -m "feat: pipe detected video metadata from content script to panel"
```

---

## Task 9: Panel renders the real video card

**Files:**
- Create: `src/components/VideoCard.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`

**Interfaces:**
- Consumes: `useCurrentVideo`, `VideoMeta`.
- Produces: the READY branch shows real data.

Design source: `docs/design/extension-popup.dc.html` READY block — thumbnail, two-line-clamped title, channel, duration badge, and the caption-availability bar. That file is the panel's design reference now. Replace the M0 placeholders:

| Placeholder | Replace with |
|---|---|
| `영상 정보 로딩 중` | real title |
| `—` | real channel |
| striped thumbnail | real `thumbnailUrl` |
| `자막 정보 확인 중` | `English captions available` / `자막 없음` per `CaptionAvailability` |

Keep `AI 자막 생성` **disabled** — M2 enables it. Keep the header (title, StatusBadge, gear, `×`) unchanged. Keep the `처리 단계` footer static.

Handle the in-between state honestly: metadata may not have arrived yet on first paint. Show a loading treatment rather than flashing `—`.

- [ ] **Step 1: Extract `VideoCard`** from the inline markup, taking `VideoMeta` as props. Light and dark both.

- [ ] **Step 2: Wire it** into the READY branch via `useCurrentVideo`.

- [ ] **Step 3: Verify in `pnpm preview`** first (fast iteration) with mocked metadata, then in real Chrome. Real Chrome is the one that counts — paste a panel screenshot path and the asserted text content showing the real Karpathy title and channel.

- [ ] **Step 4: Confirm gates**, then commit:

```bash
git add src/components/VideoCard.tsx entrypoints/sidepanel/App.tsx
git commit -m "feat(sidepanel): render real video metadata in ready state"
```

---

## Task 10: Unsupported pages

**Files:**
- Create: `src/components/UnsupportedBanner.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`, `src/types/video.ts`

**Interfaces:**
- Produces: `type UnsupportedReason = 'shorts' | 'live' | 'restricted' | 'no-metadata'` and a panel branch rendering it.

Korean copy, one line each, stating what is unsupported and why — no apology boilerplate. Shorts and live are **out of scope by design** (PRD §7.1), not failures; word them accordingly. `restricted` and `no-metadata` are genuine failures and may offer a retry.

- [ ] **Step 1: Implement** the component and the panel branch.

- [ ] **Step 2: Verify in real Chrome** by navigating the dev tab to a Shorts URL and a live URL (the ones recorded in Task 1 Step 5) and asserting the panel's rendered text for each. Paste both.

- [ ] **Step 3: Confirm gates**, then commit:

```bash
git add src/components/UnsupportedBanner.tsx entrypoints/sidepanel/App.tsx src/types/video.ts
git commit -m "feat(sidepanel): show unsupported banner for shorts, live, restricted"
```

---

## Task 11: Deferred polish from the M0 review

**Files:**
- Modify: `src/components/Button.tsx`, `src/components/Input.tsx`
- Create: `assets/icons/` (16/32/48/128 px)
- Modify: `wxt.config.ts`

**Interfaces:** no API changes.

Three items the M0 final review filed as Minor and the dev-tooling work re-surfaced:

1. `Button` — set a default `type="button"`. M1 introduces no forms, but the next one that appears will otherwise cause a surprise submit.
2. `Input` — add `aria-label` (or `aria-pressed`) to the reveal toggle.
3. **Icons** — the manifest has none, so the pinned toolbar button renders a generic glyph, which made the extension hard to identify during dev-tooling verification. Add simple placeholder icons at the four sizes and register them. Keep them plainly provisional; this is not a branding exercise.

- [ ] **Step 1: Button and Input fixes.** Confirm no existing call site breaks (`pnpm tsc --noEmit`, and check the panel and Options still render in `pnpm preview`).

- [ ] **Step 2: Icons.** Generate or hand-author four PNGs, register under `manifest.icons` and `action.default_icon`.

- [ ] **Step 3: Verify in real Chrome** — rebuild, reload, and confirm the toolbar button now shows the icon. A screenshot is the only real proof here; paste its path. **This reload closes the panel** — do it before any task that needs the panel open, or expect to request a click.

- [ ] **Step 4: Commit** (split if you prefer):

```bash
git add src/components/Button.tsx src/components/Input.tsx
git commit -m "fix(components): default button type and label the reveal toggle"

git add assets/icons wxt.config.ts
git commit -m "feat: add placeholder extension icons"
```

---

## Task 12: Regression, real-Chrome acceptance, push, tag

**Files:** none new.

- [ ] **Step 1: Full gates**

```bash
pnpm test
pnpm tsc --noEmit
pnpm wxt build
```

All green, output pristine. Paste each.

- [ ] **Step 2: Real-Chrome acceptance**

From a cold start (`pnpm dev:chrome:stop` then `pnpm dev:chrome`), with the panel opened by a human click, verify and paste evidence for each:

1. Panel shows the fixture's **real** title (`[1hr Talk] Intro to Large Language Models`) and channel (`Andrej Karpathy`).
2. Caption availability is reported, matching what Task 1 recorded for this video.
3. Clicking an in-page related-video link updates the panel to the **new** video without a page reload.
4. Navigating to a Shorts URL shows the unsupported banner; navigating back to a watch URL recovers.
5. Switching to a non-YouTube tab shows `유튜브 영상 페이지로 이동해주세요`; switching back recovers. (M0 behavior — confirm no regression.)
6. `AI 자막 생성` is still `disabled`.
7. Stored API key untouched: `savedAt` is still `2026-07-26T16:19:11.169Z`.

- [ ] **Step 3: Confirm no secrets in the diff**

```bash
git log -p origin/main..HEAD | grep -iE "AQ\.Ab8RN6|AIza[A-Za-z0-9_-]{20}" || echo "clean"
git ls-files --error-unmatch .env.local 2>/dev/null && echo "LEAK" || echo "clean"
```

- [ ] **Step 4: Push and tag**

```bash
git push origin main
git tag -a v0.1.0-m1 -m "M1: video recognition"
git push origin v0.1.0-m1
```

---

## Self-Review Notes

**Spec coverage against PRD §7.1 / §7.2 / IMPLEMENTATION_PLAN M1:**
- ✅ Video page detection, videoId extraction → Task 2
- ✅ Title, channel, duration, thumbnail → Tasks 1, 5
- ✅ SPA navigation detection → Tasks 1, 7 (panel-level already done pre-M1)
- ✅ Caption availability → Tasks 1, 6
- ✅ Shorts / live / restricted excluded with clear messaging → Tasks 2, 10
- ✅ Content → background → panel pipeline → Task 8
- ✅ Metadata caching → Task 3
- ✅ M0 review debt: content-script conventions (Task 1 findings + Task 4), IndexedDB (Task 3), background message test (Task 8 Step 2), Button/Input/icons (Task 11)
- ✅ i18n — decided against, documented above rather than left open

**Deliberately out of scope (M2 and later):** transcript extraction, Gemini translation, subtitle overlay, progress reporting, enabling `AI 자막 생성`, search, bookmarks, summary, export, speech recognition for caption-less videos.

**Structural risk:** Tasks 5–7 depend on YouTube's page internals, which no plan can pin down from memory. Task 1 exists to replace guesswork with measurement, and later tasks are written to cite it. If Task 1 finds that caption availability requires a MAIN-world script, Task 4's world decision changes — that branch is anticipated in the task text rather than assumed away.
