import { formatTimestamp } from '~/lib/transcript-parse';
import { TARGET_LANG_LABELS } from '~/lib/target-lang';
import type { DisplayMode } from '~/components/TranscriptList';
import type { TranslationRecord } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import type { VideoMeta } from '~/types/video';

/** 제목 부분의 최대 길이. videoId는 이 한도 밖에서 항상 온전히 붙는다. */
const MAX_TITLE_CHARS = 80;

export interface ExportInput {
  video: VideoMeta;
  /** 호출자가 `status === 'done'`을 이미 확인한 레코드. */
  record: TranslationRecord;
  /** `null`이면 요약 블록을 통째로 생략한다. */
  summary: VideoSummary | null;
  displayMode: DisplayMode;
  /** 주입받는다 — 이 모듈은 시계를 읽지 않는다(테스트 결정성). */
  exportedAt: Date;
}

export interface ExportSegmentLine {
  segmentId: string;
  startSec: number;
  timestamp: string;
  url: string;
  /** `displayMode === 'ko'`이면 항상 null. */
  sourceText: string | null;
  translatedText: string | null;
}

export interface ExportModel {
  title: string;
  channelName: string | null;
  durationText: string | null;
  videoUrl: string;
  targetLangLabel: string;
  exportedAtText: string;
  summary: VideoSummary | null;
  segments: ExportSegmentLine[];
  fileBaseName: string;
}

export function buildFileBaseName(title: string, videoId: string): string {
  const sanitized = title
    // 윈도우·macOS 파일명 금지문자만 치환한다. 하이픈과 한글은 보존.
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, MAX_TITLE_CHARS);
  return sanitized ? `${sanitized}_${videoId}` : videoId;
}

/** 로컬 시간 기준 `YYYY-MM-DD HH:mm`. */
function formatExportedAt(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function buildExportModel({
  video,
  record,
  summary,
  displayMode,
  exportedAt,
}: ExportInput): ExportModel {
  const videoUrl = `https://youtu.be/${video.videoId}`;
  const showSource = displayMode === 'both';

  const segments: ExportSegmentLine[] = [];
  for (const segment of record.segments) {
    const sourceText = showSource ? segment.sourceText : null;
    // 정정 (최종 리뷰 I4): 'ko' 모드에서 아직 번역되지 않은 세그먼트는 원문을 그
    // 자리에 채운다 — TranscriptList.visibleTexts와 같은 "빈 행 금지" 규칙. 어떤
    // 모드에서도 세그먼트를 건너뛰지 않는다.
    const translatedText = showSource ? segment.translatedText : (segment.translatedText ?? segment.sourceText);
    segments.push({
      segmentId: segment.segmentId,
      startSec: segment.startSec,
      timestamp: formatTimestamp(segment.startSec),
      url: `${videoUrl}?t=${Math.floor(segment.startSec)}`,
      sourceText,
      translatedText,
    });
  }

  return {
    title: video.title,
    channelName: video.channelName,
    durationText: video.durationSeconds === null ? null : formatTimestamp(video.durationSeconds),
    videoUrl,
    targetLangLabel: TARGET_LANG_LABELS[record.targetLang ?? 'ko'],
    exportedAtText: formatExportedAt(exportedAt),
    summary,
    segments,
    fileBaseName: buildFileBaseName(video.title, video.videoId),
  };
}

export function renderMarkdown(model: ExportModel): string {
  const lines: string[] = [`# ${model.title}`, ''];

  // 값이 없는 항목은 구분점째로 빠진다 — "· ·"나 앞뒤에 남는 "·"가 생기지 않도록
  // 존재하는 조각만 모아 join한다.
  const metaParts = [model.channelName, model.durationText, model.videoUrl].filter(
    (part): part is string => part !== null && part !== '',
  );
  lines.push(metaParts.join(' · '));
  lines.push(`번역 ${model.targetLangLabel} · 내보낸 날짜 ${model.exportedAtText}`);
  lines.push('');

  const summary = model.summary;
  if (summary) {
    lines.push('## 요약', '');
    if (summary.purpose) {
      lines.push('### 이 영상이 다루는 문제', summary.purpose, '');
    }
    if (summary.mainArguments.length > 0) {
      lines.push('### 핵심 주장');
      for (const argument of summary.mainArguments) lines.push(`- ${argument}`);
      lines.push('');
    }
    if (summary.sections.length > 0) {
      lines.push('### 발표 흐름');
      for (const section of summary.sections) {
        const at = Math.floor(section.startSec);
        lines.push(`- [${formatTimestamp(section.startSec)}](${model.videoUrl}?t=${at}) ${section.title}`);
      }
      lines.push('');
    }
    if (summary.keywords.length > 0) {
      lines.push('### 키워드', summary.keywords.join(' · '), '');
    }
    if (summary.conclusion) {
      lines.push('### 결론', summary.conclusion, '');
    }
  }

  lines.push('## 스크립트', '');
  for (const segment of model.segments) {
    const head = `**[${segment.timestamp}](${segment.url})**`;
    if (segment.sourceText !== null && segment.translatedText !== null) {
      // 원문 줄 끝의 공백 2칸은 마크다운 hard break — 없으면 렌더러가 원문과 번역을
      // 한 문단으로 이어 붙여 한 줄로 보인다.
      lines.push(`${head} ${segment.sourceText}  `, segment.translatedText, '');
    } else {
      // I4 수정 이후 이 분기에 도달하면 둘 중 정확히 하나만 값을 갖는다 —
      // 'both' 모드는 sourceText가(translatedText가 null), 'ko' 모드는
      // translatedText가(원문 폴백으로 null일 수 없다) 항상 채워진다. 두 값이
      // 동시에 null인 조합은 나오지 않으므로 `?? ''` 최종 폴백은 불필요하다.
      lines.push(`${head} ${segment.sourceText ?? segment.translatedText}`, '');
    }
  }

  return lines.join('\n');
}
