# YouTube transcript-panel DOM contract — observed measurements

**Observation date:** 2026-07-28
**Chrome version:** `150.0.7871.187` (dev instance, CDP port 9222)
**Page UI locale:** `document.documentElement.lang === "ko-KR"` (same dev profile as the M1 findings). Every `aria-label` value below is **locale-dependent** — see the trap called out in [`docs/youtube-dom-findings.md`](./youtube-dom-findings.md).

**Why this document exists:** `youtube.com/api/timedtext` direct fetch is dead on this Chrome build — every `fmt` variant (`json3`/`srv3`/`srv1`/`vtt`/default xml) returns HTTP 200 with an **empty body**. This is an established finding from prior M2 task work, not re-measured in this task's own session — it was verified by fetching `track.baseUrl` (and each `&fmt=` variant) with `credentials:'include'` from the page's own MAIN world against the primary fixture (`scratchpad/probe-captions.mjs`, `probe-captions2.mjs`); every response was `status:200` with `len:0`. YouTube pot/PoToken-gates ASR timedtext and the `baseUrl` on this build carries no `pot=` param. I re-read those two scripts and their method before starting this task's own measurements, but did not re-run them. **This document does not use timedtext for anything** — every measurement below reads YouTube's own rendered transcript **engagement panel** (`ytd-transcript-segment-renderer` rows), the same DOM a human would read.

## Method

Chrome was driven via CDP (`http://127.0.0.1:9222`), one tab per video, using `Target.createTarget` (no page targets existed at task start) and `Runtime.evaluate` against the page's default (MAIN) execution context — no extension involved, no content-script world. In-page navigation for the SPA test used a real `element.click()` on a related-video anchor, not `Page.navigate`.

**A note on the shared browser instance:** partway through this task, tabs I had not closed disappeared from `/json/list` and one tab was redirected into a Google account sign-in / security-challenge flow (`accounts.google.com/v3/signin/...`, then `gds.google.com/web/recoveryoptions`, `.../homeaddress`) that I did not initiate. I did not interact with that flow. This is recorded as an operational risk in the task report, not as a page-DOM fact — none of the measurements below were taken from that affected tab; each was re-verified on a fresh tab afterward where noted.

## The three fixtures

| Role | videoId | Title | Duration | How verified |
|---|---|---|---|---|
| Primary (ASR-only, reused from M1/M2 task briefs) | `zjkBMFhNj_g` | "[1hr Talk] Intro to Large Language Models" (Andrej Karpathy) | `lengthSeconds: "3588"` (**59:48 — under 1 hour**, see the format note below) | `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks` = one track, `kind:"asr"` |
| Aux — manual caption, short | `MB5IX-np5fE` | "This could be why you're depressed or anxious \| Johann Hari \| TED" | `lengthSeconds: "1232"` (20:32) | `captionTracks`: 35 tracks total, 34 with **no `kind` property** (manual) including `languageCode:"en"`; 1 with `kind:"asr"`. Selected by hand — TED talks ship professional human-translated/transcribed captions in dozens of languages, a reliable source of a genuine manual track. |
| Aux — no transcript | `I_6ZcOo6pnk` | "[ 8K resolution ] - 10 Hours Black Screen - No Sound" | `lengthSeconds: "36000"` | `'captions' in ytInitialPlayerResponse === false`; no Show-transcript button found; no `ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]`; no `ytd-video-description-transcript-section-renderer`. All four signals absent simultaneously (see full stdout below). Reused from the M1 doc's own no-caption fixture, independently re-verified in this task. |
| Extra — long-form, for the `h:mm:ss` format check | `kCc8FmEb1nY` | "Let's build GPT: from scratch, in code, spelled out." (Andrej Karpathy) | `lengthSeconds: "6980"` (1:56:20) | Picked because the primary fixture turned out to be under an hour (see below) and the brief requires measuring the `h:mm:ss` format, not just `m:ss`. |

**Correction of an assumption going in:** the task brief describes the primary fixture as "~1h" and expects `h:mm:ss` timestamps on it. Measured: `zjkBMFhNj_g` is `PT59M48S` / `lengthSeconds:"3588"` — under one hour — and its transcript panel's last row timestamp is `59:45`, never crossing into `h:mm:ss`. The `h:mm:ss` format was measured instead on the extra long-form fixture `kCc8FmEb1nY`.

---

## 1. Show-transcript trigger

| Element | Selector / value | Measured |
|---|---|---|
| Show-transcript button | `<button>` with `aria-label="스크립트"` (Korean for "script/transcript"), found via `document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape button')` filtered by `/transcript\|스크립트\|대본/i` against `aria-label` + `textContent` | `class="ytChipShapeButtonReset"`, `role="tab"`, `aria-selected="false"` before click. This is a **chip/tab button in the expanded description area**, not a CC/subtitles button. |
| Engagement panel (force-visible fallback) | `document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]')`, then `panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED')` | Present (`true`) before any click, with `visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"`. Clicking the chip button flips it to `visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"` — the before/after attribute values were directly captured **on the primary fixture only** (stdout below). On the manual-caption and long-form fixtures, the click was followed by successfully reading real, correct transcript rows within the same ~2-3s window that worked on the primary fixture — which requires the panel to have actually expanded and mounted — but I did not separately capture/paste the `visibility` attribute's post-click value for those two fixtures. Treat those two as "row-read implies it worked," not as a directly-captured attribute toggle. On the manual-caption fixture, that first post-click read returned **926** raw rows — the **Korean** track this profile's `ko-KR` locale selects by default, captured *before* I switched the panel to English via its language dropdown (see §8). §4b and §8's **938** figure is a separate, later capture of the **English** track, taken *after* that switch. These are two genuinely different captures of two different caption tracks on the same video, not a contradiction and not a typo — different tracks segment the same audio into a different number of rows, which is unsurprising and unrelated to the "no incremental loading" finding in §4a (that finding is about a single track's row count being stable over time, not about two different tracks agreeing with each other). On the long-form fixture, that same first post-click read returned **2212** raw rows, matching §3's figure. |

Raw stdout, primary fixture, first open:
```
trigger: {"methods":["clicked-show-transcript"],"showTranscriptButtonAriaLabel":"스크립트","showTranscriptButtonTagName":"BUTTON","showTranscriptButtonClass":"ytChipShapeButtonReset","transcriptEngagementPanelPresent":true,"panelVisibilityAttrBefore":"ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"}
```
2 seconds later:
```
t0 (2s after trigger): {"href":"https://www.youtube.com/watch?v=zjkBMFhNj_g","panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_EXPANDED","rowCountAtT0_2s":1162}
```

**Recommended trigger method for the scraper:** click the chip button (`aria-label` match is locale-dependent — see the M1 doc's locale trap; a more robust match may need a non-text signal, unmeasured here). Forcing the `visibility` attribute directly also works to *open* the panel on a fresh load, but see §4 for why forcing it manually after an SPA transition produced inconsistent results.

---

## 2. Row selectors

The full tag + class-string dump below was captured **on the primary fixture only**. On the manual-caption fixture (§8) and the long-form fixture (§3), I did not re-run the same tag/class dump — but the samples pasted in those sections were extracted using these exact same selectors (`.segment-timestamp`, `.segment-text`), and both returned real, correct, non-empty text. That is indirect but genuine evidence the same class names are present there too (a class-name mismatch would have produced empty strings, not correct captions) — it is not the same as a directly-captured tag/class dump for those two fixtures, so it is reported separately here rather than folded into a "confirmed identical across all three" claim.

| Element | Tag | Class |
|---|---|---|
| Row | `YTD-TRANSCRIPT-SEGMENT-RENDERER` | (custom element, no relevant class) |
| Timestamp | `DIV` | `segment-timestamp style-scope ytd-transcript-segment-renderer` |
| Text | `YT-FORMATTED-STRING` | `segment-text style-scope ytd-transcript-segment-renderer` |

Raw sample, primary fixture, first 3 rows:
```
{"tag":"YTD-TRANSCRIPT-SEGMENT-RENDERER","tsClass":"segment-timestamp style-scope ytd-transcript-segment-renderer","tsTag":"DIV","t":"0:00","textClass":"segment-text style-scope ytd-transcript-segment-renderer","textTag":"YT-FORMATTED-STRING","text":"hi everyone so recently I gave a 30-minute talk on large language models just kind of like an intro talk um"}
{"tag":"YTD-TRANSCRIPT-SEGMENT-RENDERER","tsClass":"segment-timestamp style-scope ytd-transcript-segment-renderer","tsTag":"DIV","t":"0:06","textClass":"segment-text style-scope ytd-transcript-segment-renderer","textTag":"YT-FORMATTED-STRING","text":"unfortunately that talk was not recorded but a lot of people came to me after the talk and they told me that uh they"}
{"tag":"YTD-TRANSCRIPT-SEGMENT-RENDERER","tsClass":"segment-timestamp style-scope ytd-transcript-segment-renderer","tsTag":"DIV","t":"0:11","textClass":"segment-text style-scope ytd-transcript-segment-renderer","textTag":"YT-FORMATTED-STRING","text":"really liked the talk so I would just I thought I would just re-record it and basically put it up on YouTube so here"}
```

Selector recommendation for the scraper: `row.querySelector('.segment-timestamp')?.textContent?.trim()` and `row.querySelector('.segment-text')?.textContent?.trim()` — both measured stable across ASR and manual tracks. `yt-formatted-string.segment-text` also works as a more specific fallback (used in the reference probe).

---

## 3. Timestamp format

| Format | Fixture | Evidence |
|---|---|---|
| `m:ss` | Primary (`zjkBMFhNj_g`, 59:48 total) | First row `"0:00"`, last row `"59:45"`. Never crosses into `h:mm:ss` because the video itself is under an hour. |
| `m:ss` | Manual-caption fixture (`MB5IX-np5fE`, 20:32 total) | First row `"0:13"`, last row `"20:24"`. |
| `h:mm:ss` | Long-form fixture (`kCc8FmEb1nY`, 1:56:20 total) | Confirmed transition point: row index 566 = `"59:57"`, row index 567 = `"1:00:11"`, last row (index 2211 of the raw duplicated list, i.e. the true last row) = `"1:56:15"`. |

Raw stdout for the transition:
```
{"totalRowCount":2212,"first":{"t":"0:00","text":"hi everyone so by now you have probably heard of c"},"last":{"t":"1:56:15","text":"uh and uh yeah go forth and transform see you late"},"firstHmmssIdx":567,"firstHmmssRow":{"t":"1:00:11","text":"run so we see that this runs and uh this currently"},"rowBeforeHmmss":{"t":"59:57","text":"C and then this just creates one spous layer of in"}}
```

**Parse rule (measured, not merely inferred):** split the timestamp string on `:`. 2 parts → `m:ss` (`Number(parts[0])*60 + Number(parts[1])`). 3 parts → `h:mm:ss` (`Number(parts[0])*3600 + Number(parts[1])*60 + Number(parts[2])`). No leading zero on the leftmost unit in either case (`"0:00"`, `"1:00:11"` — not `"01:00:11"`). Values over 24h were not measured on a transcript panel in this task (the M1 doc measured a `.ytp-time-duration` live-DVR value going to `D:HH:MM:SS`, but that is a different element).

---

## 4. Virtualization — measured answer: NOT lazy-loaded, but the panel mounts TWO complete duplicate copies

This is the most consequential finding for the scraper's full-collection method, and it is **not** what the task brief assumed ("virtualization requiring scroll"). The actual mechanism is different and, for a scraper, more important to get right.

### 4a. All rows are in the DOM immediately, no scroll needed

On the primary fixture, immediately after the panel finished expanding:
```
t0 (2s after trigger): {"href":"...","panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_EXPANDED","rowCountAtT0_2s":1162}
```
3 more seconds, no scroll:
```
t1 (5s total after trigger, no scroll): {"rowCountAtT_5s_total":1162}
```
Explicit scroll-to-bottom of the scrollable container, then re-check:
```
scrollResult (immediate): {"before":1162,"beforeScrollTop":349,"beforeScrollHeight":32088,"afterSetScrollTop":31827}
afterScroll (1.5s later): {"rowCountAfterScroll":1162,"scrollTop":31827,"scrollHeight":32088,"lastRows":[...,{"t":"59:45","text":"...keep track of bye"}]}
```
Row count never changed (1162 → 1162 → 1162) across a 5-second no-scroll window and an explicit scroll to the bottom. **No incremental/lazy rendering on scroll was observed.** The scrollable container is `ytd-transcript-segment-list-renderer` (measured `scrollHeight: 32106` vs `clientHeight: 261` on the primary fixture) — it is a plain CSS-overflow scroll box holding fully-rendered content, not a virtual/recycled list.

### 4b. But "1162" is a lie: the panel mounts the transcript TWICE

Investigating why row index 700 had an *earlier* timestamp (`12:22`) than row index 300 (`30:46`) — itself only discoverable because I checked, not because I expected it — found this:

```
{"segmentListRendererCount":2,
 "listsInfo":[{"className":"style-scope ytd-transcript-search-panel-renderer","childRowCount":581},
              {"className":"style-scope ytd-transcript-search-panel-renderer","childRowCount":581}],
 "nonMonotonicCount":1,"firstBreakIdx":581,
 "firstBreakContext":{"before":{"t":"59:45","text":"keep track of bye"},"at":{"t":"0:00","text":"hi everyone so recently I gave a 30-minu"}}}
```

There are **two separate `ytd-transcript-segment-list-renderer` DOM nodes**, each holding 581 rows (`581 × 2 = 1162`, exactly the observed total). Confirmed as genuinely separate elements (not the same node queried twice) and byte-identical in content:

```
{"searchPanelCount":2,"searchPanelSameNode":false,
 "segListSameNode":false,"rowsA_len":581,"rowsB_len":581,
 "identicalCount":581,"diffCount":0,"firstDiffIdx":-1,
 "listA_hidden_attr":false,"listB_hidden_attr":false}
```

Neither copy carries a `hidden` attribute. They are distinguished only by layout — one has a real bounding box, the other is collapsed to nothing:
```
idx0 rect: {"top":608,"left":17,"width":638,"height":261,"display":"block","visibility":"visible"}
idx1 rect: {"top":0,"left":0,"width":0,"height":0,"display":"block","visibility":"visible"}
```

**Root cause: not investigated further** (out of scope for this task — would require reading YouTube's compiled Polymer source). The transcript panel's UI includes a search box, and this looks like two parallel render templates (e.g. "browse" vs "search-results") both getting fully populated, with only one laid out. This is inference, not measurement — flagged as such.

**Same pattern confirmed on the manual-caption fixture** (`MB5IX-np5fE`, English track): `segListRendererCount: 2`, `totalRowCount: 938` (469 unique × 2). And on the long-form fixture: `totalRowCount: 2212` (1106 unique × 2, consistent with the pattern though not independently content-diffed there).

### 4c. Full-collection method for the scraper

1. **No scroll loop is needed.** All rows exist in the DOM the moment the panel finishes expanding (measured stable at 2s, 5s, and after an explicit scroll). This directly contradicts the brief's premise; do not build a scroll-and-wait collection loop, it would do nothing useful and would cost time.
2. **Do dedupe, or scope to one list.** `document.querySelectorAll('ytd-transcript-segment-renderer')` (unscoped) returns every row twice. Two options, both consistent with the data above:
   - Scope to a single container: `document.querySelector('ytd-transcript-segment-list-renderer')` (singular — picks the first match, which was the visible one in the one case checked, on the primary fixture; **this was checked once, not verified across repeated open/close cycles or the other fixtures** — see the inference table at the end of this document) `.querySelectorAll('ytd-transcript-segment-renderer')`.
   - Or collect from all matching containers and de-duplicate by `(timestamp, text)` pair, keeping first-seen order. **This is the recommended approach** — it does not depend on which of the two copies happens to be first in document order or visible, which was not verified to be invariant across repeated opens/closes of the panel.
3. Wait for `rows.length > 0` after triggering (a fixed 2-3s delay was sufficient on a **first, fresh** panel open in every run of this task; see §6 for why a **post-SPA-transition** reopen is a materially different, less reliable case).

---

## 5. Panel-absent signal (no-transcript video)

Full stdout, `I_6ZcOo6pnk`:
```
probe: {"videoId":"I_6ZcOo6pnk","title":"[ 8K resolution ] - 10 Hours Black Screen - No Sound","lengthSeconds":"36000","hasCaptionsKey":false,"showTranscriptButtonFound":false,"showTranscriptButtonAriaLabel":null,"transcriptEngagementPanelPresent":false,"transcriptSectionRendererPresent":false}
attemptClick: {"attempted":false}
afterAttempt: {"rowCount":0,"panelPresent":false}
```

Four independent signals, all absent together:
1. `'captions' in window.ytInitialPlayerResponse` → `false` (matches the M1 doc's finding — the key is entirely absent, not an empty object).
2. No element matches the Show-transcript button heuristic (`/transcript|스크립트|대본/i` against any button's `aria-label`/text).
3. `document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]')` → `null`.
4. `document.querySelector('ytd-video-description-transcript-section-renderer')` → `null` (the same locale-independent signal the M1 doc recommends for caption-availability detection).

**Recommended scraper check:** signal 3 or 4 alone is sufficient and locale-independent; signal 2 is a convenient double-check but locale-dependent (see the M1 doc's `aria-label` trap — everything here was observed under `ko-KR`).

---

## 6. SPA navigation: the transcript panel DOES go stale, and reopening it was not reliably observed to work

This required a clean baseline: panel fully opened and settled (1162 DOM rows / 581 unique, `EXPANDED`) on the primary fixture, then a real in-page click on a related-video anchor found in `#secondary` / `#related` (note: `ytd-compact-video-renderer a#thumbnail`, the selector used in the M1 doc, matched **zero** elements on this build — the related rail now renders as `yt-lockup-view-model`; a generic `a[href*="/watch?v="]` scoped to `#secondary` was used instead).

### 6a. Immediately after the SPA transition: stale content survives under a hidden panel

```
BEFORE nav: {"href":"...zjkBMFhNj_g","panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_EXPANDED","rowCount":1162}
clickResult: {"clicked":true,"href":"https://www.youtube.com/watch?v=5sLYAQS9sWQ"}
AFTER nav (3.5s later): {"href":"...5sLYAQS9sWQ","flexyVideoId":"5sLYAQS9sWQ","panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_HIDDEN","panelPresent":true,"rowCount":581,"firstRow":{"t":"0:00","text":"hi everyone so recently I gave a 30-minute talk on"}}
```

Three separate facts here, all measured in the same read:
- `location.href` and `ytd-watch-flexy[video-id]` **did** update to the new video (`5sLYAQS9sWQ`) — consistent with the M1 doc's finding that these are SPA-safe.
- The transcript panel's `visibility` attribute reverted to `HIDDEN` on its own — YouTube does not keep the panel open across a video change.
- **The row content is stale**: `rowCount` dropped from `1162` to `581` (one of the two duplicate copies was torn down, one survived) and `firstRow.text` is still the **old** video's first line ("hi everyone so recently I gave a 30-minute talk on..." — that is `zjkBMFhNj_g`'s opening line, not `5sLYAQS9sWQ`'s). **A scraper that reads rows without checking panel visibility and video-id agreement first would silently return the previous video's transcript.**

### 6b. Reopening after the SPA transition: inconsistent in this task's testing — treat as unresolved, not as working

A second, independently-clean run (fresh tab, first panel-open only 2.5s old and not yet fully populated when the related-video click fired) showed the panel torn down more thoroughly:
```
stateB (right after SPA nav, before reopen): {"href":"...OYvlznJ4IZQ","rowCount":0,"panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_HIDDEN","transcriptRendererPresent":false}
```
That run's reopen attempt was interrupted by the account-security-challenge redirect described under "Method" above, so it produced no usable reopen data.

On the **first** run (§6a's tab), clicking the Show-transcript chip again after the transition did flip `visibility` back to `EXPANDED`, but rows did not populate:
```
AFTER reopen (2.5s later): {"href":"...5sLYAQS9sWQ","title":"How Large Language Models Work - YouTube","panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_EXPANDED","rowCount":0,...}
```
Polled for 6 more seconds (1.5s steps), still 0 rows, and the panel's actual content had been replaced by YouTube's own lazy-load placeholder rather than the real transcript renderer:
```
t+0ms .. t+7500ms: {"rowCount":0,"panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_EXPANDED", ...} (all six polls identical)
inspect: {"panelPresent":true,"panelVisibility":"ENGAGEMENT_PANEL_VISIBILITY_EXPANDED","panelInnerHTMLLen":11351,
  "contentInnerHTMLHead":"<ytd-continuation-item-renderer ... id=\"ghost-cards\" ...>",
  "transcriptRendererPresent":false}
```
I then tried, in order: forcing the `visibility` attribute off and back on directly, re-clicking the same chip button a second time (found already `aria-selected="true"`, i.e. a no-op toggle), and closing the panel via its own `닫기` (close) button before re-clicking Show-transcript. None of these reliably remounted `ytd-transcript-renderer` with real rows within the windows tested (up to ~8s per attempt). The confirmed independent video `5sLYAQS9sWQ` ("How Large Language Models Work") does have captions (`en-US`, verified via `#movie_player.getPlayerResponse()`), so this was not a caption-availability issue.

**What I cannot rule out:** whether my own repeated manual attribute-forcing desynced YouTube's internal Polymer state from the DOM attribute (plausible — the close-button + reopen sequence produced `visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"` immediately after a click that should have opened it, the opposite of the expected toggle), versus whether a plain, single, un-interfered-with re-click would reliably load fresh rows given enough time. This was not resolved.

**Recommendation for Task 4/the scraper (stated as an open risk, not a solved one):**
1. Before trusting any row content, compare the currently-scraped video-id (e.g. `ytd-watch-flexy[video-id]`) against the video-id the transcript was last read for. On mismatch, treat existing rows as stale and re-trigger.
2. Do **not** assume a single click-and-wait after a video change will populate rows on the timeline that works for a fresh full load (2-3s). Poll with a longer timeout and a real "did it work" check (`document.querySelector('ytd-transcript-renderer')` present, not just the outer panel's `visibility` attribute) before giving up.
3. If manually toggling the `visibility` attribute is used as a fallback, this task's evidence suggests it is not obviously safer than the click — both were tried post-SPA and neither reliably produced rows in the windows tested.
4. This entire area needs a cleaner, uninterrupted re-test (see "What I could not determine").

---

## 7. ASR "rolling duplication" — measured answer: it does not exist in this DOM, at least on this fixture

The task brief expected consecutive ASR rows to show an overlap/rolling-duplication pattern (typical of raw `srv3`/`json3` timedtext cue streams, where each event repeats trailing words of the previous event). This was checked exhaustively, not sampled:

```
overlapCheck: {"uniqueRowCount":581,"overlapWordCountHistogram":{"0":580},"maxOverlap":0,"maxOverlapIdx":-1,"maxOverlapContext":null}
```

All 580 consecutive-row pairs in the primary fixture's (de-duplicated, single-list) transcript were checked for the longest word-level suffix-of-row-N == prefix-of-row-N+1 match. **Every single pair had zero overlapping words.** Representative consecutive rows (rows 0-7, verbatim):

```
0:00  hi everyone so recently I gave a 30-minute talk on large language models just kind of like an intro talk um
0:06  unfortunately that talk was not recorded but a lot of people came to me after the talk and they told me that uh they
0:11  really liked the talk so I would just I thought I would just re-record it and basically put it up on YouTube so here
0:16  we go the busy person's intro to large language models director Scott okay so let's begin first of all what is a large
0:24  language model really well a large language model is just two files right um there will be two files in this
0:31  hypothetical directory so for example working with a specific example of the Llama 270b model this is a large
0:38  language model released by meta Ai and this is basically the Llama series of language models the second iteration of
0:45  it and this is the 70 billion parameter model of uh of this series so there's
```

Reading across the boundaries: row 0 ends "...um", row 1 begins "unfortunately..." — no shared words. Row 3 ends "...what is a large" and row 4 begins "language model really well a large language model..." — "large" reappears, but as a new word in a new sentence, not as a repeated overlap window (confirmed: the automated scan found 0-word overlap for this exact pair too).

**Conclusion, stated plainly:** YouTube's rendered transcript **panel** already presents clean, continuous, non-overlapping segments — it is not the raw caption-cue stream. The "rolling duplication" behavior the brief describes is a property of the raw `srv3`/`json3` timedtext format (which this project cannot use anyway, per the pot-gating finding above), not of the DOM this scraper reads. **The sentence-reconstruction step does not need to handle rolling duplication** for panel-sourced text; it only needs to join segments (see §8 for a caveat about mid-sentence line breaks in the *manual*-caption case).

This contradicts an assumption in the task brief and is called out explicitly so it is not silently "fixed" by a downstream task assuming duplication exists.

---

## 8. Manual vs ASR structural differences

Both measured from a live English track (the manual fixture defaults to a Korean human-translated track under this profile's `ko-KR` locale — switching it required using the transcript panel's own language dropdown, see below).

| Property | ASR (primary, `zjkBMFhNj_g`) | Manual (`MB5IX-np5fE`, English track) |
|---|---|---|
| Unique row count | 581 | 469 |
| Video duration | 3588s (59:48) | 1232s (20:32) |
| Rows per second of video *(derived — divided from the stated row-count and duration values, not directly measured)* | ≈ 1 / 6.2s | ≈ 1 / 2.6s (roughly 2.4× denser) |
| Timestamp spacing | Fairly regular, ~5-7s | Irregular, follows natural speech pauses (`0:13, 0:14, 0:18, 0:20, 0:24, 0:27, 0:30, 0:34` — first 8 rows) |
| Punctuation | **None observed** — no periods, commas, or capitalization (`"hi everyone so recently i gave a 30-minute talk on..."`, sic) | Full punctuation and capitalization (`"For a really long time,"`, `"I didn't understand them"`) |
| Line breaks inside `.segment-text` | Not observed | **Present** — `textContent` includes literal `\n` inside a single row, e.g. `"I had two mysteries\nthat were hanging over me."` (one row, two caption lines) |
| Duplicate-list-of-2 pattern (§4b) | Present (1162 raw / 581 unique) | Present (938 raw / 469 unique) — same mechanism, not ASR-specific |

Raw sample, manual fixture, English track, first 8 rows:
```
{"t":"0:13","text":"For a really long time,"}
{"t":"0:14","text":"I had two mysteries\nthat were hanging over me."}
{"t":"0:18","text":"I didn't understand them"}
{"t":"0:20","text":"and, to be honest, I was quite afraid\nto look into them."}
{"t":"0:24","text":"The first mystery was, I'm 40 years old,"}
{"t":"0:27","text":"and all throughout my lifetime,\nyear after year,"}
{"t":"0:30","text":"serious depression and anxiety have risen,"}
{"t":"0:34","text":"in the United States, in Britain,"}
```

**Trap worth recording:** this video's default caption track under the `ko-KR` profile was **Korean** (a different, non-English manual track: `"번역: Ohjun Kwon\n검토: Jihyeon J. Kim"` — translator/reviewer credits, a TED convention for community-translated tracks), not English. Getting the English track required opening the transcript panel's own language dropdown (`tp-yt-paper-button.dropdown-trigger` inside the panel, labeled with the current language name) and clicking the `"영어"` (English) entry in the `tp-yt-paper-listbox.dropdown-content` that appears. **A scraper cannot assume the transcript panel defaults to the language of the video's original audio/captions** — it defaults to something locale/preference-driven. If the target language is fixed (e.g. always English for translation-source purposes), the scraper needs this language-switch step, not just a panel-open step.

---

## What I could not determine

- **Root cause of the duplicate-list-of-2 mounting (§4b).** Confirmed as real and consistent (2 fixtures, byte-identical content, distinguished only by layout), but *why* YouTube mounts two full copies was not investigated — would require reading compiled Polymer source, out of scope here.
- **Whether the visible copy is reliably first in document order.** Checked once (§4c, §4b) — see row 2 of the inference table below for the full statement.
- **Whether reopening the transcript panel after an SPA transition reliably works at all (§6b).** This is the most important open question for Task 4/the scraper and it is explicitly unresolved. One run got stuck in a `ghost-cards` loading placeholder for 8+ seconds across multiple re-trigger strategies; a second run's data was lost to the account-challenge interference described under "Method." Needs a clean, patient, single-variable re-test — ideally with a longer poll window (30s+) and only one re-trigger strategy per attempt, not several in sequence (which may have desynced state, see the discussion in §6b).
- **Whether the account-security-challenge redirect was caused by this task's own automation pattern** (many rapid CDP `Runtime.evaluate` calls / clicks in a short window resembling bot activity) or by a concurrent process using the same shared Chrome instance (tabs I had not closed disappeared from `/json/list` on their own). Both are plausible; not distinguished. Recorded as a risk for any future task doing rapid CDP-driven interaction against this signed-in profile.
- **Whether the `h:mm:ss` parse rule holds beyond 24 hours**, or whether YouTube ever emits a leading-zero form (`"01:00:11"`). Only the single measured transition (`59:57` → `1:00:11`) and the fixture's max (`1:56:15`) were observed.
- **Chapters interaction with the transcript panel.** The primary fixture had a `"챕터"` (Chapters) tab button that did not reproduce on a later attempt (§6b's tab-toggle test found `chaptersBtn: false`) — whether that reflects the video not having chapters, or a state timing issue, was not resolved. Not relevant to the row-scraping contract itself, so not chased further.
- **Live-video and Shorts transcript panels.** Not tested in this task — out of scope per the brief (3 specific VOD fixtures only).

---

## Claims that rest on inference — re-verify before relying on these

Everything quoted as stdout in this document is a real value read from a real CDP session in this task; no value was invented. But not every *claim built on top of that stdout* is itself a direct measurement — some are single-sample checks, some are indirect (a successful read implies a precondition held), and one is an open contradiction. Mirroring the M1 doc's convention, they're consolidated here so a reader doesn't have to hunt through the prose above to find them.

| # | Where | Claim | Evidence grade | What to do |
|---|---|---|---|---|
| 1 | §4b | The duplicate `ytd-transcript-search-panel-renderer` mount is two parallel render templates (e.g. "browse" vs "search-results") | **Inference.** The duplication itself is measured (byte-identical content, one collapsed to `0×0`); the *reason* for it is not — would require reading YouTube's compiled Polymer source | Treat the root cause as unknown; do not build logic that assumes this specific explanation |
| 2 | §4c option 1, §4b | `document.querySelector('ytd-transcript-segment-list-renderer')` (first match) reliably returns the visible, non-stale copy | **Checked once**, on the primary fixture only. Not verified across repeated open/close cycles or across the other two fixtures | Prefer §4c option 2 (de-dup by `(timestamp, text)` across all matching containers) for the scraper — it doesn't depend on this holding |
| 3 | §1 | Clicking the Show-transcript chip flips the panel's `visibility` attribute to `EXPANDED` on the manual-caption and long-form fixtures, not just the primary one | **Indirect.** Directly captured (before/after attribute values) on the primary fixture only. On the other two, inferred from the fact that real transcript rows were successfully read shortly after the click — which requires the panel to have expanded, but the attribute value itself was not captured for those two | Treat as strong circumstantial evidence, not a direct capture; if this matters for a downstream task, re-verify by capturing the attribute directly |
| 4 | §2 | The `.segment-timestamp`/`.segment-text` row selectors have identical tag/class names on the manual-caption and long-form fixtures, not just the primary one | **Indirect.** Full tag+class dump captured on the primary fixture only. On the other two, the same selectors were used to pull real, non-empty, correct-looking text — which a class-name mismatch could not have produced — but no raw tag/class dump was captured for them | Treat as strong circumstantial evidence, not a direct capture |
| 5 | §6b | Reopening the transcript panel after an SPA transition (via re-click, force-attribute toggle, or close+reopen) reliably repopulates rows for the new video | **Unresolved — contradictory/incomplete evidence.** One clean, uninterrupted run failed to repopulate rows over 8+ seconds across four different retrigger strategies tried in sequence (which may itself have desynced state — see §6b); a second independent run's outcome was lost to the account-challenge interference described under "Method" | **Do not assume this works.** Needs a clean, patient, single-variable re-test (one retrigger strategy per attempt, 30s+ poll window) before Task 4/the scraper relies on a simple re-click-and-wait after a video change |
| 6 | §3 | The `m:ss`/`h:mm:ss` timestamp parse rule (split on `:`, no leading zero on the leftmost unit) generalizes beyond 24 hours and never emits a leading-zero form | **Untested.** Only one transition point (`"59:57"` → `"1:00:11"`) and one maximum value (`"1:56:15"`) were observed; no video near or beyond 24h, and no video whose format might include a leading zero, was tested | Low risk given this project's likely video lengths; revisit only if a very-long-form fixture is ever needed |
| 7 | §6b | The `"챕터"` (Chapters) tab button's disappearance between the primary fixture's first open and a later attempt on the same tab reflects something meaningful about the video | **Single observation each way** (present once, absent once), not resolved whether the video genuinely lacks chapters or this was a mount-timing artifact | Not relevant to the row-scraping contract; not chased further |
| 8 | Method | The account-security-challenge redirect (`accounts.google.com/v3/signin/...` → `gds.google.com/web/recoveryoptions`/`.../homeaddress`) was triggered by this task's own rapid CDP automation resembling bot activity, rather than by a concurrent process sharing the same Chrome instance | **Not distinguished.** Both explanations are plausible (tabs I had not closed did disappear from `/json/list` on their own, which is consistent with a concurrent actor); no diagnostic was run to tell them apart | Flag as an operational risk for any future task doing rapid CDP-driven interaction against this signed-in profile, regardless of which cause is correct |
