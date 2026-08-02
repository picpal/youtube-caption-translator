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
  restoreFocusTo,
}: {
  x: number;
  y: number;
  items: RowMenuItem[];
  onSelect: (item: RowMenuItem) => void;
  onClose: () => void;
  /** 닫힐 때 포커스를 돌려받을 요소 — 우클릭 시점에 호출부(TranscriptList)가
   * 정한다. `null`이면(포커스할 만한 게 없었으면) 그냥 되돌리지 않는다. */
  restoreFocusTo: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 실제 크기를 재기 전에는 그리지 않는다 — 클릭 좌표에 한 번 그렸다가 뒤집으면
  // 메뉴가 눈에 띄게 튄다.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  // finding I2 — DownloadMenu의 wasOpenRef와 같은 목적(닫힐 때 트리거로 포커스
  // 복귀)을 다른 구조로 이룬다. DownloadMenu는 컴포넌트가 항상 마운트된 채
  // `open` 불리언만 토글되므로 "이전에 열려 있었는가"를 ref로 추적해야 했다.
  // 이 메뉴는 열림=마운트, 닫힘=언마운트라 그 상태 기계가 필요 없고, 아래
  // 마운트 effect의 cleanup(=언마운트 시 1회 실행)이 정확히 "닫힐 때"다. ref로
  // 감싸는 이유는 같은 메뉴가 다른 행으로 옮겨갈 때(재마운트 없이 이 prop만
  // 바뀔 때) cleanup이 돌지 않게 하면서도, 진짜 닫히는 순간에는 항상 최신
  // 트리거를 읽기 위해서다.
  const restoreFocusToRef = useRef(restoreFocusTo);
  restoreFocusToRef.current = restoreFocusTo;

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
    // 언마운트(=닫힘) 시 트리거로 포커스를 되돌린다 — 위 restoreFocusToRef 주석
    // 참고. 키보드로 메뉴를 연 사용자가 Escape를 누르면 다음 Tab이 문서 맨
    // 위가 아니라 우클릭했던 그 행에서 이어져야 한다.
    return () => {
      restoreFocusToRef.current?.focus();
    };
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
    // finding I4 — 네이티브 컨텍스트 메뉴는 스크롤하면 닫힌다. 이 메뉴는
    // position:fixed라 스크롤을 따라가지 않는데, 재생 중엔 활성 행 auto-scroll이
    // 세그먼트가 바뀔 때마다 리스트를 움직인다(TranscriptList의
    // scrollIntoView). 그대로 두면 메뉴가 우클릭하지 않은 다른 행 위에 뜬 채로
    // 남고, 거기서 항목을 고르면 (정확하게도) 원래 행이 저장돼 사용자 눈에는
    // "엉뚱한 문장이 저장됐다"로 보인다. capture 단계인 이유는 실제 스크롤
    // 컨테이너가 패널의 바깥 overflow div(App.tsx)라, 이 컴포넌트의 조상 어디서
    // 스크롤이 나든 잡아야 해서다 — TranscriptList 자신의 스크롤 감지와 같은
    // 패턴.
    document.addEventListener('scroll', onClose, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onClose, { capture: true });
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
