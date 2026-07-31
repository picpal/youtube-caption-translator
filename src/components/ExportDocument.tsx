import type { ExportModel } from '~/lib/export-doc';

/**
 * 화면과 인쇄에 같은 마크업을 쓴다. 인쇄 규칙은 이 파일 안의 <style>로만 둔다 —
 * Tailwind의 print: 변형으로는 @page 여백과 break-inside를 표현할 수 없다.
 */
export function ExportDocument({ model }: { model: ExportModel }) {
  const metaParts = [model.channelName, model.durationText].filter(
    (part): part is string => part !== null && part !== '',
  );

  return (
    <article className="mx-auto max-w-[760px] px-6 py-8 text-[13px] leading-relaxed text-neutral-900">
      <style>{PRINT_CSS}</style>

      <h1 className="text-[20px] font-bold leading-snug">{model.title}</h1>
      <p className="mt-1 text-[12px] text-neutral-600">
        {metaParts.join(' · ')}
        {metaParts.length > 0 ? ' · ' : ''}
        <a href={model.videoUrl}>{model.videoUrl}</a>
      </p>
      <p className="mt-0.5 text-[12px] text-neutral-600">
        번역 {model.targetLangLabel} · 내보낸 날짜 {model.exportedAtText}
      </p>

      {model.summary && (
        <section className="mt-7">
          <h2 className="text-[16px] font-bold">요약</h2>
          {model.summary.purpose && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">이 영상이 다루는 문제</h3>
              <p className="mt-1">{model.summary.purpose}</p>
            </>
          )}
          {model.summary.mainArguments.length > 0 && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">핵심 주장</h3>
              <ul className="mt-1 list-disc pl-5">
                {model.summary.mainArguments.map((argument, i) => (
                  <li key={i}>{argument}</li>
                ))}
              </ul>
            </>
          )}
          {model.summary.sections.length > 0 && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">발표 흐름</h3>
              <ul className="mt-1 list-disc pl-5">
                {model.summary.sections.map((section, i) => (
                  <li key={i}>
                    <a href={`${model.videoUrl}?t=${Math.floor(section.startSec)}`}>{section.title}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {model.summary.keywords.length > 0 && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">키워드</h3>
              <p className="mt-1">{model.summary.keywords.join(' · ')}</p>
            </>
          )}
          {model.summary.conclusion && (
            <>
              <h3 className="mt-4 text-[13.5px] font-semibold">결론</h3>
              <p className="mt-1">{model.summary.conclusion}</p>
            </>
          )}
        </section>
      )}

      <section className="mt-7">
        <h2 className="text-[16px] font-bold">스크립트</h2>
        <div className="mt-3">
          {model.segments.map((segment) => (
            <div key={segment.startSec} className="seg mb-3">
              <a href={segment.url} className="mr-2 font-mono text-[11.5px] text-neutral-500">
                [{segment.timestamp}]
              </a>
              {segment.sourceText !== null && <span>{segment.sourceText}</span>}
              {segment.sourceText !== null && segment.translatedText !== null && <br />}
              {segment.translatedText !== null && <span>{segment.translatedText}</span>}
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}

const PRINT_CSS = `
  @page { margin: 14mm; }
  a { color: inherit; text-decoration: none; }
  @media print {
    .no-print { display: none !important; }
    .seg { break-inside: avoid; }
    h2, h3 { break-after: avoid; }
  }
`;
