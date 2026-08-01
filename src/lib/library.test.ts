import { describe, expect, it } from 'vitest';
import type { LibraryEntry } from '~/types/library';
import {
  MAX_MATCHED_KEYWORDS,
  deleteErrorMessage,
  entryBadge,
  filterLibrary,
  formatCountLabel,
  formatEntryMeta,
  formatStorageLine,
  matchedKeywords,
} from './library';

function makeEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    videoId: 'abc123',
    title: 'Attention Is All You Need 해설',
    channelName: '어떤채널',
    thumbnailUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
    durationSeconds: 1334,
    status: 'done',
    targetLang: 'ko',
    segmentCount: 142,
    keywords: ['transformer', 'attention'],
    hasSummary: true,
    updatedAt: '2026-07-29T04:05:06.000Z',
    inFlight: false,
    ...overrides,
  };
}

describe('filterLibrary', () => {
  it('returns everything for an empty query', () => {
    const entries = [makeEntry(), makeEntry({ videoId: 'b' })];
    expect(filterLibrary(entries, '')).toEqual(entries);
  });

  it('returns everything for a whitespace-only query', () => {
    const entries = [makeEntry()];
    expect(filterLibrary(entries, '   ')).toEqual(entries);
  });

  it('matches a substring of the title', () => {
    const entries = [makeEntry({ videoId: 'a', title: 'Rust 비동기 런타임' }), makeEntry({ videoId: 'b', title: 'Go 스케줄러' })];
    expect(filterLibrary(entries, '비동기').map((e) => e.videoId)).toEqual(['a']);
  });

  it('matches a keyword even when the title does not contain it', () => {
    const entries = [
      makeEntry({ videoId: 'a', title: '제목에 없음', keywords: ['tokio'] }),
      makeEntry({ videoId: 'b', title: '제목에 없음', keywords: ['gRPC'] }),
    ];
    expect(filterLibrary(entries, 'tokio').map((e) => e.videoId)).toEqual(['a']);
  });

  it('ignores case on both sides', () => {
    const entries = [makeEntry({ title: 'Attention Is All You Need 해설' })];
    expect(filterLibrary(entries, 'ATTENTION')).toHaveLength(1);
    expect(filterLibrary([makeEntry({ title: 'x', keywords: ['Transformer'] })], 'transformer')).toHaveLength(1);
  });

  it('drops entries that match neither title nor keywords', () => {
    expect(filterLibrary([makeEntry()], '전혀없는말')).toEqual([]);
  });

  it('trims the query before comparing', () => {
    expect(filterLibrary([makeEntry({ title: 'Rust' })], '  rust  ')).toHaveLength(1);
  });
});

describe('matchedKeywords', () => {
  it('returns only the keywords that matched', () => {
    const entry = makeEntry({ keywords: ['tokio', 'executor', 'async'] });
    expect(matchedKeywords(entry, 'to')).toEqual(['tokio', 'executor']);
  });

  it('returns an empty array for an empty query', () => {
    expect(matchedKeywords(makeEntry(), '')).toEqual([]);
  });

  it('returns an empty array when only the title matched', () => {
    const entry = makeEntry({ title: 'Rust 런타임', keywords: ['tokio'] });
    expect(matchedKeywords(entry, 'rust')).toEqual([]);
  });

  it(`caps the result at ${MAX_MATCHED_KEYWORDS}`, () => {
    const entry = makeEntry({ keywords: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    expect(matchedKeywords(entry, 'a')).toHaveLength(MAX_MATCHED_KEYWORDS);
  });
});

describe('entryBadge', () => {
  it('has no badge for a finished translation', () => {
    expect(entryBadge('done')).toBeNull();
  });

  it('marks a failed translation', () => {
    expect(entryBadge('failed')).toEqual({ tone: 'error', label: '실패' });
  });

  it('marks a running translation', () => {
    expect(entryBadge('analyzing')).toEqual({ tone: 'warn', label: '진행 중' });
    expect(entryBadge('translating')).toEqual({ tone: 'warn', label: '진행 중' });
  });

  it('falls back to 미완료 for the statuses the pipeline never persists', () => {
    expect(entryBadge('idle')).toEqual({ tone: 'muted', label: '미완료' });
    expect(entryBadge('extracting')).toEqual({ tone: 'muted', label: '미완료' });
  });
});

describe('formatEntryMeta', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');

  it('joins channel, duration, language and date', () => {
    const entry = makeEntry({ channelName: '어떤채널', durationSeconds: 1334, updatedAt: '2026-07-29T04:05:06.000Z' });
    expect(formatEntryMeta(entry, now)).toBe('어떤채널 · 22:14 · 한국어 · 7월 29일');
  });

  it('omits the duration entirely when it is null', () => {
    // VideoMeta.durationSeconds의 null 규약: 0:00은 확신에 찬 거짓말이다.
    const entry = makeEntry({ durationSeconds: null });
    expect(formatEntryMeta(entry, now)).toBe('어떤채널 · 한국어 · 7월 29일');
  });

  it('omits the channel when it is null', () => {
    const entry = makeEntry({ channelName: null });
    expect(formatEntryMeta(entry, now)).toBe('22:14 · 한국어 · 7월 29일');
  });

  it('spells out the year for an entry from another year', () => {
    const entry = makeEntry({ updatedAt: '2025-12-31T04:00:00.000Z' });
    expect(formatEntryMeta(entry, now)).toContain('2025년 12월 31일');
  });

  it('uses the record language, not always Korean', () => {
    expect(formatEntryMeta(makeEntry({ targetLang: 'ja' }), now)).toContain('일본어');
  });
});

describe('formatCountLabel', () => {
  it('shows just the total when nothing is filtered out', () => {
    expect(formatCountLabel(12, 12)).toBe('12편');
  });

  it('shows shown / total while searching', () => {
    expect(formatCountLabel(3, 12)).toBe('3 / 12편');
  });
});

describe('formatStorageLine', () => {
  it('shows the count with usage and quota', () => {
    expect(formatStorageLine(12, { usage: 2202009, quota: 10995116277 })).toBe(
      '영상 12편 · 2.1 MB / 10.2 GB',
    );
  });

  it('falls back to the count alone when the estimate is unavailable', () => {
    expect(formatStorageLine(12, null)).toBe('영상 12편');
  });

  it('falls back to the count alone when the estimate has no numbers', () => {
    expect(formatStorageLine(12, {})).toBe('영상 12편');
  });
});

describe('deleteErrorMessage', () => {
  it('explains the in-flight refusal in the user\'s own terms', () => {
    expect(deleteErrorMessage('job in flight')).toBe(
      '진행 중이라 지울 수 없어요. 끝난 뒤에 다시 시도해주세요',
    );
  });

  it('falls back for any other reason rather than claiming a wrong cause', () => {
    expect(deleteErrorMessage('some IDB failure')).toBe('지우지 못했어요. 다시 시도해주세요');
  });
});
