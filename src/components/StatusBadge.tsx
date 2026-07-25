import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'error' | 'muted';

interface Props {
  tone: Tone;
  children: ReactNode;
}

const dot: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  muted: 'bg-neutral-400',
};

const text: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-700 dark:text-red-400',
  muted: 'text-neutral-600 dark:text-neutral-400',
};

export function StatusBadge({ tone, children }: Props) {
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${text[tone]}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot[tone]}`} />
      {children}
    </span>
  );
}
