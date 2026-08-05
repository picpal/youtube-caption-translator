import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STEPS,
  formatFontScale,
  stepFontScale,
} from '~/lib/font-scale';

const MIN_SCALE = FONT_SCALE_STEPS[0];
const MAX_SCALE = FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1];

/**
 * 헤더의 `Aa` 버튼 (spec 2026-08-05 §3). 본문 배율만 바꾸고, 배율 값 자체는
 * 부모(App)가 소유한다 — 이 컴포넌트는 storage도 CSS 변수도 만지지 않는다.
 *
 * 열고 닫는 규칙은 `DownloadMenu`와 같지만 **항목 선택으로는 닫지 않는다**:
 * A−/A+는 원하는 크기가 나올 때까지 연달아 누르는 컨트롤이라, 한 번 누를 때마다
 * 닫히면 쓸 수 없다.
 */
export function FontSizeMenu({
  scale,
  onChange,
}: {
  scale: number;
  onChange: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 마운트 시(open이 처음부터 false) 트리거로 포커스를 되돌리지 않기 위한 추적 —
  // DownloadMenu와 같은 이유다.
  const wasOpenRef = useRef(false);

  // 열릴 때 첫 번째 '활성' 컨트롤로 포커스를 넣는다. 첫 항목을 고정으로 집으면
  // 최소 배율에서 A−가 disabled라 포커스가 들어가지 않는다.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      rootRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // 바깥 클릭 / Escape로 닫기. 열려 있을 때만 문서 리스너를 붙인다.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="글자 크기"
        aria-haspopup="true"
        aria-expanded={open}
        className="rounded px-1.5 py-1 text-[12px] font-semibold leading-none text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        Aa
      </button>

      {open && (
        <div
          role="group"
          aria-label="글자 크기"
          className="absolute right-0 z-10 mt-1 w-40 rounded-[7px] border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div className="flex items-center justify-between gap-2">
            <StepButton
              label="글자 작게"
              disabled={scale <= MIN_SCALE}
              onClick={() => onChange(stepFontScale(scale, -1))}
            >
              A−
            </StepButton>
            {/* 팝오버 자신은 배율을 따르지 않는다 — 컨트롤은 고정 크기(spec §2). */}
            <span
              aria-live="polite"
              className="min-w-[3.5em] text-center text-[12px] font-medium tabular-nums text-neutral-800 dark:text-neutral-200"
            >
              {formatFontScale(scale)}
            </span>
            <StepButton
              label="글자 크게"
              disabled={scale >= MAX_SCALE}
              onClick={() => onChange(stepFontScale(scale, 1))}
            >
              A+
            </StepButton>
          </div>
          <button
            type="button"
            disabled={scale === DEFAULT_FONT_SCALE}
            onClick={() => onChange(DEFAULT_FONT_SCALE)}
            className="mt-1.5 w-full rounded px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-300 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:disabled:text-neutral-700"
          >
            기본값으로
          </button>
        </div>
      )}
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 flex-1 rounded-[5px] border border-neutral-200 text-[12.5px] font-semibold text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:border-neutral-100 disabled:text-neutral-300 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900 dark:disabled:border-neutral-900 dark:disabled:text-neutral-700"
    >
      {children}
    </button>
  );
}
