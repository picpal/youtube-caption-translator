import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';
type Size = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  'inline-flex items-center justify-center rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-neutral-50 dark:focus:ring-offset-neutral-950';

const variants: Record<Variant, string> = {
  primary:
    'bg-neutral-900 text-white hover:bg-neutral-800 focus:ring-neutral-500 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200',
  secondary:
    'bg-neutral-200 text-neutral-900 hover:bg-neutral-300 focus:ring-neutral-400 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700',
  danger:
    'bg-red-600 text-white hover:bg-red-500 focus:ring-red-500',
};

const sizes: Record<Size, string> = {
  sm: 'text-sm px-3 py-1.5',
  md: 'text-sm px-4 py-2',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}
