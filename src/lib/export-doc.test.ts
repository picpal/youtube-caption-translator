import { describe, expect, it } from 'vitest';
import { buildExportModel, buildFileBaseName, renderMarkdown } from './export-doc';
import type { ExportInput } from './export-doc';
import type { TranslationRecord, TranscriptSegment } from '~/types/transcript';
import type { VideoSummary } from '~/types/summary';
import type { VideoMeta } from '~/types/video';

const VIDEO_ID = 'zjkBMFhNj_g';
// 로컬 시간 컴포넌트로 만든다(월은 0-based) — UTC 문자열을 쓰면 실행 타임존에 따라
// exportedAtText 검증이 흔들린다.
const EXPORTED_AT = new Date(2026, 6, 31, 19, 20);

const VIDEO: VideoMeta = {
  videoId: VIDEO_ID,
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  title: 'Intro to Large Language Models',
  channelName: 'Andrej Karpathy',
  thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  durationSeconds: 3588,
  captionAvailability: 'auto-only',
  fetchedAt: '2026-07-31T10:00:00.000Z',
};

function seg(index: number, startSec: number, sourceText: string, translatedText: string | null): TranscriptSegment {
  return {
    segmentId: `${VIDEO_ID}:${index}`,
    videoId: VIDEO_ID,
    index,
    startSec,
    endSec: startSec + 10,
    sourceText,
    translatedText,
  };
}

const RECORD: TranslationRecord = {
  videoId: VIDEO_ID,
  captionHash: 'hash',
  sourceLang: 'en',
  status: 'done',
  segments: [
    seg(0, 12, "Let's talk about vector search.", '벡터 검색에 대해 이야기해 봅시다.'),
    seg(1, 3671, 'Embeddings map text to coordinates.', '임베딩은 텍스트를 좌표로 바꿉니다.'),
  ],
  glossary: [],
  completedBatches: 1,
  totalBatches: 1,
  targetLang: 'ko',
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T10:05:00.000Z',
};

const SUMMARY: VideoSummary = {
  videoId: VIDEO_ID,
  purpose: '대규모 언어 모델의 동작 원리를 개괄한다.',
  mainArguments: ['모델은 다음 토큰을 예측한다.', '정렬 단계가 유용성을 만든다.'],
  sections: [{ startSec: 12, title: '도입' }, { startSec: 600, title: '학습 과정' }],
  keywords: ['LLM', '토크나이저'],
  conclusion: '사전학습과 정렬을 나눠 이해하라.',
  model: 'gemini-x',
  targetLang: 'ko',
  createdAt: '2026-07-31T10:10:00.000Z',
};

function input(over: Partial<ExportInput> = {}): ExportInput {
  return { video: VIDEO, record: RECORD, summary: SUMMARY, displayMode: 'both', exportedAt: EXPORTED_AT, ...over };
}

describe('buildFileBaseName', () => {
  it('joins a sanitized title with the videoId', () => {
    expect(buildFileBaseName('Intro to LLMs', VIDEO_ID)).toBe(`Intro_to_LLMs_${VIDEO_ID}`);
  });

  it('replaces filesystem-forbidden characters but keeps hyphens and Hangul', () => {
    expect(buildFileBaseName('a/b:c*d?e"f<g>h|i', VIDEO_ID)).toBe(`a_b_c_d_e_f_g_h_i_${VIDEO_ID}`);
    expect(buildFileBaseName('벡터-검색 입문', VIDEO_ID)).toBe(`벡터-검색_입문_${VIDEO_ID}`);
  });

  it('truncates the title part to 80 chars and always keeps the full videoId', () => {
    const name = buildFileBaseName('x'.repeat(200), VIDEO_ID);
    expect(name).toBe(`${'x'.repeat(80)}_${VIDEO_ID}`);
    expect(name.endsWith(VIDEO_ID)).toBe(true);
  });

  it('falls back to the videoId alone when nothing survives sanitizing', () => {
    expect(buildFileBaseName('///', VIDEO_ID)).toBe(VIDEO_ID);
    expect(buildFileBaseName('   ', VIDEO_ID)).toBe(VIDEO_ID);
  });
});

describe('buildExportModel', () => {
  it("drops sourceText when displayMode is 'ko'", () => {
    const model = buildExportModel(input({ displayMode: 'ko' }));
    expect(model.segments[0].sourceText).toBeNull();
    expect(model.segments[0].translatedText).toBe('벡터 검색에 대해 이야기해 봅시다.');
  });

  it("keeps both texts when displayMode is 'both'", () => {
    const model = buildExportModel(input());
    expect(model.segments[0].sourceText).toBe("Let's talk about vector search.");
    expect(model.segments[0].translatedText).toBe('벡터 검색에 대해 이야기해 봅시다.');
  });

  it('builds a per-segment seek url and a matching timestamp label', () => {
    const model = buildExportModel(input());
    expect(model.segments[0].segmentId).toBe(`${VIDEO_ID}:0`);
    expect(model.segments[0].url).toBe(`https://youtu.be/${VIDEO_ID}?t=12`);
    expect(model.segments[0].timestamp).toBe('0:12');
    expect(model.segments[1].timestamp).toBe('1:01:11');
  });

  it("keeps an untranslated segment's sourceText in 'both' mode; fills it from source in 'ko' mode (I4)", () => {
    const partial = { ...RECORD, segments: [seg(0, 12, 'Only source.', null)] };

    const both = buildExportModel(input({ record: partial })).segments;
    expect(both).toHaveLength(1);
    expect(both[0].sourceText).toBe('Only source.');
    expect(both[0].translatedText).toBeNull();

    // 'ko' 모드도 세그먼트를 생략하지 않는다 — 패널의 "빈 행 금지" 규칙과 동일하게
    // 번역이 없으면 원문을 그 자리에 채운다. sourceText는 여전히 null(ko 모드
    // 규칙)이고, translatedText 쪽에 원문이 들어간다.
    const ko = buildExportModel(input({ record: partial, displayMode: 'ko' })).segments;
    expect(ko).toHaveLength(1);
    expect(ko[0].sourceText).toBeNull();
    expect(ko[0].translatedText).toBe('Only source.');
  });

  it('formats exportedAt from the injected date, not the clock', () => {
    expect(buildExportModel(input()).exportedAtText).toBe('2026-07-31 19:20');
  });

  it('formats a second, different injected date to a different exact output', () => {
    // 위 테스트와 나란히 둬서, 구현이 내부에서 new Date()를 호출해 exportedAt
    // 파라미터를 무시해도 두 값을 동시에 만족시킬 수 없게 한다.
    const other = new Date(2027, 0, 5, 8, 3);
    expect(buildExportModel(input({ exportedAt: other })).exportedAtText).toBe('2027-01-05 08:03');
  });

  it("labels a legacy record with no targetLang as 한국어", () => {
    const legacy = { ...RECORD };
    delete (legacy as { targetLang?: unknown }).targetLang;
    expect(buildExportModel(input({ record: legacy })).targetLangLabel).toBe('한국어');
  });

  it('labels a Japanese record as 일본어', () => {
    expect(buildExportModel(input({ record: { ...RECORD, targetLang: 'ja' } })).targetLangLabel).toBe('일본어');
  });

  it('leaves durationText null when the duration is unknown', () => {
    expect(buildExportModel(input({ video: { ...VIDEO, durationSeconds: null } })).durationText).toBeNull();
  });
});

describe('renderMarkdown', () => {
  it('opens with the title and a meta line without dangling separators', () => {
    const md = renderMarkdown(buildExportModel(input({ video: { ...VIDEO, channelName: null, durationSeconds: null } })));
    expect(md.startsWith('# Intro to Large Language Models\n')).toBe(true);
    expect(md).toContain(`https://youtu.be/${VIDEO_ID}`);
    expect(md).not.toContain('· ·');
    expect(md.split('\n').some((line) => line.trim().startsWith('·') || line.trim().endsWith('·'))).toBe(false);
  });

  it('renders every summary section when a summary exists', () => {
    const md = renderMarkdown(buildExportModel(input()));
    expect(md).toContain('## 요약');
    expect(md).toContain('### 이 영상이 다루는 문제');
    expect(md).toContain('### 핵심 주장');
    expect(md).toContain('- 모델은 다음 토큰을 예측한다.');
    expect(md).toContain('### 발표 흐름');
    expect(md).toContain('### 키워드');
    expect(md).toContain('LLM · 토크나이저');
    expect(md).toContain('### 결론');
  });

  it('omits the whole summary block when there is no summary', () => {
    const md = renderMarkdown(buildExportModel(input({ summary: null })));
    expect(md).not.toContain('## 요약');
    expect(md).toContain('## 스크립트');
  });

  it('omits an empty summary field together with its heading', () => {
    const thin = { ...SUMMARY, mainArguments: [], keywords: [], conclusion: '' };
    const md = renderMarkdown(buildExportModel(input({ summary: thin })));
    expect(md).toContain('### 이 영상이 다루는 문제');
    expect(md).not.toContain('### 핵심 주장');
    expect(md).not.toContain('### 키워드');
    expect(md).not.toContain('### 결론');
  });

  it('ends the source line with a markdown hard break so the translation stays on its own line', () => {
    const md = renderMarkdown(buildExportModel(input()));
    expect(md).toContain(`**[0:12](https://youtu.be/${VIDEO_ID}?t=12)** Let's talk about vector search.  \n벡터 검색에 대해 이야기해 봅시다.`);
  });

  it("writes no trailing hard break when only the translation is present ('ko' mode)", () => {
    const md = renderMarkdown(buildExportModel(input({ displayMode: 'ko' })));
    expect(md).toContain(`**[0:12](https://youtu.be/${VIDEO_ID}?t=12)** 벡터 검색에 대해 이야기해 봅시다.`);
    expect(md).not.toContain('  \n');
  });

  it("renders an untranslated segment's source-text fallback as a single line in 'ko' mode (I4)", () => {
    const partial = { ...RECORD, segments: [seg(0, 12, 'Only source.', null)] };
    const md = renderMarkdown(buildExportModel(input({ record: partial, displayMode: 'ko' })));
    expect(md).toContain(`**[0:12](https://youtu.be/${VIDEO_ID}?t=12)** Only source.`);
    expect(md).not.toContain('  \n');
  });
});
