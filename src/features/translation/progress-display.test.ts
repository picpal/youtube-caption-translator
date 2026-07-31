import { describe, expect, it } from 'vitest';
import { formatElapsedTime, translatePhaseLabel } from './progress-display';

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

describe('formatElapsedTime', () => {
  it('formats 0 seconds', () => {
    expect(formatElapsedTime(0)).toBe('0초 경과');
  });

  it('formats seconds under a minute', () => {
    expect(formatElapsedTime(12)).toBe('12초 경과');
    expect(formatElapsedTime(59)).toBe('59초 경과');
  });

  it('switches to minutes+seconds at 60s', () => {
    expect(formatElapsedTime(60)).toBe('1분 00초 경과');
  });

  it('zero-pads the seconds component past a minute', () => {
    expect(formatElapsedTime(65)).toBe('1분 05초 경과');
  });

  it('formats multiple minutes', () => {
    expect(formatElapsedTime(125)).toBe('2분 05초 경과');
  });

  it('floors a fractional seconds input and clamps negative input to 0', () => {
    expect(formatElapsedTime(12.9)).toBe('12초 경과');
    expect(formatElapsedTime(-5)).toBe('0초 경과');
  });
});
