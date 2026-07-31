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

  // 바깥 클릭 / Escape로 닫기. 열려 있을 때만 문서 리스너를 붙인다.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
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
    setOpen(false);
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

/** 헤더의 GearIcon과 같은 방식의 인라인 SVG — 아이콘 라이브러리를 추가하지 않는다. */
function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}
