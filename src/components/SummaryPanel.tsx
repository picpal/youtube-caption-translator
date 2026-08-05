import { translationErrorDisplay } from '~/features/translation/error-display';
import { formatTimestamp } from '~/lib/transcript-parse';
import type { SummaryStatus } from '~/features/summary/useSummary';
import type { VideoSummary } from '~/types/summary';

// Section label style matches App.tsx's existing "자막 표시"/"번역 결과"
// micro-labels; row hover/press affordances mirror TranscriptList's rows.
const LABEL_CLS =
  'body-xs font-semibold tracking-wide text-neutral-400 dark:text-neutral-500';

interface SummaryPanelProps {
  summary: VideoSummary | null;
  status: SummaryStatus;
  error: string | null;
  elapsedSeconds: number;
  // Cache-aware retry (fix round, Important #4) — 빈 상태's "요약 생성" and
  // failed's "다시 시도" both use this.
  onGenerate: () => void;
  onSeekSection: (startSec: number) => void;
}

export function SummaryPanel({
  summary,
  status,
  error,
  elapsedSeconds,
  onGenerate,
  onSeekSection,
}: SummaryPanelProps) {
  if (status === 'loading') {
    return <p className="body-md px-4 py-6 text-neutral-400 dark:text-neutral-500">요약 불러오는 중…</p>;
  }

  if (status === 'generating') {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 dark:border-neutral-700 dark:border-t-neutral-200" />
        <p className="body-md text-neutral-500 dark:text-neutral-400">
          요약 생성 중… {elapsedSeconds}초
        </p>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-6">
        <p className="body-lg leading-relaxed text-red-600 dark:text-red-400">
          {translationErrorDisplay(error ?? '')}
        </p>
        <button
          type="button"
          onClick={onGenerate}
          className="rounded-[7px] border border-neutral-200 px-4 py-2 text-[12.5px] font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          다시 시도
        </button>
      </div>
    );
  }

  if (summary === null) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <p className="body-md leading-relaxed text-neutral-500 dark:text-neutral-400">
          이 영상의 핵심 요약을 만들 수 있어요.
          <br />
          문제·핵심 주장·발표 흐름·키워드·결론으로 정리됩니다.
        </p>
        <button
          type="button"
          onClick={onGenerate}
          className="rounded-[7px] bg-neutral-900 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-black dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          요약 생성
        </button>
      </div>
    );
  }

  // fixed bottom-4 '맨 위로' 버튼(h-9)이 결론 블록의 끝부분을 가리므로 하단 패딩을 pb-9로 확보
  return (
    <div className="flex flex-col gap-5 px-4 pb-9 pt-4">
      <span className={LABEL_CLS}>이 영상이 다루는 문제</span>
      <p className="-mt-3 body-lg leading-relaxed text-neutral-800 dark:text-neutral-200">
        {summary.purpose}
      </p>

      <div className="flex flex-col gap-2">
        <span className={LABEL_CLS}>핵심 주장</span>
        {summary.mainArguments.map((arg, i) => (
          <div key={i} className="flex gap-2">
            <span className="body-2xs pt-[2px] font-mono text-neutral-400 dark:text-neutral-500">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="body-lg leading-relaxed text-neutral-800 dark:text-neutral-200">
              {arg}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <span className={LABEL_CLS}>발표 흐름</span>
        {summary.sections.map((section, i) => (
          <div
            key={i}
            role="button"
            tabIndex={0}
            onClick={() => onSeekSection(section.startSec)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSeekSection(section.startSec);
              }
            }}
            className="flex cursor-pointer gap-2.5 border-b border-neutral-100 py-1.5 last:border-b-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900"
          >
            <span className="body-sm w-[3.5em] flex-none font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(section.startSec)}
            </span>
            <span className="body-lg text-neutral-800 dark:text-neutral-200">{section.title}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <span className={LABEL_CLS}>주요 키워드</span>
        <div className="flex flex-wrap gap-1.5">
          {summary.keywords.map((keyword, i) => (
            <span
              key={i}
              className="body-sm rounded border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
            >
              {keyword}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <span className={LABEL_CLS}>결론</span>
        <p className="body-lg leading-relaxed text-neutral-800 dark:text-neutral-200">
          {summary.conclusion}
        </p>
      </div>
    </div>
  );
}
