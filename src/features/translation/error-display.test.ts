import { describe, expect, it } from 'vitest';
import { translationErrorDisplay } from './error-display';

// Task R7 (Fix 2B) — each case below mirrors an ACTUAL reason string shape
// this codebase produces (see error-display.ts's own doc comment for the
// grep source), not an invented one.

describe('translationErrorDisplay', () => {
  it('maps the exact no-transcript-panel reason (pipeline.ts failPipeline literal)', () => {
    expect(translationErrorDisplay('No transcript panel available for this video')).toBe(
      '이 영상은 스크립트(대본)를 제공하지 않아 자막을 생성할 수 없어요',
    );
  });

  it('maps a rate_limit chunk-failure summary', () => {
    expect(
      translationErrorDisplay('chunk 0: rate_limit (Resource has been exhausted. Please retry in 55.5s.)'),
    ).toBe('요청이 많아요. 잠시 후 다시 시도해주세요');
  });

  it('maps a network chunk-failure summary', () => {
    expect(
      translationErrorDisplay('chunk 0: network (Failed to fetch)'),
    ).toBe('네트워크 연결이 불안정해요. 잠시 후 다시 시도해주세요');
  });

  // 2026-07-31 timeout fix — the fetch-timeout abort path used to fall under
  // `network` (see this file's own doc comment above); it is now its own
  // `timeout` reason with dedicated Korean copy, checked BEFORE the
  // `network` branch. Covers both a translation chunk timeout
  // (pipeline.ts's `"chunk <n>: timeout (...)"` shape) and a summary timeout
  // (background.ts's `"timeout: <message>"` shape) — the same branch serves
  // both since it matches on the bare substring.
  it('maps a timeout chunk-failure summary', () => {
    expect(
      translationErrorDisplay('chunk 0: timeout (The operation was aborted.)'),
    ).toBe('응답이 너무 오래 걸려 중단됐어요. 긴 영상일수록 오래 걸립니다 — 다시 시도해주세요');
  });

  it('maps a summary-generation timeout reason', () => {
    expect(translationErrorDisplay('timeout: The operation was aborted.')).toBe(
      '응답이 너무 오래 걸려 중단됐어요. 긴 영상일수록 오래 걸립니다 — 다시 시도해주세요',
    );
  });

  it('maps an unauthorized chunk-failure summary', () => {
    expect(translationErrorDisplay('chunk 0: unauthorized (API key not valid)')).toBe(
      'API 키가 유효하지 않아요. 설정에서 키를 확인해주세요',
    );
  });

  it('maps the exact API-key-not-set reason (background.ts START_TRANSLATION literal, fix round 1)', () => {
    expect(translationErrorDisplay('API key not set')).toBe(
      'API 키가 유효하지 않아요. 설정에서 키를 확인해주세요',
    );
  });

  it('maps the exact transcript-open-failed reason (pipeline.ts unavailableReasonMessage literal, 2026-07-29 fix round)', () => {
    expect(translationErrorDisplay('Transcript panel failed to open')).toBe(
      '스크립트 패널을 여는 데 실패했어요. 페이지를 새로고침한 뒤 다시 시도해주세요.',
    );
  });

  it('maps a bad_json summary-generation reason (background.ts GENERATE_SUMMARY, fix round Important #2)', () => {
    expect(translationErrorDisplay('bad_json: Could not parse summary response')).toBe(
      '요약 응답을 해석하지 못했어요. 다시 시도해주세요.',
    );
  });

  it('maps a multi-chunk summary by the first matching reason token present', () => {
    expect(
      translationErrorDisplay('chunk 0: network (offline); chunk 1: network (offline)'),
    ).toBe('네트워크 연결이 불안정해요. 잠시 후 다시 시도해주세요');
  });

  it('returns an unrecognized reason verbatim (e.g. truncated/bad_json/completeness messages)', () => {
    expect(translationErrorDisplay('chunk 0: truncated (Response truncated at MAX_TOKENS)')).toBe(
      'chunk 0: truncated (Response truncated at MAX_TOKENS)',
    );
    expect(
      translationErrorDisplay('Only 40/50 segments translated (80%) — below the 95% completeness threshold'),
    ).toBe('Only 40/50 segments translated (80%) — below the 95% completeness threshold');
  });
});
