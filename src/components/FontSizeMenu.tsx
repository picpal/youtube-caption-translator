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
  // 최소 배율에서 A−가 비활성이라 포커스가 쓸모없는 곳에 들어간다.
  // A−/A+는 네이티브 disabled 대신 aria-disabled를 쓴다(아래 StepButton 참고) —
  // 포커스를 가진 버튼이 disabled가 되면 Chrome이 포커스를 <body>로 던지기 때문이다.
  // 그래서 쿼리도 [disabled]뿐 아니라 [aria-disabled="true"]까지 함께 제외해야
  // A−/A+ 중 실제로 동작하는 쪽을 잡는다. rootRef는 트리거 버튼과 팝오버 둘 다를
  // 감싸므로, 쿼리는 [role="group"]으로 스코핑해야 한다 — 그렇지 않으면 트리거
  // 버튼이 먼저 선택돼서 팝오버 버튼들에 닿지 않는다.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      rootRef.current
        ?.querySelector<HTMLButtonElement>(
          '[role="group"] button:not([disabled]):not([aria-disabled="true"])',
        )
        ?.focus();
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
        // Task 8 후속(광학 크기 통일) — 텍스트 글리프라 대문자 높이가 폰트
        // 크기의 ~0.72배뿐이라, 다른 헤더 아이콘의 렌더 잉크(≈12.75px)에 맞추려면
        // 폰트 자체를 12px보다 키워야 한다. 15px에서 시작해 눈으로 맞춘 값.
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[15px] font-semibold leading-none text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
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

// 네이티브 disabled 대신 aria-disabled + no-op 핸들러를 쓴다. A−/A+는 경계값에서
// "지금 포커스를 갖고 있는 바로 그 버튼"이 비활성으로 바뀌는데, 네이티브 disabled면
// Chrome이 그 순간 포커스를 <body>로 옮겨버린다(예: 100%에서 A−를 눌러 90%로 내려가면
// A−가 disabled되며 포커스 소실). aria-disabled는 포커스를 유지한 채로 "눌러도
// 반응 없음"만 만들어 그 문제가 없다. stepFontScale이 경계에서 이미 클램프하므로
// (font-scale.ts) 핸들러의 no-op은 안전장치일 뿐 로직을 바꾸지 않는다.
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
  const handleClick = () => {
    if (disabled) return;
    onClick();
  };
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled}
      onClick={handleClick}
      className={
        disabled
          ? 'h-7 flex-1 cursor-not-allowed rounded-[5px] border border-neutral-100 text-[12.5px] font-semibold text-neutral-300 dark:border-neutral-900 dark:text-neutral-700'
          : 'h-7 flex-1 rounded-[5px] border border-neutral-200 text-[12.5px] font-semibold text-neutral-800 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900'
      }
    >
      {children}
    </button>
  );
}
