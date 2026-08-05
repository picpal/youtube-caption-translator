/**
 * 패널 본문 배율 (spec 2026-08-05). 시계·난수·storage를 읽지 않는 순수 모듈 —
 * 단계 계산과 표시 문자열만 책임진다.
 */
export const FONT_SCALE_STEPS = [0.9, 1, 1.15, 1.3, 1.5, 1.75] as const;

export const DEFAULT_FONT_SCALE = 1;

const STEPS: readonly number[] = FONT_SCALE_STEPS;

/**
 * 저장된 값을 단계 목록 안의 값으로 좁힌다. 가장 가까운 단계로 반올림하지 않는
 * 이유는 spec §5.1 — 단계 목록이 나중에 바뀌면 저장된 옛 값은 의미를 잃는다.
 * 조용히 근처 값으로 끌어다 붙이는 것보다 기본값으로 되돌리는 편이 예측 가능하다.
 */
export function normalizeFontScale(raw: unknown): number {
  return STEPS.includes(raw as number) ? (raw as number) : DEFAULT_FONT_SCALE;
}

/** 한 단계 위(`1`)/아래(`-1`). 경계에서는 현재 값을 그대로 돌려준다. */
export function stepFontScale(current: number, dir: 1 | -1): number {
  const index = STEPS.indexOf(normalizeFontScale(current));
  const next = index + dir;
  return next >= 0 && next < STEPS.length ? STEPS[next] : STEPS[index];
}

/** 1.15 → "115%". 0.1 + 0.05 류의 부동소수 잔재가 문자열로 새지 않도록 반올림한다. */
export function formatFontScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
