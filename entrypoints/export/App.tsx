import { useEffect, useRef, useState } from 'react';
import { ExportDocument } from '~/components/ExportDocument';
import { buildExportModel } from '~/lib/export-doc';
import type { ExportModel } from '~/lib/export-doc';
import { loadPanelPrefs } from '~/lib/panel-prefs';
import { fetchExportData } from '~/features/export/useExportData';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; model: ExportModel };

export function App() {
  const [state, setState] = useState<PageState>({ status: 'loading' });
  // 인쇄는 딱 한 번만 자동 호출한다. StrictMode의 이중 마운트로 대화상자가 두 번
  // 열리는 것을 막는 가드이기도 하다.
  const printedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const videoId = new URLSearchParams(location.search).get('videoId');
        if (!videoId) {
          setState({ status: 'error', message: '내보낼 영상을 찾지 못했어요.' });
          return;
        }
        const [data, prefs] = await Promise.all([fetchExportData(videoId), loadPanelPrefs()]);
        if (cancelled) return;
        if (data.status !== 'ready') {
          setState({
            status: 'error',
            message:
              data.status === 'unavailable' && data.reason === 'not-done'
                ? '번역이 완료된 뒤에 내보낼 수 있어요.'
                : '내보낼 데이터를 찾지 못했어요.',
          });
          return;
        }
        setState({
          status: 'ready',
          model: buildExportModel({
            video: data.video,
            record: data.record,
            summary: data.summary,
            displayMode: prefs.displayMode,
            exportedAt: new Date(),
          }),
        });
      } catch {
        // loadPanelPrefs 등이 컨텍스트 무효화로 거부될 수 있다 — fetchExportData는
        // 자체적으로 실패를 접지만 Promise.all 전체는 여전히 reject될 수 있어
        // 여기서도 감싼다. 기존 오류 상태로 착지시켜 "불러오는 중…"에 영원히
        // 머무르지 않게 한다.
        if (!cancelled) setState({ status: 'error', message: '내보낼 데이터를 찾지 못했어요.' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.status !== 'ready' || printedRef.current) return;
    printedRef.current = true;
    // 인쇄 대화상자의 기본 파일명은 document.title에서 나온다 — Markdown 쪽
    // 파일명과 같은 문자열을 쓴다.
    document.title = state.model.fileBaseName;
    void document.fonts.ready.then(() => window.print());
  }, [state]);

  if (state.status === 'loading') {
    return <p className="p-8 text-sm text-neutral-500">불러오는 중…</p>;
  }
  if (state.status === 'error') {
    return <p className="p-8 text-sm text-neutral-700">{state.message}</p>;
  }

  return (
    <>
      <div className="no-print sticky top-0 flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-6 py-3 text-[12.5px] text-neutral-700">
        <span>
          인쇄 대화상자에서 <strong>대상 → PDF로 저장</strong>을 선택하세요.
        </span>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-[7px] border border-neutral-300 bg-white px-3 py-1.5 font-semibold hover:bg-neutral-100"
        >
          다시 인쇄
        </button>
      </div>
      <ExportDocument model={state.model} />
    </>
  );
}
