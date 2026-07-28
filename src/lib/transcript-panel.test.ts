import { describe, expect, it } from 'vitest';
import { chooseTranscriptButton, type TranscriptButtonCandidate } from './transcript-panel';

// Fix round (2026-07-29 task-brief.md) — cases mirror the ACTUAL field bug
// (task-brief.md's confirmed diagnosis on
// https://www.youtube.com/watch?v=t3YJ5hKiMQ0): 4 regex-matched candidates,
// all invisible, first one already `aria-selected="true"` — plus the
// close-button trap docs/youtube-transcript-findings.md §6b's manual
// close/reopen sequence surfaced.

function candidate(overrides: Partial<TranscriptButtonCandidate> = {}): TranscriptButtonCandidate {
  return { label: '스크립트', visible: false, ariaSelected: false, ...overrides };
}

describe('chooseTranscriptButton', () => {
  it('returns null when there are no candidates', () => {
    expect(chooseTranscriptButton([])).toBeNull();
  });

  it('excludes a close/hide-labeled candidate even if nothing else matches', () => {
    const candidates = [candidate({ label: '스크립트 닫기' }), candidate({ label: 'Hide transcript' })];
    expect(chooseTranscriptButton(candidates)).toBeNull();
  });

  it('excludes an already aria-selected candidate (the field bug: stale SPA-nav chip, click would toggle it off)', () => {
    const candidates = [candidate({ label: '스크립트', ariaSelected: true })];
    expect(chooseTranscriptButton(candidates)).toBeNull();
  });

  it('reproduces the exact field bug: 4 invisible matches, first one aria-selected — must skip it and pick another invisible one, not return null', () => {
    const candidates = [
      candidate({ label: '스크립트', visible: false, ariaSelected: true }), // the stale chip — must be skipped
      candidate({ label: '스크립트 닫기', visible: false }), // close button — must be skipped
      candidate({ label: '대본 표시', visible: false }), // show-verb match, invisible — best of what's left
      candidate({ label: '대본', visible: false }),
    ];
    expect(chooseTranscriptButton(candidates)).toBe(2);
  });

  it('prefers a visible candidate over any invisible one, even over an invisible show-verb match', () => {
    const candidates = [
      candidate({ label: '스크립트 표시', visible: false }), // invisible, show-verb — still ranks below any visible one
      candidate({ label: '스크립트', visible: true }), // visible, generic — wins
    ];
    expect(chooseTranscriptButton(candidates)).toBe(1);
  });

  it('within the same visibility tier, prefers a show-verb label over a generic match', () => {
    const candidates = [
      candidate({ label: '스크립트', visible: true }),
      candidate({ label: 'Show transcript', visible: true }),
    ];
    expect(chooseTranscriptButton(candidates)).toBe(1);
  });

  it('keeps first-seen order as the tie-break within an identical rank', () => {
    const candidates = [
      candidate({ label: 'Show transcript', visible: true }),
      candidate({ label: '스크립트 표시', visible: true }),
    ];
    expect(chooseTranscriptButton(candidates)).toBe(0);
  });

  it('picks the single valid candidate when only one is left after exclusions', () => {
    const candidates = [
      candidate({ label: '스크립트 닫기' }),
      candidate({ label: '스크립트', ariaSelected: true }),
      candidate({ label: 'transcript', visible: true }),
    ];
    expect(chooseTranscriptButton(candidates)).toBe(2);
  });

  it('returns null when every candidate is excluded (all close-labeled or all aria-selected)', () => {
    const candidates = [
      candidate({ label: '닫기', visible: true }),
      candidate({ label: 'close', visible: false }),
      candidate({ label: 'transcript', ariaSelected: true }),
    ];
    expect(chooseTranscriptButton(candidates)).toBeNull();
  });
});
