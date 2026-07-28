// Fix round (2026-07-29 task-brief.md, "transcript 열기 로직 SPA-상태 견고화") —
// pure, unit-testable counterpart to `entrypoints/content.ts`'s
// `findShowTranscriptButton`. Extracted for the same reason
// `transcript-parse.ts`'s functions are: content.ts talks to the DOM/Chrome
// and cannot be unit-tested directly (no `content.test.ts` exists in this
// repo, and none should — see that file's own doc comment), so the DECISION
// logic (which of several matched buttons is safe to click, if any) lives
// here as a dependency-free function over plain data, and content.ts's own
// `findShowTranscriptButton` is just the DOM adapter that builds this
// module's input and maps its output index back to a real element.
//
// Why this needed hardening at all (the live bug this fixes): on
// https://www.youtube.com/watch?v=t3YJ5hKiMQ0, `findShowTranscriptButton`'s
// old regex-only match (`/transcript|스크립트|대본/i` against any
// button-like element) found 4 matching elements, ALL invisible (description
// panel collapsed), and the FIRST one was the Show-transcript chip left in
// `aria-selected="true"` state by a prior SPA navigation. `.click()`-ing an
// already-selected tab is a toggle-OFF, a no-op for opening the panel — the
// content script then burned its whole 30s poll budget waiting for rows that
// were never coming, and reported `{unavailable:true}` even though the video
// genuinely has an `en` transcript (measured: 550 rows once the panel is
// actually opened). A second latent bug in the same regex: it also matches
// the panel's OWN `aria-label="스크립트 닫기"` (close) button, so a
// panel that is already open could get closed by the "wrong" first match.

/**
 * One button-like element that matched the general transcript-keyword
 * pattern (`/transcript|스크립트|대본/i`), reduced to exactly the facts
 * `chooseTranscriptButton` needs. `visible` is computed by the DOM adapter
 * from `getBoundingClientRect` (width/height > 0) — this module never
 * touches the DOM itself, so it takes the already-computed boolean instead
 * of an element.
 */
export interface TranscriptButtonCandidate {
  label: string;
  visible: boolean;
  ariaSelected: boolean;
}

// Close/hide buttons live in the SAME `/transcript|스크립트|대본/i` match set
// as the actual show-transcript chip (the panel's own close button is
// labeled "스크립트 닫기" / "Close transcript" etc.) — this pattern excludes
// them outright, regardless of visibility or rank, so a click can never
// close an already-open panel.
const CLOSE_LABEL_RE = /닫기|close|hide|숨기/i;

// Labels that explicitly say "show" rank above a bare keyword match — of the
// remaining (non-close) candidates, this is the strongest positive signal
// that a given element opens (rather than merely mentions) the transcript.
const SHOW_LABEL_RE = /표시|show/i;

/**
 * Picks the safest candidate to `.click()` to open the transcript panel, or
 * `null` if every candidate is disqualified. Returns an INDEX into
 * `candidates` (not an element) — this function is pure and never sees the
 * real DOM node.
 *
 * Selection rules, in order:
 * 1. Exclude any candidate whose label matches `CLOSE_LABEL_RE` — never a
 *    button this function should click.
 * 2. Exclude any candidate with `ariaSelected: true` — already the active
 *    tab; clicking it toggles the panel OFF (the exact bug this fixes: a
 *    stale `aria-selected="true"` chip left over from a prior SPA
 *    navigation was silently `.click()`-ed as a toggle-off no-op).
 * 3. Among what's left, rank by (visible > not-visible) FIRST, then by
 *    (show-verb label > generic keyword match) — visibility is the
 *    stronger signal because an invisible match is very likely a stale/
 *    collapsed leftover from a previous panel state, exactly like the live
 *    bug above.
 * 4. Ties within the same rank keep first-seen (DOM document) order.
 */
export function chooseTranscriptButton(candidates: TranscriptButtonCandidate[]): number | null {
  let bestIndex: number | null = null;
  let bestTier = Infinity;

  candidates.forEach((candidate, index) => {
    if (CLOSE_LABEL_RE.test(candidate.label)) return;
    if (candidate.ariaSelected) return;

    // Lower tier = better. Visibility is the high bit (0 vs 2) so it always
    // outranks the show-verb label distinction (0 vs 1 within a visibility
    // group), matching rule 3's stated priority order.
    const tier = (candidate.visible ? 0 : 2) + (SHOW_LABEL_RE.test(candidate.label) ? 0 : 1);
    if (tier < bestTier) {
      bestTier = tier;
      bestIndex = index;
    }
  });

  return bestIndex;
}
