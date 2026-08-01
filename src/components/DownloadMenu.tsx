import { useEffect, useRef, useState } from 'react';
import { buildExportModel, renderMarkdown } from '~/lib/export-doc';
import { loadPanelPrefs } from '~/lib/panel-prefs';
import { useExportData } from '~/features/export/useExportData';
import type { ExportDataState } from '~/features/export/useExportData';

/**
 * 헤더의 내려받기 버튼. 열릴 때만 데이터를 읽고(`useExportData(open)`), 두 포맷 중
 * 하나를 고르게 한다. Markdown은 이 자리에서 Blob으로 바로 저장하고, PDF는 인쇄용
 * 확장 페이지를 새 탭으로 연다 — 두 경로 모두 새 권한을 쓰지 않는다.
 */
export function DownloadMenu() {
  const [open, setOpen] = useState(false);
  const data = useExportData(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 열렸었는지 추적 — 마운트 시(open이 처음부터 false)는 트리거로 포커스를
  // 되돌리지 않기 위해서다.
  const wasOpenRef = useRef(false);

  // 포커스 관리(spec §4): 열릴 때 첫 항목으로, 닫힐 때(항목 선택·바깥 클릭·
  // Escape 무관) 트리거로 되돌린다. 항목 선택은 그 버튼 자체를 언마운트하므로
  // 여기서 한 곳에 모아 처리한다.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
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

  const ready = data.status === 'ready';

  const downloadMarkdown = async () => {
    if (data.status !== 'ready') return;
    try {
      const { displayMode } = await loadPanelPrefs();
      const model = buildExportModel({
        video: data.video,
        record: data.record,
        summary: data.summary,
        displayMode,
        exportedAt: new Date(),
      });
      const blob = new Blob([renderMarkdown(model)], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${model.fileBaseName}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      // loadPanelPrefs가 컨텍스트 무효화 등으로 거부되면 메뉴만 닫는다 — 클릭이
      // 조용히 아무 일도 하지 않는 것보다는 낫다.
    } finally {
      setOpen(false);
    }
  };

  const openPrintPage = () => {
    if (data.status !== 'ready') return;
    void chrome.tabs.create({
      url: chrome.runtime.getURL(`export.html?videoId=${encodeURIComponent(data.video.videoId)}`),
    });
    setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="내려받기"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded p-1 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        <DownloadIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-[7px] border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          <MenuItem disabled={!ready} onClick={downloadMarkdown}>
            Markdown (.md)
          </MenuItem>
          <MenuItem disabled={!ready} onClick={openPrintPage}>
            PDF (인쇄)
          </MenuItem>
          <p className="border-t border-neutral-100 px-3 py-2 text-[10.5px] leading-relaxed text-neutral-500 dark:border-neutral-900 dark:text-neutral-400">
            {hintFor(data)}
          </p>
        </div>
      )}
    </div>
  );
}

function hintFor(data: ExportDataState): string {
  if (data.status === 'loading') return '확인 중…';
  if (data.status === 'unavailable') {
    return data.reason === 'not-done' ? '번역 완료 후 내려받을 수 있어요' : '영상을 인식하지 못했어요';
  }
  return data.summary ? '스크립트와 요약이 함께 담깁니다' : '요약 없음 — 스크립트만 포함';
}

function MenuItem({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="block w-full px-3 py-2 text-left text-[12px] text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-400 dark:text-neutral-200 dark:hover:bg-neutral-900 dark:disabled:text-neutral-600"
    >
      {children}
    </button>
  );
}

/** 헤더의 GearIcon과 같은 방식의 인라인 SVG — 아이콘 라이브러리를 추가하지 않는다.
 * viewBox는 표준 "0 0 24 24"가 아니라 "3 2 18 19"(경로 잉크박스)다. GearIcon은 전체 24×24를
 * 채우지만 이 다운로드 화살표는 3 2 18 19만 차지해서, viewBox를 크롭하면 렌더 박스가 거의 같은
 * 크기에서 두 아이콘의 시각적 크기가 맞는다 — 보정하지 않으면 다운로드 아이콘이 작아 보인다.
 * 렌더 박스는 다른 헤더 아이콘(18×18)보다 1px 작은 17×17 — 크롭 보정이 살짝 과해서 줄였다.
 */
function DownloadIcon() {
  return (
    <svg width="17" height="17" viewBox="3 2 18 19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}
