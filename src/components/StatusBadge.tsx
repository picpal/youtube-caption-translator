import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'error' | 'muted';
/**
 * - text: inline dot + neutral text (default, backward compatible with Side Panel usage)
 * - pill: rounded-full chrome badge (page header "키 등록됨" / "키 없음" indicator)
 * - chip: bordered, tone-tinted panel (save / connection-test feedback)
 */
type Variant = 'text' | 'pill' | 'chip';

interface Props {
  tone: Tone;
  variant?: Variant;
  children: ReactNode;
}

// Badge · Status dot — 색은 보조 신호, 항상 텍스트 라벨 동반.
// UI 기본은 무채색, 상태 표현에만 유채색 6px 점을 사용한다.
// (docs/design/api-key-settings.dc.html — COMPONENT RULES · Badge · Status dot)
const dotColor: Record<Tone, string> = {
  ok: 'bg-[oklch(0.60_0.13_150)] dark:bg-[oklch(0.68_0.13_150)]',
  warn: 'bg-[oklch(0.70_0.13_85)] dark:bg-[oklch(0.78_0.13_85)]',
  error: 'bg-[oklch(0.58_0.18_25)] dark:bg-[oklch(0.62_0.18_25)]',
  muted: 'bg-[#b3b6bb] dark:bg-[#6f6f6f]',
};

const chipTone: Record<Tone, string> = {
  ok: 'border-[oklch(0.88_0.05_150)] bg-[oklch(0.98_0.015_150)] dark:border-[#2f3a30] dark:bg-[#141a15]',
  warn: 'border-[oklch(0.89_0.06_85)] bg-[oklch(0.985_0.02_85)] dark:border-[#3a352b] dark:bg-[#191712]',
  error: 'border-[oklch(0.89_0.05_25)] bg-[oklch(0.985_0.012_25)] dark:border-[#3a2b2c] dark:bg-[#1a1213]',
  muted: 'border-[#e4e4e6] bg-[#f7f7f8] dark:border-[#2a2a2a] dark:bg-[#181818]',
};

const iconColor: Record<Tone, string> = {
  ok: 'text-[oklch(0.52_0.13_150)] dark:text-[oklch(0.72_0.14_150)]',
  warn: 'text-[oklch(0.62_0.13_85)] dark:text-[oklch(0.80_0.13_85)]',
  error: 'text-[oklch(0.55_0.17_25)] dark:text-[oklch(0.68_0.17_25)]',
  muted: '',
};

const chipIcon: Record<Tone, string> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
  muted: '',
};

export function StatusBadge({ tone, variant = 'text', children }: Props) {
  const dot = <span className={`block h-1.5 w-1.5 flex-none rounded-full ${dotColor[tone]}`} />;

  if (variant === 'pill') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e4e4e6] bg-[#f2f2f3] px-[9px] py-1 text-[10.5px] font-semibold text-[#3d4045] dark:border-[#2e2e2e] dark:bg-[#1c1c1c] dark:text-[#c9c9c9]">
        {dot}
        {children}
      </span>
    );
  }

  if (variant === 'chip') {
    return (
      <span
        className={`inline-flex items-center gap-2 rounded-md border px-[11px] py-1.5 text-[11.5px] tabular-nums text-[#17181a] dark:text-[#ededed] ${chipTone[tone]}`}
      >
        {chipIcon[tone] && (
          <span className={`flex-none text-xs ${iconColor[tone]}`}>{chipIcon[tone]}</span>
        )}
        {children}
      </span>
    );
  }

  return (
    // Task 8 후속 — 패널 헤더(sidepanel App.tsx)에서 이 뱃지는 flex 행의
    // 직계 자식이다. 헤더 네 트리거를 `shrink-0`로 고정하고 제목을
    // `min-w-0 truncate`로 만든 뒤, 380px 폭에서 남는 압박이 여기로 몰려
    // 한글 텍스트가 글자 단위로 줄바꿈되며(준/비/됨) 헤더 높이가 늘어나는
    // 버그가 있었다. `whitespace-nowrap`으로 줄바꿈 자체를 막고
    // `flex-none`으로 축소도 막는다 — 라벨이 전부 짧은 고정 문구라("확인 중"
    // 등) 잘릴 걱정 없이 한 줄로 유지된다.
    <span className="inline-flex flex-none items-center gap-2 whitespace-nowrap text-sm text-[#3d4045] dark:text-[#c9c9c9]">
      {dot}
      {children}
    </span>
  );
}
