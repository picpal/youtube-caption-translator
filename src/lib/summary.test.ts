import { describe, expect, it } from 'vitest';
import {
  SUMMARY_MAX_ATTEMPTS,
  buildSummaryPrompt,
  normalizeSummaryPayload,
  summaryRetryPlan,
} from './summary';

const seg = (startSec: number, sourceText: string) => ({ startSec, sourceText });

describe('buildSummaryPrompt', () => {
  it('renders one [startSec] line per segment in order', () => {
    const prompt = buildSummaryPrompt([seg(0, 'hello world'), seg(11, 'second line')]);
    expect(prompt).toContain('[0] hello world\n[11] second line');
  });

  it('includes the PRD guardrails, Korean-output rule, and the JSON shape', () => {
    const prompt = buildSummaryPrompt([seg(0, 'x')]);
    expect(prompt).toContain('Do NOT add your own opinions');
    expect(prompt).toContain('Korean');
    expect(prompt).toContain('"purpose": string');
  });
});

const validPayload = () => ({
  purpose: '문제 설명',
  mainArguments: ['주장 1', '주장 2'],
  sections: [
    { startSec: 620, title: '실패 원인' },
    { startSec: 0, title: '문제 정의' },
  ],
  keywords: ['Agent'],
  conclusion: '결론',
});

describe('normalizeSummaryPayload', () => {
  it('accepts a valid payload and sorts sections by startSec ascending', () => {
    const result = normalizeSummaryPayload(validPayload(), 3600);
    expect(result?.sections.map((s) => s.startSec)).toEqual([0, 620]);
    expect(result?.purpose).toBe('문제 설명');
  });

  it('clamps section startSec into [0, maxStartSec]', () => {
    const p = validPayload();
    p.sections = [
      { startSec: 99999, title: '끝' },
      { startSec: -5, title: '시작' },
    ];
    const result = normalizeSummaryPayload(p, 3600);
    expect(result?.sections.map((s) => s.startSec)).toEqual([0, 3600]);
  });

  it('drops malformed section entries but keeps valid ones', () => {
    const p = validPayload();
    (p.sections as unknown[]) = [
      { startSec: 10, title: '유효' },
      { startSec: Number.NaN, title: '무효' },
      { startSec: 20, title: '' },
    ];
    const result = normalizeSummaryPayload(p, 3600);
    expect(result?.sections).toEqual([{ startSec: 10, title: '유효' }]);
  });

  it('rejects when sections is empty or has no valid entry (spec §6)', () => {
    expect(normalizeSummaryPayload({ ...validPayload(), sections: [] }, 3600)).toBeUndefined();
    expect(
      normalizeSummaryPayload({ ...validPayload(), sections: [{ startSec: 'x', title: '' }] }, 3600),
    ).toBeUndefined();
  });

  it('rejects missing or empty required fields', () => {
    expect(normalizeSummaryPayload({ ...validPayload(), purpose: ' ' }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload({ ...validPayload(), mainArguments: [] }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload({ ...validPayload(), keywords: undefined }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload({ ...validPayload(), conclusion: 42 }, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload(null, 3600)).toBeUndefined();
    expect(normalizeSummaryPayload('not an object', 3600)).toBeUndefined();
  });

  it('trims whitespace on string fields', () => {
    const p = validPayload();
    p.purpose = '  문제  ';
    p.mainArguments = ['  주장  '];
    const result = normalizeSummaryPayload(p, 3600);
    expect(result?.purpose).toBe('문제');
    expect(result?.mainArguments).toEqual(['주장']);
  });
});

describe('summaryRetryPlan', () => {
  it('retries bad_json immediately, exactly once (spec §4)', () => {
    expect(summaryRetryPlan('bad_json', 1)).toEqual({ retry: true, delayMs: 0 });
    expect(summaryRetryPlan('bad_json', 2)).toEqual({ retry: false, delayMs: 0 });
  });

  it('retries rate_limit with the hinted delay, capped at 60s, default 5s', () => {
    expect(summaryRetryPlan('rate_limit', 1, 55_000)).toEqual({ retry: true, delayMs: 55_000 });
    expect(summaryRetryPlan('rate_limit', 2, 120_000)).toEqual({ retry: true, delayMs: 60_000 });
    expect(summaryRetryPlan('rate_limit', 1, undefined)).toEqual({ retry: true, delayMs: 5_000 });
  });

  it('never exceeds SUMMARY_MAX_ATTEMPTS and never retries terminal reasons', () => {
    expect(summaryRetryPlan('rate_limit', SUMMARY_MAX_ATTEMPTS)).toEqual({ retry: false, delayMs: 0 });
    expect(summaryRetryPlan('unauthorized', 1)).toEqual({ retry: false, delayMs: 0 });
    expect(summaryRetryPlan('network', 1)).toEqual({ retry: false, delayMs: 0 });
    expect(summaryRetryPlan('unknown', 1)).toEqual({ retry: false, delayMs: 0 });
  });
});
