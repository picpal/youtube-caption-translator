# YouTube page contract — observed measurements

**Observation date:** 2026-07-27
**Chrome version:** `150.0.7871.184` (dev instance, profile `.chrome-dev-profile`, CDP port 9222)
**Fixture video:** `https://www.youtube.com/watch?v=zjkBMFhNj_g` — Andrej Karpathy, "[1hr Talk] Intro to Large Language Models"
**Page UI locale:** `document.documentElement.lang === "ko-KR"` — the dev profile renders YouTube in Korean. Every `aria-label` / tooltip value below is therefore **locale-dependent**.

## How world-reachability was determined

Every expression was evaluated **twice against the same page target in the same instant**:

1. In the page's **MAIN world** — CDP `Runtime.evaluate` against the target's default execution context.
2. In a real **ISOLATED world** — CDP `Page.createIsolatedWorld` (`grantUniveralAccess: false`) on the main frame, then `Runtime.evaluate` with that `contextId`. It shares the DOM but has its own JS global.

The isolation was verified positively, not assumed:

```
### typeof window.ytInitialPlayerResponse
  MAIN:  "object"
  ISO :  "undefined"
### typeof window.ytcfg
  MAIN:  "object"
  ISO :  "undefined"
```

> ⚠️ **Load-bearing assumption — not verified.** `Page.createIsolatedWorld` is *believed* to be the same isolation primitive Chromium gives a content script, which is why it was used as a proxy. **This was never cross-checked by registering an actual content script**, because that requires reloading the extension, which the task forbade. Every "ISOLATED-reachable" claim in this document rests on that equivalence. Task 4 should confirm it once with a trivial real content script before the rest of this document is trusted.

**What the "ISOLATED-reachable" label does and does not guarantee:**

- ✅ **Guaranteed measured.** The *world* column — whether a given expression returned a value from the isolated context or `undefined`. Every such value was actually read from that context, in the same instant as the MAIN read.
- ⚠️ **Not uniformly measured.** The *SPA-safe* column. Some entries were observed surviving a real in-page transition; others are inferred from "it is a live DOM read, so it should update." Entries in the second category are called out inline and collected in the "Claims that rest on inference" table at the end of this document.

Before relying on any SPA-safe ✅, check that table.

---

## The single most important fact: SPA transitions leave `<head>` and inline scripts STALE

Verified by clicking a related-video anchor on the fixture (`/watch?v=zjkBMFhNj_g` → `/watch?v=7xTGNNLPyMI`) and re-reading everything afterwards:

| Source | Updates on SPA transition? | Value after transition to `7xTGNNLPyMI` |
|---|---|---|
| `location.href` | ✅ yes | `https://www.youtube.com/watch?v=7xTGNNLPyMI` |
| `document.title` | ✅ yes | `Deep Dive into LLMs like ChatGPT - YouTube` |
| `link[rel=canonical]` | ⚠️ **contested — do not rely on it** | Task 1's 25 ms poller recorded it flipping to `…7xTGNNLPyMI` at t≈1387.6 ms. **Task 5 measured the opposite**, twice: after cross-channel transitions to `qYNweeDHiyU` and to `RQWpF2Gb-gU` it was still `https://www.youtube.com/watch?v=zjkBMFhNj_g` at a moment when `ytd-watch-flexy[video-id]`, `#title h1` and `.ytp-time-duration` had all already updated. See "Contested claims" below. |
| `ytd-watch-flexy[video-id]` | ✅ yes | `7xTGNNLPyMI` |
| DOM `#title h1` | ✅ yes | `Deep Dive into LLMs like ChatGPT` |
| DOM `#owner #channel-name a` | ⚠️ **confounded — cannot tell** | `Andrej Karpathy` — but **both videos are on the same channel**, so this reading is equally consistent with fresh and with stale. See the caveat in [Channel](#channel). |
| **`meta[property="og:*"]`** | ❌ **NO — stale** | `[1hr Talk] Intro to Large Language Models` |
| **`meta[itemprop="duration"]`** | ❌ **NO — stale** | `PT59M48S` (the *old* video) |
| **JSON-LD `application/ld+json`** | ❌ **NO — stale** | `[1hr Talk] Intro to Large Language Models` |
| **inline `<script>` with `var ytInitialPlayerResponse`** | ❌ **NO — stale** | `zjkBMFhNj_g` |
| **`window.ytInitialPlayerResponse` global** | ❌ **NO — stale** | `zjkBMFhNj_g` |
| `#movie_player.getPlayerResponse()` | ✅ yes (MAIN only) | `7xTGNNLPyMI` |

This means **`og:*`, JSON-LD and `ytInitialPlayerResponse` are only trustworthy on a full document load**. Any extraction that runs after an in-page navigation must use the live DOM (or, in MAIN world, the player API).

---

## Per-field extraction

### Video ID

| Priority | Expression | Observed | World | SPA-safe |
|---|---|---|---|---|
| 1 | `new URL(location.href).searchParams.get('v')` | `zjkBMFhNj_g` | **both** | ⚠️ ✅ derived |
| 2 | `document.querySelector('ytd-watch-flexy')?.getAttribute('video-id')` | `"zjkBMFhNj_g"` | **both** | ✅ |
| 3 | `document.querySelector('link[rel="canonical"]')?.href` | `https://www.youtube.com/watch?v=zjkBMFhNj_g` | **both** | ⚠️ **full load only** — see the contested-claims entry |
| 4 | `window.ytInitialPlayerResponse.videoDetails.videoId` | `"zjkBMFhNj_g"` | MAIN only | ❌ stale |

**Recommended chain:** URL param → `ytd-watch-flexy[video-id]` → `link[rel=canonical]` **(full-load-only last resort)**.

> The order is unchanged, but row 3's role has narrowed. `link[rel=canonical]` earns its place because it is the documented way to recover the `/watch?v=<id>` form from the `/live/<id>` and `/@handle/live` URL shapes — and those are always full loads, where it is correct. It must **never** be read as evidence of freshness after an in-page navigation. Because rows 1 and 2 were both measured fresh post-SPA, row 3 is only ever reached when they fail.

> ⚠️ Row 1 is marked "derived" because `location.href` itself was measured fresh in both worlds after an SPA transition, but the `new URL(...).searchParams.get('v')` derivation on top of it was **never actually executed** during this research. The underlying reading is solid; the one-line extraction is untested. See item 6 of the inference table.

Note: `meta[itemprop="videoId"]` and `meta[itemprop="channelId"]` do **not** exist (both returned `undefined`). There *is* `<meta itemprop="identifier" content="zjkBMFhNj_g">`, but it is part of the stale `<head>` block.

### Title

| Priority | Expression | Observed | World | SPA-safe |
|---|---|---|---|---|
| 1 | `document.querySelector('#title h1')?.textContent?.trim()` | `"[1hr Talk] Intro to Large Language Models"` | **both** | ✅ |
| 1b | `document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent` | `"[1hr Talk] Intro to Large Language Models"` | **both** | ✅ |
| 2 | `document.title` (strip trailing `" - YouTube"`) | `"[1hr Talk] Intro to Large Language Models - YouTube"` | **both** | ✅ |
| 3 | `meta[property="og:title"]` / `meta[name="title"]` / `meta[itemprop="name"]` | `"[1hr Talk] Intro to Large Language Models"` | **both** | ❌ stale after SPA |
| 4 | `ytInitialPlayerResponse.videoDetails.title` | `"[1hr Talk] Intro to Large Language Models"` | MAIN only | ❌ stale after SPA |

**Recommended chain:** `#title h1` → `document.title` minus the `" - YouTube"` suffix → `og:title` (full-load only).

### Channel

| Priority | Expression | Observed | World | SPA-safe |
|---|---|---|---|---|
| 1 | `document.querySelector('#owner #channel-name a')?.textContent?.trim()` | `"Andrej Karpathy"` | **both** | ⚠️ see note |
| 1b | `document.querySelector('#owner #channel-name a')?.getAttribute('href')` | `"/@AndrejKarpathy"` | **both** | ⚠️ **not measured after SPA** |
| 1c | `document.querySelector('ytd-video-owner-renderer a.yt-simple-endpoint')?.getAttribute('href')` | `"/@AndrejKarpathy"` | **both** | ⚠️ **not measured after SPA** |
| 2 | `document.querySelector('[itemprop="author"] [itemprop="name"]')?.getAttribute('content')` | `"Andrej Karpathy"` | **both** | ❌ stale after SPA |
| 3 | `ytInitialPlayerResponse.videoDetails.author` / `.channelId` | `"Andrej Karpathy"` / `"UCXUPKJO5MZQN11PqgIvyuvQ"` | MAIN only | ❌ stale after SPA |

> ⚠️ **The channel SPA-safety measurement is confounded — do not treat it as proven.** The only post-SPA channel reading came from the transition `zjkBMFhNj_g` → `7xTGNNLPyMI`, and **both videos belong to the same channel (Andrej Karpathy)**. The post-transition value `"Andrej Karpathy"` is therefore consistent with the element being fresh *and* with it being stale — the measurement cannot distinguish the two. Row 1 is marked ⚠️ for that reason.
>
> Rows 1b and 1c (the `/@handle` href) and the avatar below were **not read at all after the SPA transition** — only on a full load. Their SPA behaviour is entirely unmeasured.
>
> Task 5/6 should re-verify channel extraction across a transition between **two different channels** before relying on any of these.

There is **no ISOLATED-reachable source for the raw `channelId` (`UC…`) that survives an SPA transition.** The handle (`/@AndrejKarpathy`) is available; the `UC…` id is only in the MAIN-world player response / the stale `<head>`.

Channel avatar (bonus, both worlds; **SPA behaviour not measured** — see the note above):
`document.querySelector('ytd-video-owner-renderer img')?.src` → `https://yt3.ggpht.com/ytc/AIdro_nDvyq2NoPL626bk1IbxQ94SfQsD-B0qgZchghtQNkLWoEz=s48-c-k-c0x00ffffff-no-rj`

### Duration

**This table is ordered by freshness, NOT by preference — do not read it as a fallback chain.** The two sources that survive an SPA transition are also the two that return the *wrong number* during a pre-roll ad. See the recommended chain below the table.

| # | Expression | Observed | World | SPA-safe | Ad-immune | Notes |
|---|---|---|---|---|---|---|
| A | `document.querySelector('video')?.duration` | `3587.701` | **both** | ✅ | ❌ **no** | Returns the **ad's** duration while a pre-roll plays. |
| B | `document.querySelector('.ytp-time-duration')?.textContent` | `"59:47"` (no ad) | **both** | ✅ | ❌ **no** | Same ad caveat. Formats as `M:SS` / `H:MM:SS` / `D:HH:MM:SS`. |
| C | `meta[itemprop="duration"]` (ISO-8601) | `"PT59M48S"` | **both** | ❌ stale after SPA | ✅ yes | Correct on a full load. |
| D | `ytInitialPlayerResponse.videoDetails.lengthSeconds` | `"3588"` (string) | MAIN only | ❌ stale after SPA | ✅ yes | |
| E | `#movie_player.getDuration()` | `3587.701` | MAIN only | ✅ | ❌ **no** | Same ad caveat as A. |
| F | `#movie_player.getPlayerResponse().videoDetails.lengthSeconds` | not measured | MAIN only | ✅ (inferred) | ✅ (inferred) | **Untested.** The player-response object *was* measured fresh after an SPA transition for other fields, so this is the most promising ad-immune + SPA-safe candidate — but `lengthSeconds` specifically was never read from it. |

**Recommended chain (with the caveat that no option is fully satisfactory):**

1. On a **full load**: `meta[itemprop="duration"]` (C) — ad-immune and ISOLATED-reachable.
2. After an **SPA transition**, ISOLATED-only: `.ytp-time-duration` (B), but **only once no ad is playing**. Gate it on the ad state (`#movie_player` carries an `ad-showing` class during playback — *this gating was not tested*, see gaps).
3. If MAIN world is available anyway (e.g. for captions): try (F) first and fall back to (C)/(B).

**Duration is the least reliable field in this document.** No measured source is simultaneously ISOLATED-reachable, SPA-safe, and ad-immune. See "What I could not determine".

**On the ad caveat, stated precisely:** `.ytp-time-duration` was observed reading `"0:30"` and `"1:13"` at moments when a pre-roll ad was playing, on pages whose real durations are certainly much longer. **I did not measure the true runtime of those pages**, so I cannot quantify the error — only that the value read was an ad length, not a video length. (An earlier draft of this document stated one of those pages was "~52 min"; that figure had no measurement behind it and has been removed.)

**Fixture baseline discrepancy, explained:** this section reports `.ytp-time-duration === "59:47"` for the fixture, while the Shorts/live comparison table further down reports `"1:13"` for the *same* fixture. Both are genuine readings: `"59:47"` was taken with no ad playing (the true value, matching `PT59M48S`), `"1:13"` was taken mid-pre-roll. **`"1:13"` in that table is an ad artefact and must not be read as a VOD baseline.**

### Thumbnail

| Priority | Expression | Observed | World | SPA-safe |
|---|---|---|---|---|
| 1 | Construct from video id: `https://i.ytimg.com/vi/<id>/hqdefault.jpg` (or `maxresdefault.jpg`) | — | **both** | ✅ |
| 2 | `meta[property="og:image"]` | `https://i.ytimg.com/vi/zjkBMFhNj_g/maxresdefault.jpg` | **both** | ❌ stale after SPA |
| 3 | `ytInitialPlayerResponse.videoDetails.thumbnail.thumbnails` | array of 5, `168×94` … `1920×1080` (`.../vi_webp/zjkBMFhNj_g/maxresdefault.webp`) | MAIN only | ❌ stale after SPA |

**Recommendation: construct the URL from the video id.** It is the only option that is both ISOLATED-reachable and SPA-safe.

> ⚠️ **Not measured:** the claim that `i.ytimg.com/vi/<id>/hqdefault.jpg` always exists while `maxresdefault.jpg` does not exist for every video is **general knowledge, not a measurement — zero HTTP requests were issued during this research.** The observed `thumbnail.thumbnails` array on the fixture did include a `maxresdefault` entry. Task 5/6 should handle a 404 on the constructed URL rather than assuming either form resolves.

Companion tags on a full load (both worlds): `og:image:width` = `1280`, `og:image:height` = `720`.

### `document.title` and `og:*` summary

`document.title` = `"[1hr Talk] Intro to Large Language Models - YouTube"` (title + literal `" - YouTube"` suffix). Present in both worlds and it **does** update on SPA transitions — but only *after* `yt-navigate-finish` fires (see below).

> On timing precision: the "~90 ms" figure used below is an **upper bound derived from a 25 ms poll plus the `yt-page-data-updated` timestamp**, not a measurement of the exact moment `document.title` changed. The event handler at `yt-navigate-finish` (t=1372) saw the old title; the handler at `yt-page-data-updated` (t=1460.9) saw the new one. The true change instant lies somewhere in that ~89 ms window. What is *measured* — and what matters — is the ordering: **old at `yt-navigate-finish`, new at `yt-page-data-updated`.**

Full `og:*` set present on a watch page (all readable from both worlds, all stale after SPA):
`og:site_name`=`YouTube`, `og:url`, `og:title`, `og:image`, `og:image:width`, `og:image:height`, `og:description`, `og:type`=`video.other`, `og:video:url`=`https://www.youtube.com/embed/<id>`, `og:video:width`=`1280`, `og:video:height`=`720`.

---

## Caption availability

### With captions — auto-generated only (the fixture)

```
window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer
  keys: ["captionTracks","audioTracks","translationLanguages","defaultAudioTrackIndex"]
  captionTracks: [{"name":"영어 (자동 생성됨)","languageCode":"en","kind":"asr",
                   "vssId":"a.en","isTranslatable":true,"trackName":"","hasBaseUrl":true}]
  translationLanguages: 156 entries, includes languageCode "ko"
  audioTracks: [{"captionTrackIndices":[0]}]
  defaultAudioTrackIndex: 0
```

### With captions — manual tracks present

Verified on `https://www.youtube.com/watch?v=MB5IX-np5fE` ("This could be why you're depressed or anxious | Johann Hari"):

```
captionTracks: [ {lang:"gu", kind:"(absent)", vssId:".gu"},  … 34 manual tracks …
                 {lang:"en", kind:"(absent)", vssId:".en"},
                 {lang:"en", kind:"asr",      vssId:"a.en"}, … ]
```

**Manual vs auto discriminator:** a manual track has **no `kind` property at all** and a `vssId` beginning with `"."`; an auto track has `kind === "asr"` and `vssId` beginning with `"a."`. This is the *only* place the distinction is visible.

### Without captions

Verified on `https://www.youtube.com/watch?v=I_6ZcOo6pnk` ("[ 8K resolution ] - 10 Hours Black Screen - No Sound", `playabilityStatus: "OK"`):

```
{"videoId":"I_6ZcOo6pnk","hasCaptionsKey":false,"captionsTypeof":"undefined","trackCount":0,"tracks":[],
 "ccBtnExists":true,"ccAriaLabel":"자막 사용 불가","ccAriaPressed":"false",
 "ccTooltip":"자막 사용 불가","ccClass":"ytp-subtitles-button ytp-button",
 "ccDisplay":"block","ccOffsetWidth":48,"transcriptSection":false}
```

The `captions` key is **entirely absent** from `ytInitialPlayerResponse` — not an empty object, not an empty array. Test with `'captions' in playerResponse`, not `captions.playerCaptionsTracklistRenderer.captionTracks.length`.

### ISOLATED-world signals — what works and what does not

The CC button exists whether or not captions exist. `display: block` / `offsetWidth: 48` was measured on the fixture and on the no-caption video (**n=2 — not measured on the manual-caption video**), so button presence/visibility is not a usable signal.

| Attribute | Fixture (asr only) | Manual+asr video | No captions | Discriminates? |
|---|---|---|---|---|
| `data-tooltip-title` | `"자막(c)"` | `"자막(c)"` | `"자막 사용 불가"` | ✅ **yes** (has/hasn't) |
| `aria-label` | `"자막 사용 불가"` | `"자막 사용 불가"` | `"자막 사용 불가"` | ❌ **no — identical in all three** |
| `aria-pressed` | `"true"` | `"true"` | `"false"` | ⚠️ see note below |
| `class` | `ytp-subtitles-button ytp-button` | same | same | ❌ no |
| `disabled` attribute | absent | *not measured* | *not measured* | ⚠️ unknown |
| computed `display` / `offsetWidth` | `block` / `48` | *not measured* | `block` / `48` | ❌ no (n=2) |
| `ytd-video-description-transcript-section-renderer` present | `true` | `true` | `false` | ✅ **yes** (has/hasn't), locale-independent |

**The `aria-label` trap is real**: on this Korean-locale profile `aria-label` reads `"자막 사용 불가"` ("subtitles unavailable") even on a video that *does* have captions. Do not use `aria-label`.

> ⚠️ **On `aria-pressed` — my "user preference" reading is an interpretation, not a measurement.** Across the only three samples taken it discriminates *perfectly* (`true` / `true` / `false`), so on the raw data it looks like a valid signal. I labelled it unusable because `aria-pressed` on a toggle button conventionally reports the toggle's current on/off state, which would make it track the user's caption preference rather than caption availability — but **I never ran the experiment that would settle this** (toggle CC off on a captioned video and re-read the attribute). If Task 6 wants to use `aria-pressed`, run that toggle test first; do not take this row's verdict on faith.

> ⚠️ **The `disabled` row is now honest about its evidence.** `hasAttribute('disabled')` was evaluated **only on the fixture** (result: `false`). An earlier draft filled the other two columns with "absent" — those cells were never measured and have been replaced with *not measured*.

There is no `<meta>` and no JSON-LD caption hint at all:
```
### meta any caption hint          → MAIN: []   ISO: []
### ld+json has caption keys
  [["@context","@type","@id","name","thumbnailUrl","uploadDate","comment"],
   ["@context","@type","description","duration","embedUrl","name","thumbnailUrl","uploadDate",
    "@id","interactionStatistic","genre","author"]]
```

### The inline-script escape hatch (full loads only)

On a **full document load**, the ISOLATED world can recover the *entire* `ytInitialPlayerResponse` — captions included — by reading the inline `<script>` element's text and parsing it, because script text is DOM content:

```js
const sc = Array.from(document.querySelectorAll('script'))
  .find(x => x.textContent.includes('var ytInitialPlayerResponse'));
const m = sc.textContent.match(/var ytInitialPlayerResponse = (\{[\s\S]*?\});/);
JSON.parse(m[1]);
```

Verified byte-identical in both worlds on the fixture:
```
{"topKeys":["responseContext","playabilityStatus","streamingData","playerAds","playbackTracking",
  "captions","videoDetails","playerConfig","storyboards","microformat","cards","trackingParams",
  "adPlacements","adSlots","adBreakHeartbeatParams","frameworkUpdates"],
 "videoId":"zjkBMFhNj_g","title":"[1hr Talk] Intro to Large Language Models",
 "lengthSeconds":"3588","hasCaptions":true,
 "tracks":[{"lang":"en","kind":"asr","vssId":"a.en","name":"영어 (자동 생성됨)"}]}
```

**But this script is never replaced on an SPA transition.** After navigating to `7xTGNNLPyMI` the inline script still parsed to `videoId: "zjkBMFhNj_g"`, and after an SPA transition from the homepage into Shorts there was **no such script at all** (`"no-script"`).

### Decisive test: does the ISOLATED signal survive an SPA transition?

Started on the **no-caption** video, SPA-clicked to the **captioned** fixture:

```
=== BEFORE (I_6ZcOo6pnk, full load) ===
ISO : {"href":".../watch?v=I_6ZcOo6pnk","ccTooltip":"자막 사용 불가","transcriptSection":false,
       "inlineTracks":{"vid":"I_6ZcOo6pnk","tracks":[]},
       "mainGlobalVid":"undefined-global","playerApiTracks":"no-api"}

click related: "CLICKED /watch?v=zjkBMFhNj_g&t=14s"

=== AFTER SPA ===
MAIN: {"href":".../watch?v=zjkBMFhNj_g&t=14s","ccTooltip":"자막(c)","transcriptSection":true,
       "inlineTracks":{"vid":"I_6ZcOo6pnk","tracks":[]},        <-- STALE
       "mainGlobalVid":"I_6ZcOo6pnk",                            <-- STALE
       "playerApiTracks":{"vid":"zjkBMFhNj_g","tracks":["en:asr"]}}  <-- FRESH, MAIN only
ISO : {"href":".../watch?v=zjkBMFhNj_g&t=14s","ccTooltip":"자막(c)","transcriptSection":true,
       "inlineTracks":{"vid":"I_6ZcOo6pnk","tracks":[]},
       "mainGlobalVid":"undefined-global","playerApiTracks":"no-api"}
```

Both `data-tooltip-title` and the transcript-section element **did** flip correctly across the SPA transition, in the ISOLATED world.

> ⚠️ **This test was run in one direction only: no-captions → captions.** The reverse (captions → no-captions) was **never measured**. Specifically unknown:
> - whether `data-tooltip-title` reverts from `"자막(c)"` back to `"자막 사용 불가"`,
> - whether `ytd-video-description-transcript-section-renderer` is actually *unmounted* (`true` → `false`) or merely left in the DOM from the previous video.
>
> The second one is the real risk: a stale-but-present transcript section would make a no-caption video report as captioned, and the failure would be **silent**. Task 6 must verify the reverse direction before shipping either signal.

### Verdict for `CaptionAvailability = 'available' | 'auto-only' | 'none' | 'unknown'`

| Value | ISOLATED world alone | MAIN world |
|---|---|---|
| `'none'` | ⚠️ **partially** — `data-tooltip-title` and/or absence of the transcript section. Verified fresh in the has→hasn't direction only *(see the one-directional caveat above)* | ✅ `'captions' in playerResponse === false` |
| has-some-captions | ✅ yes — same signals, verified across an SPA transition | ✅ |
| **`'available'` vs `'auto-only'`** | ❌ **no** — no DOM attribute differs between the manual-caption video and the asr-only fixture | ✅ `captionTracks[].kind !== 'asr'` |

**ISOLATED does NOT suffice if `'available'` and `'auto-only'` must be told apart.** It suffices only if `'available' | 'auto-only'` may be collapsed into one bucket.

Options, in order of preference:

1. **ISOLATED content script + `'unknown'` collapse.** Report `'none'` from the tooltip/transcript signals; report `'unknown'` (or a single "captions present" state) otherwise. Cheapest, no MAIN world needed. Note the tooltip check is locale-dependent — prefer the transcript-section element, which is not.
2. **MAIN-world script.** `#movie_player.getPlayerResponse().captions.playerCaptionsTracklistRenderer.captionTracks` is fresh after SPA transitions and gives `kind`/`vssId`, so all four values can be populated. Requires `world: "MAIN"` in the content-script registration (or a page-injected script bridging back over `window.postMessage`).
3. Hybrid: ISOLATED script for everything else, with only the caption read escalated to MAIN.

---

## SPA navigation signals

Recorders were installed **in both worlds simultaneously** and every event log below was read out of `globalThis.__probeLog` in the world named on each line.

### Genuine SPA transition (clicked a related-video anchor)

MAIN world, times in ms from recorder install:

```
 347.0  yt-navigate-start        href=…zjkBMFhNj_g  flexy=zjkBMFhNj_g  detail=object:endpoint,pageType,url,reload,noProgressBar
 379.5  POLL:location.href changed  → …7xTGNNLPyMI   (flexy still zjkBMFhNj_g, title still OLD)
1208.4  yt-player-updated        (detail null)
1218.3  player.getPlayerResponse().videoId → 7xTGNNLPyMI
1372.0  yt-navigate-finish       flexy=zjkBMFhNj_g  docTitle="[1hr Talk] …"   <-- DOM STILL OLD
1387.6  link[canonical] → …7xTGNNLPyMI
1460.9  yt-page-data-updated     flexy=7xTGNNLPyMI  docTitle="Deep Dive into LLMs like ChatGPT - YouTube"
1474.8  MutationObserver ytd-watch-flexy[video-id] → 7xTGNNLPyMI
1506.4  POLL: flexy video-id and document.title observed changed
```

The ISOLATED log is the same event set at the same times (within ~1 ms). `popstate` **never fired.** `hashchange` never fired.

CDP protocol view of the same transition:

```
{"dt":352,"method":"Page.frameStartedLoading"}
{"dt":358,"method":"Page.navigatedWithinDocument","url":"https://www.youtube.com/watch?v=zjkBMFhNj_g"}   <-- OLD url!
{"dt":358,"method":"Page.frameStoppedLoading"}
{"dt":451,"method":"Page.frameStartedLoading"}
{"dt":453,"method":"Page.navigatedWithinDocument","url":"https://www.youtube.com/watch?v=7xTGNNLPyMI"}
{"dt":453,"method":"Page.frameStoppedLoading"}
{"dt":1336,"method":"Page.frameStartedLoading"}
```

`Runtime.executionContextsCleared` / `executionContextDestroyed` never fired — **the isolated world (and therefore a content script) survives an SPA transition; it is not re-injected.**

### Full page load (`Page.navigate` to the fixture)

```
 727.0  (poll) document.title, og:title, ytInitialPlayerResponse, inline script, player API — all correct already
1047.4  DOMContentLoaded          flexy=null
1144.4  window load               flexy=null
1214.9  yt-navigate-finish        flexy=""       docTitle="YouTube"        <-- DOM STILL EMPTY
1332.3  yt-page-data-updated      flexy=zjkBMFhNj_g  docTitle="[1hr Talk] …"
1424.9  yt-player-updated
```

### The full-load vs SPA-transition differences

| Signal | Full load | SPA transition (watch→watch) | SPA transition (home→shorts) |
|---|---|---|---|
| `yt-navigate-start` | ❌ **does not fire** | ✅ fires (t=347) | ✅ fires (t=18.9) |
| `yt-navigate-finish` | ✅ fires (t=1214.9) | ✅ fires (t=1372) | ✅ fires (t=1513.2) |
| `yt-page-data-updated` | ✅ fires (t=1332.3) | ✅ fires (t=1460.9) | ✅ fires (t=1513.0) |
| `yt-page-type-changed` | ❌ did not fire | ❌ did not fire (watch→watch) | ✅ fires (t=157.4) |
| `popstate` | ❌ never | ❌ **never** | ❌ never |
| `Page.navigatedWithinDocument` | ❌ (`frameNavigated` instead) | ✅ **twice** | ✅ |
| execution contexts recreated | ✅ yes | ❌ no | ❌ no |

Two further traps in that table:

- **`yt-navigate-finish` fires BEFORE the DOM is updated, in both cases.** On the SPA transition it fired at t=1372 while `ytd-watch-flexy[video-id]` was still `zjkBMFhNj_g` and `document.title` was still the old title — the DOM only caught up ~90 ms later. On the full load it fired while `flexy` was `""` and `document.title` was `"YouTube"`. Reading metadata in a `yt-navigate-finish` handler yields the **previous** video.
- **`yt-page-data-updated` and `yt-navigate-finish` do not have a stable relative order.** watch→watch: finish (1372) then data-updated (1460.9). home→shorts: data-updated (1513.0) then finish (1513.2). Do not depend on ordering.
- **`Page.navigatedWithinDocument` fires twice, and the first one carries the OLD URL.** At dt=358 it reported `watch?v=zjkBMFhNj_g` (the URL being left), only at dt=453 the new one. Anything driven by `chrome.tabs.onUpdated` / `webNavigation.onHistoryStateUpdated` should expect a duplicate/pre-change event and must debounce + re-read rather than trust the first payload.

### Recommendation

**Listen for `yt-page-data-updated` on `document`, from the ISOLATED world**, and read the DOM in that handler.

Reasons, all measured above:

- **It is the only signal at which `ytd-watch-flexy[video-id]` and `document.title` already hold the new video's values, in every case observed.** This is the whole reason to pick it. `yt-navigate-finish` also fires on both a full load and an SPA transition (see the comparison table above), and so does `yt-player-updated` (not in that table — its evidence is in the raw event logs: full load t=1424.9, SPA transition t=1208.4). Firing on both is *necessary* but not sufficient, and `yt-navigate-finish` fails the DOM-readiness test.
- It is fully **ISOLATED-reachable**: the ISOLATED log recorded it at t=1459.8 vs the MAIN log's t=1460.9 — a ~1 ms difference, and the `detail` object was readable from the isolated world too (`detailKind: "object:pageType"`).

Belt-and-braces, if extra robustness is wanted:

- Add a `MutationObserver` on `ytd-page-manager` with `attributeFilter: ['video-id']`, `subtree: true`. It fired at t=1474.8 (MAIN) / t=1473.7 (ISO) with the correct new value. Also ISOLATED-reachable, and locale/event-name independent.
- Guard with a "last seen video id" check so duplicate events are idempotent.

> ⚠️ **This `attributeFilter` observer may miss transitions entirely — treat it as a supplement, never as the primary signal.** The measured timing is self-inconsistent: the `yt-page-data-updated` handler at t=1460.9 already read `flexyVideoId: "7xTGNNLPyMI"`, yet the `[video-id]` MutationObserver only reported that change **14 ms later at t=1474.8**. MutationObserver callbacks are microtasks and should fire at or before the point the new value becomes observable, so a 14 ms lag behind an already-visible value is anomalous.
>
> The most plausible explanation is that **the `ytd-watch-flexy` element was replaced rather than mutated.** A freshly inserted node that already carries `video-id` does not trigger an `attributeFilter: ['video-id']` observer at all — which would mean the t=1474.8 record came from something else (e.g. a later attribute rewrite on the new node) and that some transitions produce **no observer callback whatsoever**.
>
> This was not investigated further. If Task 7 wants a MutationObserver backup, observe `childList` on `ytd-page-manager` **in addition to** `attributes`, and re-derive the video id from the DOM on every callback rather than trusting `mutation.target`.

**Do not use:** `popstate` (never fires), `history.pushState` patching (page-context `history` cannot be patched from an ISOLATED world), or `yt-navigate-finish` alone (fires before the DOM updates).

---

## Shorts and live

### Shorts — `https://www.youtube.com/shorts/3cRnRfPT7mM` (direct full load)

| Signal | Watch page | Shorts page |
|---|---|---|
| `location.href` | `…/watch?v=zjkBMFhNj_g` | `…/shorts/3cRnRfPT7mM` |
| `link[rel=canonical]` | `…/watch?v=zjkBMFhNj_g` | `…/shorts/3cRnRfPT7mM` — **stays `/shorts/`** |
| `og:url` | `…/watch?v=zjkBMFhNj_g` | `…/shorts/3cRnRfPT7mM` |
| **`ytd-app` attributes** | `["fix-ambient-cutoff","is-watch-page"]` | `["fix-ambient-cutoff","is-shorts-page","mini-guide-visible"]` |
| `ytd-shorts` element present | `false` | `true` |
| `ytd-watch-flexy[video-id]` | `"zjkBMFhNj_g"` | `null` |
| `script[type=application/ld+json]` count | `2` | `0` |
| `#title h1` | `"[1hr Talk] Intro…"` | `""` (empty) |
| `#owner #channel-name a` | `"Andrej Karpathy"` | `null` |
| `.ytp-time-duration` | `"1:13"` | `""` |
| `microformat…isShortsEligible` | `false` | `true` |
| player element id | `#movie_player` | `#shorts-player` |

**Detection:** the URL path (`/shorts/`) is sufficient and is the cheapest test. The DOM confirmation is `document.querySelector('ytd-app')?.hasAttribute('is-shorts-page')` — **ISOLATED-reachable, locale-independent, and it updates on SPA transitions** (measured appearing at t=184.9 during a home→shorts click). Note the **watch-page selectors silently return empty strings / null on Shorts** rather than throwing, so a Shorts guard must run *before* extraction.

Shorts *do* have `og:*` tags and a valid `meta[itemprop="duration"]` (`"PT1M11S"`) on a direct full load; they are absent after an SPA transition into Shorts (`og:url` was `null`, inline script `"no-script"`).

### Live

Three URL shapes were measured, all resolving to the same live stream `YDvsBbKfLPA` (Sky News):

| Requested URL | `location.href` after load | `link[rel=canonical]` | `ytd-app` attrs |
|---|---|---|---|
| `https://www.youtube.com/watch?v=YDvsBbKfLPA` | unchanged | `…/watch?v=YDvsBbKfLPA` | `["fix-ambient-cutoff","is-watch-page"]` |
| `https://www.youtube.com/live/YDvsBbKfLPA` | **unchanged — stays `/live/<id>`** | `…/watch?v=YDvsBbKfLPA` | `["fix-ambient-cutoff","is-watch-page"]` |
| `https://www.youtube.com/@SkyNews/live` | **unchanged — stays `/@SkyNews/live`** | `…/watch?v=YDvsBbKfLPA` | `["fix-ambient-cutoff","is-watch-page"]` |

**Neither `/live/<id>` nor `/@handle/live` rewrites `location.href` to a `/watch?v=` URL.** Both render a full watch page. A URL classifier that only recognises `/watch?v=` will miss both. `link[rel=canonical]` (and `og:url`) is the reliable way to recover the `/watch?v=<id>` form from all three shapes; `ytd-watch-flexy[video-id]` gives the bare id (`"YDvsBbKfLPA"`) in all three.

**A live stream on a plain `/watch?v=` URL is indistinguishable from a VOD by URL alone.** Signals that do distinguish it:

| Signal | VOD (fixture) | Shorts | LIVE |
|---|---|---|---|
| `getComputedStyle('.ytp-live-badge').display` | `"none"` | `"none"` | **`"inline-block"`** |
| `.ytp-live-badge` `offsetWidth` | `0` | `0` | **`51`** |
| `meta[itemprop="duration"]` | `"PT59M48S"` | `"PT1M11S"` | **`null`** |
| `script[type=application/ld+json]` count | `2` | `0` | `1` |
| `.ytp-time-duration` | `"1:13"` ⚠️ **ad artefact — see below** | `""` | `"137:04:51:37"` (DVR window) |
| `videoDetails.isLive` | absent | absent | **`true`** |
| `videoDetails.isLiveContent` | `false` | `false` | **`true`** |
| `videoDetails.lengthSeconds` | `"3588"` | `"71"` | **`"0"`** |
| `microformat…liveBroadcastDetails` | absent | absent | **`{"isLiveNow":true,"startTimestamp":"2024-12-10T12:07:17+00:00"}`** |
| `streamingData.hlsManifestUrl` | absent | absent | **present (string)** |

`.ytp-live-badge` **always exists in the DOM** — `!!document.querySelector('.ytp-live-badge')` returned `true` on the VOD, the Shorts page, and the live stream. Only its computed `display` / `offsetWidth` distinguishes. Likewise `#movie_player` carries the class `ytp-livebadge-color` on *all three* pages; it is a theming class, not a live marker.

The `.ytp-time-duration` VOD cell reads `"1:13"` because that sample was taken during a pre-roll ad; the fixture's true `.ytp-time-duration` is `"59:47"` (see the Duration section). It is listed here only to show the shape difference against the live DVR value, **not as a VOD baseline.**

**Recommended live detection:**

> ⚠️ **All three live pages were loaded with `Page.navigate` — i.e. full loads. No VOD↔LIVE SPA transition was ever performed.** Every "SPA" property below is therefore unmeasured for live detection specifically.

> ⚠️ **Superseded by Task 5 — prefer the plain class checks in "Contested claims" below.** `.ytp-time-display.ytp-live` and the `ytp-live-badge-is-livehead` class / `disabled` attribute discriminate just as well, need no `getComputedStyle`, and `ytp-live` was measured clearing correctly across a live→VOD in-page navigation. Task 5 implements those, not the visibility check below.

1. **ISOLATED reachability measured; SPA behaviour NOT measured** — `getComputedStyle(document.querySelector('.ytp-live-badge')).display !== 'none'` (or `offsetWidth > 0`). The ISOLATED read was verified (identical `"inline-block"` / `51` in both worlds). Whether the badge's visibility updates correctly when navigating VOD→live or live→VOD in-page is **unknown**. It is a computed style on a live player element, so it *plausibly* updates — but that is inference. **This is the highest-risk recommendation in this document**, because it is ranked first and Task 5 is likely to implement it verbatim. Verify it across a real SPA transition first.
2. ISOLATED, full-load only: `meta[itemprop="duration"] === null` on an otherwise-valid watch page. (Known stale after any SPA transition — the `<head>` staleness result applies.)
3. MAIN, measured fresh after SPA transitions for other fields: `#movie_player.getPlayerResponse().videoDetails.isLive === true`. The player-response object was verified fresh post-SPA; the `isLive` field specifically was only read on full loads.

---

## What I could not determine

- **The equivalence of `Page.createIsolatedWorld` and a real content-script ISOLATED world.** This is the single assumption the whole document rests on, and it was **not verified** — doing so requires registering a content script, which requires reloading the extension, which the task forbade. Everything labelled "ISOLATED-reachable" should be confirmed once against a trivial real content script before Tasks 5–8 build on it.
- **A duration source that is simultaneously ISOLATED-reachable, SPA-safe, and ad-immune.** `video.duration` and `.ytp-time-duration` report the *pre-roll ad's* length while an ad plays — observed `.ytp-time-duration === "0:30"` and `"1:13"` at moments when an ad was running. **I did not measure the true runtime of those pages**, so the size of the error is unquantified. `meta[itemprop="duration"]` is ad-immune but stale after an SPA transition. I did not find or test a workaround (e.g. gating on `#movie_player` losing the `ad-showing` class, reading `.ytp-progress-bar[aria-valuemax]`, or reading `lengthSeconds` off `getPlayerResponse()`); Task 5/6 will need to solve this. I also did not verify how `.ytp-time-duration` formats videos over 24 h beyond seeing `"137:04:50:27"` on a live DVR window.
- **Channel extraction across a transition between two *different* channels.** The one SPA transition measured (`zjkBMFhNj_g` → `7xTGNNLPyMI`) stayed on the same channel, so the post-transition `"Andrej Karpathy"` reading cannot distinguish fresh from stale. The owner `href` and the avatar `src` were not read after the transition at all.
- **Whether live detection survives an SPA transition.** All three live URL shapes were loaded with `Page.navigate` (full loads). **No VOD↔LIVE in-page transition was performed.** The `.ytp-live-badge` visibility check — the document's first-ranked live recommendation — has verified ISOLATED reachability but entirely unverified SPA behaviour. **Partly resolved by Task 5:** it performed a live→VOD in-page navigation and measured `.ytp-time-display`'s `ytp-live` class clearing correctly. The **VOD→live** direction is still unmeasured — no live video appeared in any related rail sampled.
- **The reverse caption direction (captions → no captions) across an SPA transition.** Only no-captions → captions was tested. Whether `data-tooltip-title` reverts, and whether `ytd-video-description-transcript-section-renderer` is genuinely unmounted rather than left over from the previous video, is unknown. A stale leftover would misreport a no-caption video as captioned, silently.
- **Whether `aria-pressed` on the CC button tracks caption *availability* or the user's caption *preference*.** Across the three samples taken it discriminated perfectly (`true`/`true`/`false`). I labelled it unusable on the conventional reading of `aria-pressed` on a toggle button, but never ran the settling experiment (toggle CC off on a captioned video, re-read).
- **Whether the `attributeFilter: ['video-id']` MutationObserver reliably fires at all.** Its measured callback lagged 14 ms *behind* a value that was already observable, which suggests `ytd-watch-flexy` is replaced rather than mutated — in which case some transitions would produce no callback. Not investigated.
- **Whether the constructed thumbnail URLs actually resolve.** Zero HTTP requests were issued during this research. The `hqdefault.jpg`-always-exists / `maxresdefault.jpg`-sometimes-404s claim is general knowledge, not measurement.
- **The exact instant `document.title` changes after an SPA transition.** The "~90 ms" figure is an upper bound from a 25 ms poll plus event timestamps, not a direct measurement. Only the *ordering* (old at `yt-navigate-finish`, new at `yt-page-data-updated`) is measured.
- **Whether `data-tooltip-title` / `aria-label` values differ under an English UI.** Everything here was observed with `document.documentElement.lang === "ko-KR"`. I did not switch the dev profile's locale, so I cannot state the English strings. The **presence/absence of `ytd-video-description-transcript-section-renderer`** is the locale-independent alternative — but I only observed it on three videos and did not test whether it is lazily rendered (it could be `false` transiently right after navigation, before the description section mounts).
- **Whether `ytd-video-description-transcript-section-renderer` is reliable on videos with manual-only captions and no ASR track.** Both captioned videos I tested happened to include an `asr` track.
- **A `/watch?v=` → SPA → `/shorts/` transition.** No `/shorts/` anchors existed in the fixture's related rail (`NO_SHORTS_LINK_ON_PAGE`); I measured home→shorts instead. The watch→shorts path may behave differently.
- **Whether a `chrome.runtime`-side signal (`chrome.tabs.onUpdated`, `webNavigation.onHistoryStateUpdated`) fires on these transitions and with what timing.** I measured the page-side CDP equivalent (`Page.navigatedWithinDocument`, twice, first with the old URL) but did not instrument the extension's background worker, because doing so would have required reloading the extension.
- **Whether `#movie_player.getPlayerResponse()` is ever transiently stale or absent right after `yt-page-data-updated`.** I observed it going to `"no-api"` at t=379.9 and back to the new id at t=1218.3, i.e. it was already fresh before `yt-page-data-updated` fired in that one run. One sample; I did not repeat it.
- **Live-stream caption behaviour.** The live stream I tested (`YDvsBbKfLPA`) had `captionTracks: []` and `data-tooltip-title: "자막 사용 불가"`. I did not find a live stream *with* live captions, so I cannot say what that shape looks like.
- **`playabilityStatus` values other than `"OK"` and `"ERROR"`.** `"ERROR"` was seen only on a bare `/shorts/` redirect, not on a genuinely unplayable video. Age-gated / members-only / region-blocked shapes were not measured.
- **How any of this behaves while signed out.** The dev profile has a signed-in session (a `accounts.google.com` sign-in iframe target is present); I did not test a logged-out page.

---

## Claims that rest on inference — re-verify before relying on these

Everything in this document was produced from real CDP measurements against a real page, and no value quoted here was invented. But not every *claim* is a measurement — some are readings of the data, some are extrapolations, and one is a load-bearing assumption. Tasks 5–8 cite this document, so the distinction is recorded explicitly.

| # | Where | Claim | Evidence grade | What to do |
|---|---|---|---|---|
| 1 | "How world-reachability was determined" | `Page.createIsolatedWorld` ≡ a content script's ISOLATED world | **Inference. The premise the entire document rests on.** | Confirm once with a trivial real content script (Task 4) |
| 2 | Channel, rows 1 / 1b / 1c + avatar | Channel name, `/@handle`, avatar survive an SPA transition | **Confounded measurement** (same channel both sides) for row 1; **not measured at all** for 1b/1c/avatar | Re-test across two different channels |
| 3 | Live detection #1 | `.ytp-live-badge` visibility is SPA-safe | **Not measured.** ISOLATED reachability *was* measured; SPA behaviour was not. **Task 5 superseded this with plain class checks** and measured `ytp-live` clearing across live→VOD | VOD→live in-page transition still untested |
| 4 | Caption attribute table, `disabled` row | No `disabled` attribute on the CC button | **Measured on the fixture only** (n=1); other two cells now marked *not measured* | Measure on the no-caption video if it matters |
| 5 | Caption attribute table, `aria-pressed` row | Reflects user CC on/off preference, not availability | **Interpretation.** Raw data (`true`/`true`/`false`) actually discriminates perfectly | Toggle CC off on a captioned video and re-read |
| 6 | Video ID, row 1 | `new URL(location.href).searchParams.get('v')` | `location.href` measured in both worlds; the `searchParams` derivation was **never executed** | Trivial — but it is a derivation, not a reading |
| 7 | Thumbnail recommendation | `hqdefault.jpg` always exists, `maxresdefault.jpg` does not | **General knowledge. Zero HTTP requests issued.** | Handle a 404 rather than assuming |
| 8 | `document.title` / SPA section | `document.title` updates "~90 ms" after `yt-navigate-finish` | **Upper bound** from a 25 ms poll + event timestamps, not the true change instant | Ordering is measured and sufficient; ignore the number |
| 9 | Caption section intro | CC button always `display:block` / `offsetWidth:48` | **n=2** — fixture and no-caption video; the manual-caption video was not measured | Low risk |
| 10 | Caption 3f test | ISOLATED caption signals flip correctly across SPA | **Measured, but one direction only** (no-captions → captions) | Test captions → no-captions |
| 11 | Duration, row F | `getPlayerResponse().videoDetails.lengthSeconds` is fresh + ad-immune post-SPA | **Inference** from other fields of the same object being fresh; this field was never read | Most promising untested candidate |
| 12 | MutationObserver backup | `attributeFilter: ['video-id']` observer is a reliable backup | **Contradicted by its own timing data** — likely misses replaced elements | Observe `childList` too |

**Measured, despite looking like they might not be** (listed so nobody re-checks them unnecessarily): the `h1.ytd-watch-metadata yt-formatted-string` title selector; `ytd-shorts` absence on a watch page (`false`, both worlds, measured on the baseline watch page alongside the Shorts comparison).

> `link[rel=canonical]` freshness after an SPA transition **was removed from this list by Task 5.** It is now contested (see below), and leaving it here would tell downstream tasks not to re-check it — the opposite of what is wanted.

---

## Contested claims — two runs disagree

### `link[rel=canonical]` freshness after an SPA transition

| | Task 1 | Task 5 |
|---|---|---|
| Reading | flipped to the new id at t≈1387.6 ms | still the **old** id, twice |
| Transitions | `zjkBMFhNj_g` → `7xTGNNLPyMI` (same channel) | `zjkBMFhNj_g` → `qYNweeDHiyU`, and → `RQWpF2Gb-gU` (both cross-channel) |
| Evidence | one line from a 25 ms poller; the read expression was not preserved | a persisted DOM snapshot, `src/lib/__fixtures__/watch-spa-stale-head.html` line 22 |

**Timing does not reconcile them.** Task 1's own timeline has canonical flipping at t≈1387.6 ms — *before* `yt-page-data-updated` (1460.9) and *before* the flexy mutation (1474.8). So in that run canonical updated **earlier** than the rest of the DOM. Task 5's snapshot has `ytd-watch-flexy[video-id]`, `#title h1`, `#owner #channel-name a` and `.ytp-time-duration` all already fresh **while canonical was still stale** — which is impossible under Task 1's ordering. The runs disagree about ordering, not about sampling instant.

**Corroboration for the stale reading:** Task 1's own end-of-run dump records `og:url` as STALE. `og:url` and `link[rel=canonical]` are the same server-rendered pair; a client-side rewrite that touches one would normally touch both.

**Resolution:** treat canonical as full-load-only. This costs nothing, because the two higher-priority id sources were both measured fresh.

**Open questions, none investigated:**

- Was the Task 1 poller's read expression buggy (e.g. reading `.href` off a re-resolved base, or reading a different element)? It was not preserved, so this cannot be checked after the fact.
- Was a **second** `<link rel="canonical">` node appended rather than the first one mutated? `document.querySelector` returns the first match, so a poller that captured "a" canonical could see the new one while an extractor keeps reading the stale one. This would make **both** measurements correct and is the most economical explanation.
- Task 5's captured `ytd-watch-flexy` carries `view-transition-enabled=""`. Does that indicate a different navigation code path or A/B bucket than Task 1's run?

### Where the "stale `<head>` block" actually lives

Not a contested claim, but a correction that matters for Task 6's caption-signal hunt: this document repeatedly calls the stale microdata "the `<head>` block". `meta[itemprop="identifier"]`, `meta[itemprop="duration"]`, `meta[itemprop="name"]` and the `[itemprop="author"]` span are **not in `<head>`** — they are children of `div#watch7-content[itemtype="http://schema.org/VideoObject"]` in the **`<body>`**:

```
parentChain of meta[itemprop="identifier"]:
  ["META", "DIV#watch7-content[itemtype=http://schema.org/VideoObject]", "BODY"]
document.head.querySelector('meta[itemprop="identifier"]')  ->  null
```

The staleness behaviour this document describes is unchanged and was re-confirmed; only the location is different. The `og:*` and `meta[name=title]` tags *are* genuinely in `<head>`.

### `video.duration` on a live stream is finite, not `Infinity`

Recorded here because it is a natural assumption and it is wrong for YouTube. Measured on `https://www.youtube.com/@SkyNews/live` at `readyState: 4`:

```
duration: 4760   isInfinity: false   seekable.end(): 4760
clock: "1:19:20"   meta[itemprop=duration]: null   .ytp-live-badge display: inline-block
```

`video.duration` tracks `seekable.end()` — the DVR window — and grows. A second sample read `3600`. Any live handling that keys on `Infinity` will never fire.

Two signals that **do** discriminate, both plain attribute checks (no `getComputedStyle`, unlike the `.ytp-live-badge` visibility candidate this document ranks first):

| Signal | VOD | LIVE |
|---|---|---|
| `.ytp-time-display` class list | `ytp-time-display notranslate` | `ytp-time-display notranslate `**`ytp-live`** |
| `.ytp-live-badge` | `ytp-live-badge ytp-button` | `… `**`ytp-live-badge-is-livehead`**, plus a `disabled` attribute |
| fresh microdata block carrying no `meta[itemprop="duration"]` | has one | **absent** |

`ytp-live` was measured **clearing correctly across a live → VOD in-page navigation** (the direction that matters — a stale `ytp-live` would suppress a real VOD duration). The **VOD → live** direction is still untested: no live video appeared in any related rail sampled. Note also that `ytp-live` **drops while a pre-roll ad plays on a live stream**, so it must be combined with the ad check and the microdata signal.
