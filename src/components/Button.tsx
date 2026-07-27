import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'danger';
type Size = 'xs' | 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// h 34-36 / r 7 / 12.5px 650 · focus: 2px outline, offset 2
// (docs/design/api-key-settings.dc.html — COMPONENT RULES · Button)
const base =
  'inline-flex items-center justify-center gap-1.5 rounded-[7px] transition ' +
  'disabled:cursor-not-allowed disabled:bg-[#f2f2f3] disabled:text-[#b3b6bb] ' +
  'dark:disabled:bg-[#2c2c2c] dark:disabled:text-[#6f6f6f] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-[#17181a] dark:focus-visible:outline-[#ededed]';

const variants: Record<Variant, string> = {
  primary:
    'font-semibold bg-[#17181a] text-white hover:bg-black ' +
    'dark:bg-[#ededed] dark:text-[#111111] dark:hover:bg-white',
  secondary:
    'font-semibold border border-[#e0e0e2] bg-white text-[#17181a] hover:bg-[#f7f7f8] ' +
    'dark:border-[#383838] dark:bg-transparent dark:text-[#ededed] dark:hover:bg-[#1e1e1e]',
  tertiary:
    'font-medium bg-transparent text-[#6c6f74] hover:text-[#17181a] ' +
    'dark:text-[#9a9a9a] dark:hover:text-[#ededed]',
  danger: 'font-semibold bg-red-600 text-white hover:bg-red-500',
};

const sizes: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-[11px]',
  sm: 'h-[34px] px-3.5 text-[12.5px]',
  md: 'h-9 px-4 text-[12.5px]',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: Props) {
  return (
    <button
      type="button"
      {...rest}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}
