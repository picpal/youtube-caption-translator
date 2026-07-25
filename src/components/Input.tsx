import { forwardRef, useState, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helper?: string;
  revealable?: boolean;
  /** Renders the error border/background from the design's "D · ERROR" state. */
  invalid?: boolean;
}

// h 36 / r 7 · value is always monospace, letter-spacing .06em
// (docs/design/api-key-settings.dc.html — COMPONENT RULES · Input)
export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, helper, revealable, invalid, type = 'text', className = '', id, ...rest },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  const effectiveType = revealable && revealed ? 'text' : type;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={id}
          className="text-xs font-medium text-[#6c6f74] dark:text-[#9a9a9a]"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={id}
          type={effectiveType}
          className={`h-9 w-full rounded-[7px] border px-[11px] font-mono text-[12.5px] tracking-[0.06em] transition placeholder:font-sans placeholder:tracking-normal placeholder:text-[#b3b6bb] focus:outline-none dark:placeholder:text-[#5f5f5f] ${
            invalid
              ? 'border-[oklch(0.62_0.16_25)] bg-[oklch(0.99_0.01_25)] text-[#17181a] dark:border-[oklch(0.55_0.15_25)] dark:bg-[#170f10] dark:text-[#e4e4e4]'
              : 'border-[#e0e0e2] bg-white text-[#17181a] focus:border-[#17181a] dark:border-[#333333] dark:bg-[#0f0f0f] dark:text-[#ededed] dark:focus:border-[#ededed]'
          } ${revealable ? 'pr-14' : ''} ${className}`}
          {...rest}
        />
        {revealable && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] font-medium text-[#6c6f74] hover:bg-[#f2f2f3] dark:text-[#9a9a9a] dark:hover:bg-[#1e1e1e]"
          >
            {revealed ? '숨김' : '표시'}
          </button>
        )}
      </div>
      {helper && (
        <p className="text-xs text-[#8a8d92] dark:text-[#7a7a7a]">{helper}</p>
      )}
    </div>
  );
});
