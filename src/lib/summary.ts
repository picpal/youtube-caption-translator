import type { TranscriptSegment } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';

// The model-facing payload: VideoSummary minus the fields background stamps
// itself (videoId / model / createdAt). Task 3's generateSummary returns
// this; the GENERATE_SUMMARY handler completes it into a VideoSummary.
export type SummaryPayload = Pick<
  VideoSummary,
  'purpose' | 'mainArguments' | 'sections' | 'keywords' | 'conclusion'
>;

// One manual generation is at most 3 Gemini attempts: bad_json retries once
// immediately (spec §4), rate_limit waits the server hint capped at 60s so
// the panel's 180s safety timeout (spec §5) still bounds the whole run.
export const SUMMARY_MAX_ATTEMPTS = 3;
export const SUMMARY_RATE_LIMIT_MAX_DELAY_MS = 60_000;
export const SUMMARY_DEFAULT_RETRY_DELAY_MS = 5_000;

export function buildSummaryPrompt(
  segments: readonly Pick<TranscriptSegment, 'startSec' | 'sourceText'>[],
): string {
  const lines = segments.map((s) => `[${s.startSec}] ${s.sourceText}`).join('\n');
  return `You are summarizing the English transcript of a technical YouTube video for a Korean-speaking learner.

Rules:
- Base every statement strictly on the transcript content. Do NOT add your own opinions, commentary, or outside knowledge.
- Write ALL output values in Korean (keep well-known English technical terms as-is where natural).
- "sections" must follow the talk's actual flow in order. Each section's startSec MUST be one of the [startSec] values present in the transcript below.

Respond with JSON only, matching this shape:
{"purpose": string, "mainArguments": string[], "sections": [{"startSec": number, "title": string}], "keywords": string[], "conclusion": string}

- purpose: what problem this video addresses, one or two sentences.
- mainArguments: 3-5 core claims, one sentence each.
- sections: 4-8 entries covering the talk's flow.
- keywords: 4-8 key technical terms.
- conclusion: the talk's conclusion, one or two sentences.

Transcript ([startSec] English text):
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
  reason: 'bad_json' | 'rate_limit' | 'unauthorized' | 'network' | 'unknown',
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
  return { retry: false, delayMs: 0 };
}
