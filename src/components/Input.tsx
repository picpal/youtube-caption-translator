import { forwardRef, useState, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helper?: string;
  revealable?: boolean;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, helper, revealable, type = 'text', className = '', id, ...rest },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  const effectiveType = revealable && revealed ? 'text' : type;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={id}
          className="text-xs font-medium text-neutral-600 dark:text-neutral-400"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={id}
          type={effectiveType}
          className={`w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-600 ${revealable ? 'pr-16' : ''} ${className}`}
          {...rest}
        />
        {revealable && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {revealed ? '숨김' : '표시'}
          </button>
        )}
      </div>
      {helper && (
        <p className="text-xs text-neutral-500 dark:text-neutral-500">{helper}</p>
      )}
    </div>
  );
});
