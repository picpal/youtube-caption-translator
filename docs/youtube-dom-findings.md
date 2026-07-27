# YouTube page contract — observed measurements

**Observation date:** 2026-07-27
**Chrome version:** `150.0.7871.184` (dev instance, profile `.chrome-dev-profile`, CDP port 9222)
**Fixture video:** `https://www.youtube.com/watch?v=zjkBMFhNj_g` — Andrej Karpathy, "[1hr Talk] Intro to Large Language Models"
**Page UI locale:** `document.documentElement.lang === "ko-KR"` — the dev profile renders YouTube in Korean. Every `aria-label` / tooltip value below is therefore **locale-dependent**.

## How world-reachability was determined

Every expression was evaluated **twice against the same page target in the same instant**:

1. In the page's **MAIN world** — CDP `Runtime.evaluate` against the target's default execution context.
2. In a real **ISOLATED world** — CDP `Page.createIsolatedWorld` (`grantUniveralAccess: false`) on the main frame, then `Runtime.evaluate` with that `contextId`. This is the same isolation mechanism a content script gets: it shares the DOM but has its own JS global.

The isolation was verified positively, not assumed:

```
### typeof window.ytInitialPlayerResponse
  MAIN:  "object"
  ISO :  "undefined"
### typeof window.ytcfg
  MAIN:  "object"
  ISO :  "undefined"
```

So anywhere this document says **ISOLATED-reachable**, it means the value was actually read from that isolated context, not inferred.

---

## The single most important fact: SPA transitions leave `<head>` and inline scripts STALE

Verified by clicking a related-video anchor on the fixture (`/watch?v=zjkBMFhNj_g` → `/watch?v=7xTGNNLPyMI`) and re-reading everything afterwards:

| Source | Updates on SPA transition? | Value after transition to `7xTGNNLPyMI` |
|---|---|---|
| `location.href` | ✅ yes | `https://www.youtube.com/watch?v=7xTGNNLPyMI` |
| `document.title` | ✅ yes | `Deep Dive into LLMs like ChatGPT - YouTube` |
| `link[rel=canonical]` | ✅ yes | `https://www.youtube.com/watch?v=7xTGNNLPyMI` |
| `ytd-watch-flexy[video-id]` | ✅ yes | `7xTGNNLPyMI` |
| DOM `#title h1` / `#owner #channel-name a` | ✅ yes | `Deep Dive into LLMs like ChatGPT` / `Andrej Karpathy` |
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
| 1 | `new URL(location.href).searchParams.get('v')` | `zjkBMFhNj_g` | **both** | ✅ |
| 2 | `document.querySelector('ytd-watch-flexy')?.getAttribute('video-id')` | `"zjkBMFhNj_g"` | **both** | ✅ |
| 3 | `document.querySelector('link[rel="canonical"]')?.href` | `https://www.youtube.com/watch?v=zjkBMFhNj_g` | **both** | ✅ |
| 4 | `window.ytInitialPlayerResponse.videoDetails.videoId` | `"zjkBMFhNj_g"` | MAIN only | ❌ stale |

**Recommended chain:** URL param → `ytd-watch-flexy[video-id]` → `link[rel=canonical]`.

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
| 1 | `document.querySelector('#owner #channel-name a')?.textContent?.trim()` | `"Andrej Karpathy"` | **both** | ✅ |
| 1b | `document.querySelector('#owner #channel-name a')?.getAttribute('href')` | `"/@AndrejKarpathy"` | **both** | ✅ |
| 1c | `document.querySelector('ytd-video-owner-renderer a.yt-simple-endpoint')?.getAttribute('href')` | `"/@AndrejKarpathy"` | **both** | ✅ |
| 2 | `document.querySelector('[itemprop="author"] [itemprop="name"]')?.getAttribute('content')` | `"Andrej Karpathy"` | **both** | ❌ stale after SPA |
| 3 | `ytInitialPlayerResponse.videoDetails.author` / `.channelId` | `"Andrej Karpathy"` / `"UCXUPKJO5MZQN11PqgIvyuvQ"` | MAIN only | ❌ stale after SPA |

There is **no ISOLATED-reachable source for the raw `channelId` (`UC…`) that survives an SPA transition.** The handle (`/@AndrejKarpathy`) is available; the `UC…` id is only in the MAIN-world player response / the stale `<head>`.

Channel avatar (bonus, both worlds, SPA-safe):
`document.querySelector('ytd-video-owner-renderer img')?.src` → `https://yt3.ggpht.com/ytc/AIdro_nDvyq2NoPL626bk1IbxQ94SfQsD-B0qgZchghtQNkLWoEz=s48-c-k-c0x00ffffff-no-rj`

### Duration

| Priority | Expression | Observed | World | SPA-safe | Notes |
|---|---|---|---|---|---|
| 1 | `document.querySelector('video')?.duration` | `3587.701` | **both** | ✅ | **Reads the AD's duration while a pre-roll is playing.** Measured `"0:30"` on a page whose real length is ~52 min. |
| 2 | `document.querySelector('.ytp-time-duration')?.textContent` | `"59:47"` | **both** | ✅ | Same ad caveat — observed `"1:13"` and `"0:30"` mid-ad. Also formats as `H:MM:SS`/`D:HH:MM:SS`. |
| 3 | `meta[itemprop="duration"]` (ISO-8601) | `"PT59M48S"` | **both** | ❌ stale after SPA | Correct and ad-immune on a full load. |
| 4 | `ytInitialPlayerResponse.videoDetails.lengthSeconds` | `"3588"` (string) | MAIN only | ❌ stale after SPA | |
| 5 | `#movie_player.getDuration()` | `3587.701` | MAIN only | ✅ | Same ad caveat as `video.duration`. |

**Duration is the least reliable field.** No source is simultaneously ISOLATED-reachable, SPA-safe, and ad-immune. See "What I could not determine".

### Thumbnail

| Priority | Expression | Observed | World | SPA-safe |
|---|---|---|---|---|
| 1 | Construct from video id: `https://i.ytimg.com/vi/<id>/hqdefault.jpg` (or `maxresdefault.jpg`) | — | **both** | ✅ |
| 2 | `meta[property="og:image"]` | `https://i.ytimg.com/vi/zjkBMFhNj_g/maxresdefault.jpg` | **both** | ❌ stale after SPA |
| 3 | `ytInitialPlayerResponse.videoDetails.thumbnail.thumbnails` | array of 5, `168×94` … `1920×1080` (`.../vi_webp/zjkBMFhNj_g/maxresdefault.webp`) | MAIN only | ❌ stale after SPA |

**Recommendation: construct the URL from the video id.** It is the only option that is both ISOLATED-reachable and SPA-safe, and `i.ytimg.com/vi/<id>/hqdefault.jpg` always exists (`maxresdefault.jpg` does not exist for every video).

Companion tags on a full load (both worlds): `og:image:width` = `1280`, `og:image:height` = `720`.

### `document.title` and `og:*` summary

`document.title` = `"[1hr Talk] Intro to Large Language Models - YouTube"` (title + literal `" - YouTube"` suffix). Present in both worlds and it **does** update on SPA transitions — but ~90 ms *after* `yt-navigate-finish` fires (see below).

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

The CC button always exists and is always visible (`display: block`, `offsetWidth: 48`) whether or not captions exist. Presence/visibility of the button is **not** a signal.

| Attribute | Fixture (asr only) | Manual+asr video | No captions | Discriminates? |
|---|---|---|---|---|
| `data-tooltip-title` | `"자막(c)"` | `"자막(c)"` | `"자막 사용 불가"` | ✅ **yes** (has/hasn't) |
| `aria-label` | `"자막 사용 불가"` | `"자막 사용 불가"` | `"자막 사용 불가"` | ❌ **no — identical in all three** |
| `aria-pressed` | `"true"` | `"true"` | `"false"` | ❌ reflects whether CC is currently *on*, i.e. user preference |
| `class` | `ytp-subtitles-button ytp-button` | same | same | ❌ no |
| `disabled` attribute | absent | absent | absent | ❌ no |
| `ytd-video-description-transcript-section-renderer` present | `true` | `true` | `false` | ✅ **yes** (has/hasn't), locale-independent |

**The `aria-label` trap is real**: on this Korean-locale profile `aria-label` reads `"자막 사용 불가"` ("subtitles unavailable") even on a video that *does* have captions. Do not use `aria-label`.

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

### Verdict for `CaptionAvailability = 'available' | 'auto-only' | 'none' | 'unknown'`

| Value | ISOLATED world alone | MAIN world |
|---|---|---|
| `'none'` | ✅ yes — `data-tooltip-title` and/or absence of the transcript section, SPA-safe | ✅ `'captions' in playerResponse === false` |
| has-some-captions | ✅ yes — same signals | ✅ |
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

- It is the only signal that fires on **both** a full load and an SPA transition.
- It is the only signal at which `ytd-watch-flexy[video-id]` and `document.title` are **already the new video's values** in every case observed.
- It is fully **ISOLATED-reachable**: the ISOLATED log recorded it at t=1459.8 vs the MAIN log's t=1460.9 — a ~1 ms difference, and the `detail` object was readable from the isolated world too (`detailKind: "object:pageType"`).

Belt-and-braces, if extra robustness is wanted:

- Add a `MutationObserver` on `ytd-page-manager` with `attributeFilter: ['video-id']`, `subtree: true`. It fired at t=1474.8 (MAIN) / t=1473.7 (ISO) with the correct new value, i.e. ~14 ms after `yt-page-data-updated`. Also ISOLATED-reachable, and locale/event-name independent.
- Guard with a "last seen video id" check so duplicate events are idempotent.

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
| `.ytp-time-duration` | `"1:13"` | `""` | `"137:04:51:37"` (DVR window) |
| `videoDetails.isLive` | absent | absent | **`true`** |
| `videoDetails.isLiveContent` | `false` | `false` | **`true`** |
| `videoDetails.lengthSeconds` | `"3588"` | `"71"` | **`"0"`** |
| `microformat…liveBroadcastDetails` | absent | absent | **`{"isLiveNow":true,"startTimestamp":"2024-12-10T12:07:17+00:00"}`** |
| `streamingData.hlsManifestUrl` | absent | absent | **present (string)** |

`.ytp-live-badge` **always exists in the DOM** — `!!document.querySelector('.ytp-live-badge')` returned `true` on the VOD, the Shorts page, and the live stream. Only its computed `display` / `offsetWidth` distinguishes. Likewise `#movie_player` carries the class `ytp-livebadge-color` on *all three* pages; it is a theming class, not a live marker.

**Recommended live detection:**
1. ISOLATED, SPA-safe: `getComputedStyle(document.querySelector('.ytp-live-badge')).display !== 'none'` (or `offsetWidth > 0`).
2. ISOLATED, full-load only: `meta[itemprop="duration"] === null` on an otherwise-valid watch page.
3. MAIN, always fresh: `#movie_player.getPlayerResponse().videoDetails.isLive === true`.

---

## What I could not determine

- **A duration source that is simultaneously ISOLATED-reachable, SPA-safe, and ad-immune.** `video.duration` and `.ytp-time-duration` report the *pre-roll ad's* length while an ad plays — measured `.ytp-time-duration === "0:30"` and `"1:13"` on pages whose real lengths are ~52 min and ~60 min. `meta[itemprop="duration"]` is ad-immune but stale after an SPA transition. I did not find or test a workaround (e.g. waiting for `#movie_player` to lose the `ad-showing` class, or reading `.ytp-progress-bar[aria-valuemax]`); Task 5/6 will need to solve this. I also did not verify how `.ytp-time-duration` formats videos over 24 h beyond seeing `"137:04:50:27"` on a live DVR window.
- **Whether `data-tooltip-title` / `aria-label` values differ under an English UI.** Everything here was observed with `document.documentElement.lang === "ko-KR"`. I did not switch the dev profile's locale, so I cannot state the English strings. The **presence/absence of `ytd-video-description-transcript-section-renderer`** is the locale-independent alternative — but I only observed it on three videos and did not test whether it is lazily rendered (it could be `false` transiently right after navigation, before the description section mounts).
- **Whether `ytd-video-description-transcript-section-renderer` is reliable on videos with manual-only captions and no ASR track.** Both captioned videos I tested happened to include an `asr` track.
- **A `/watch?v=` → SPA → `/shorts/` transition.** No `/shorts/` anchors existed in the fixture's related rail (`NO_SHORTS_LINK_ON_PAGE`); I measured home→shorts instead. The watch→shorts path may behave differently.
- **Whether a `chrome.runtime`-side signal (`chrome.tabs.onUpdated`, `webNavigation.onHistoryStateUpdated`) fires on these transitions and with what timing.** I measured the page-side CDP equivalent (`Page.navigatedWithinDocument`, twice, first with the old URL) but did not instrument the extension's background worker, because doing so would have required reloading the extension.
- **Whether `#movie_player.getPlayerResponse()` is ever transiently stale or absent right after `yt-page-data-updated`.** I observed it going to `"no-api"` at t=379.9 and back to the new id at t=1218.3, i.e. it was already fresh before `yt-page-data-updated` fired in that one run. One sample; I did not repeat it.
- **Live-stream caption behaviour.** The live stream I tested (`YDvsBbKfLPA`) had `captionTracks: []` and `data-tooltip-title: "자막 사용 불가"`. I did not find a live stream *with* live captions, so I cannot say what that shape looks like.
- **`playabilityStatus` values other than `"OK"` and `"ERROR"`.** `"ERROR"` was seen only on a bare `/shorts/` redirect, not on a genuinely unplayable video. Age-gated / members-only / region-blocked shapes were not measured.
- **How any of this behaves while signed out.** The dev profile has a signed-in session (a `accounts.google.com` sign-in iframe target is present); I did not test a logged-out page.
