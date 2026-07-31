import type { TranscriptSegment } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import { TARGET_LANG_NAMES } from './target-lang';
import type { TargetLang } from './target-lang';

// The model-facing payload: VideoSummary minus the fields background stamps
// itself (videoId / model / createdAt). Task 3's generateSummary returns
// this; the GENERATE_SUMMARY handler completes it into a VideoSummary.
export type SummaryPayload = Pick<
  VideoSummary,
  'purpose' | 'mainArguments' | 'sections' | 'keywords' | 'conclusion'
>;

// One manual generation is at most 3 Gemini attempts: bad_json retries once
// immediately (spec §4), rate_limit waits the server hint capped at 60s so
// the panel's SUMMARY_SAFETY_TIMEOUT_MS safety timeout (spec §5, useSummary.ts)
// still bounds the whole run.
export const SUMMARY_MAX_ATTEMPTS = 3;
export const SUMMARY_RATE_LIMIT_MAX_DELAY_MS = 60_000;
export const SUMMARY_DEFAULT_RETRY_DELAY_MS = 5_000;

// summary-inflight fix (2026-07-31/08-01) — the panel-side decision for
// `useSummary`'s initial GET_SUMMARY load, pulled out as a pure function for
// the same reason `activeSegmentIndex`/`shouldEmitTick` live in
// playback-sync.ts rather than inline in a hook: this repo has no
// hook-rendering test harness (see useSummary.test.ts's constant-only
// coverage), so any branching worth locking in has to live somewhere a plain
// vitest `it()` can call it directly.
//
// The three-way split matters because summary generation now starts
// automatically alongside translation (`triggerParallelSummary`,
// background.ts) instead of waiting for a panel-initiated GENERATE_SUMMARY.
// Before that change, `summary === null` on load only ever meant "nothing
// requested yet" — the 빈 상태 + 요약 생성 button was the only honest
// response. Now a job can already be running with nobody having clicked
// anything, so `null` splits into two states the panel must render
// differently: still-cooking (spinner) vs. genuinely nothing (button).
// `generating` (== `inFlightSummaries.has(videoId)` in background.ts) is
// exactly the signal that tells the two apart.
export function summaryStateFor(res: {
  summary: VideoSummary | null;
  generating: boolean;
}): 'done' | 'generating' | 'idle' {
  if (res.summary !== null) return 'done';
  return res.generating ? 'generating' : 'idle';
}

export function buildSummaryPrompt(
  segments: readonly Pick<TranscriptSegment, 'startSec' | 'sourceText'>[],
  targetLang: TargetLang,
): string {
  const name = TARGET_LANG_NAMES[targetLang];
  const lines = segments.map((s) => `[${s.startSec}] ${s.sourceText}`).join('\n');
  return `You are summarizing the transcript of a technical YouTube video (it may be in any language) for a learner who reads ${name}.

Rules:
- Base every statement strictly on the transcript content. Do NOT add your own opinions, commentary, or outside knowledge.
- Write ALL output values in ${name} (keep well-known technical terms in their original form where natural).
- "sections" must follow the talk's actual flow in order. Each section's startSec MUST be one of the [startSec] values present in the transcript below.

Respond with JSON only, matching this shape:
{"purpose": string, "mainArguments": string[], "sections": [{"startSec": number, "title": string}], "keywords": string[], "conclusion": string}

- purpose: what problem this video addresses, one or two sentences.
- mainArguments: 3-5 core claims, one sentence each.
- sections: 4-8 entries covering the talk's flow.
- keywords: 4-8 key technical terms.
- conclusion: the talk's conclusion, one or two sentences.

Transcript ([startSec] source text):
"""
${lines}
"""`;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function nonEmptyStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
  return items.length > 0 ? items : undefined;
}

function isRawSection(v: unknown): v is { startSec: number; title: string } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.startSec === 'number' &&
    Number.isFinite(o.startSec) &&
    typeof o.title === 'string' &&
    o.title.trim().length > 0
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// Validates + normalizes a parsed model response (spec §4): every field
// present and non-empty, section startSec clamped into [0, maxStartSec] and
// sorted ascending, malformed section entries dropped. Returns undefined —
// never throws — so the caller can turn broken output into a bad_json retry.
export function normalizeSummaryPayload(
  parsed: unknown,
  maxStartSec: number,
): SummaryPayload | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const purpose = nonEmptyString(obj.purpose);
  const conclusion = nonEmptyString(obj.conclusion);
  const mainArguments = nonEmptyStringArray(obj.mainArguments);
  const keywords = nonEmptyStringArray(obj.keywords);
  if (!purpose || !conclusion || !mainArguments || !keywords) return undefined;
  if (!Array.isArray(obj.sections)) return undefined;
  const sections = obj.sections
    .filter(isRawSection)
    .map((s) => ({ startSec: clamp(s.startSec, 0, maxStartSec), title: s.title.trim() }))
    .sort((a, b) => a.startSec - b.startSec);
  if (sections.length === 0) return undefined;
  return { purpose, mainArguments, sections, keywords, conclusion };
}

// Bounded retry policy for one manual generation. `attempt` is the 1-based
// attempt that just failed.
export function summaryRetryPlan(
  reason: 'bad_json' | 'rate_limit' | 'unauthorized' | 'network' | 'timeout' | 'unknown',
  attempt: number,
  retryDelayMs?: number,
): { retry: boolean; delayMs: number } {
  if (attempt >= SUMMARY_MAX_ATTEMPTS) return { retry: false, delayMs: 0 };
  if (reason === 'bad_json') return { retry: attempt === 1, delayMs: 0 };
  if (reason === 'rate_limit') {
    return {
      retry: true,
      delayMs: Math.min(retryDelayMs ?? SUMMARY_DEFAULT_RETRY_DELAY_MS, SUMMARY_RATE_LIMIT_MAX_DELAY_MS),
    };
  }
  // `timeout` (2026-07-31 timeout fix) falls through to the same
  // `{retry:false}` as `network`/`unauthorized`/`unknown` below — called out
  // explicitly rather than left as a silent fallthrough: a request that just
  // spent `SUMMARY_FETCH_TIMEOUT_MS` (300s) aborting has already cost the
  // user a long wait, and a same-length retry is likely to hit the same
  // fate. Not worth the extra wait for a request this slow.
  return { retry: false, delayMs: 0 };
}
