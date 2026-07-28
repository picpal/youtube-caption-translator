import { describe, expect, it } from 'vitest';
import { progressPercent, stepForStatus, translatePhaseLabel } from './progress-display';

describe('progressPercent', () => {
  it('returns 0 when total is 0 (the first onProgress event) rather than NaN/Infinity', () => {
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('returns 0 when total is 0 even if done is somehow nonzero', () => {
    expect(progressPercent(5, 0)).toBe(0);
  });

  it('returns 0 at the start of a real batch (done 0, total nonzero)', () => {
    expect(progressPercent(0, 100)).toBe(0);
  });

  it('returns 100 when done equals total', () => {
    expect(progressPercent(50, 50)).toBe(100);
  });

  it('rounds a fractional percentage to the nearest integer', () => {
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(2, 3)).toBe(67);
  });
});

describe('stepForStatus', () => {
  it('maps idle to 0 (nothing started yet)', () => {
    expect(stepForStatus('idle')).toBe(0);
  });

  it('maps extracting to step 1', () => {
    expect(stepForStatus('extracting')).toBe(1);
  });

  it('maps analyzing to step 2', () => {
    expect(stepForStatus('analyzing')).toBe(2);
  });

  it('maps translating to step 3', () => {
    expect(stepForStatus('translating')).toBe(3);
  });

  it('maps done to step 4', () => {
    expect(stepForStatus('done')).toBe(4);
  });

  it('maps failed to 0 (the status alone carries no step information)', () => {
    expect(stepForStatus('failed')).toBe(0);
  });
});

describe('translatePhaseLabel', () => {
  it('maps sending to 요청 전송', () => {
    expect(translatePhaseLabel('sending')).toBe('요청 전송');
  });

  it('maps receiving to 응답 수신', () => {
    expect(translatePhaseLabel('receiving')).toBe('응답 수신');
  });

  it('maps parsing to 파싱·정합성', () => {
    expect(translatePhaseLabel('parsing')).toBe('파싱·정합성');
  });

  it('returns null when there is no active phase (outside step 3, or a chunk boundary event)', () => {
    expect(translatePhaseLabel(undefined)).toBeNull();
  });
});
