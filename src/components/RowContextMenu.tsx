import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RowMenuItem } from '~/lib/bookmarks';

/**
 * Transcript 행의 우클릭 메뉴. `chrome.contextMenus`를 쓰지 않는 이유는 권한이다 —
 * 이 확장의 permissions는 `['storage', 'sidePanel']` 둘뿐이고, 그 선을 문맥 메뉴
 * 하나 때문에 넘기지 않는다.
 *
 * 열고 닫는 규칙(바깥 pointerdown, Escape, 열릴 때 첫 항목 포커스)은
 * `DownloadMenu`가 이미 확립한 것을 그대로 따른다.
 */
export function RowContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  items: RowMenuItem[];
  onSelect: (item: RowMenuItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 실제 크기를 재기 전에는 그리지 않는다 — 클릭 좌표에 한 번 그렸다가 뒤집으면
  // 메뉴가 눈에 띄게 튄다.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    // 패널이 400px로 좁아서 오른쪽 넘침은 예외가 아니라 기본이다. 넘치면 클릭
    // 좌표의 왼쪽으로 펼친다.
    const left = x + width > window.innerWidth - margin ? Math.max(margin, x - width) : x;
    const top = y + height > window.innerHeight - margin ? Math.max(margin, y - height) : y;
    setPlacement({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        left: placement?.left ?? x,
        top: placement?.top ?? y,
        visibility: placement === null ? 'hidden' : 'visible',
      }}
      className="z-20 min-w-[10rem] overflow-hidden rounded-[7px] border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          onClick={() => onSelect(item)}
          className="block w-full px-3 py-2 text-left text-[12px] text-neutral-800 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-900"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
