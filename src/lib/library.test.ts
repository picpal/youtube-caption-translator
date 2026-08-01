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

// 자정 근처 값은 실행 머신의 시간대에 따라 날짜가 하루 밀린다. 정오를 기준으로
// 만들면 어떤 시간대에서 읽어도 같은 날짜로 되돌아온다 — 표시 동작(사용자의
// 시간대 기준 날짜)은 그대로 두고 테스트만 결정적으로 만든다.
const localIso = (year: number, month: number, day: number): string =>
  new Date(year, month - 1, day, 12, 0, 0).toISOString();

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
    updatedAt: localIso(2026, 7, 29),
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
  const now = new Date(2026, 7, 1); // 2026-08-01, local

  it('joins channel, duration, language and date', () => {
    const entry = makeEntry({ channelName: '어떤채널', durationSeconds: 1334, updatedAt: localIso(2026, 7, 29) });
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
    const entry = makeEntry({ updatedAt: localIso(2025, 12, 31) });
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

  // 1048575 = 1024*1024 - 1, 1073741823 = 1024**3 - 1: 반올림하면 다음 단위로
  // 넘어가야 하는 값들. 단위를 원시 바이트로 고르면 "1024 KB"/"1024.0 MB"로
  // 잘못 굳는다(리뷰에서 발견) — 이 경계에서만 표시값 기준 선택이 검증된다.
  it('rolls a value just under 1 MiB up to 1.0 MB, not 1024 KB', () => {
    expect(formatStorageLine(12, { usage: 1048575, quota: 1048575 })).toBe(
      '영상 12편 · 1.0 MB / 1.0 MB',
    );
  });

  it('rolls a value just under 1 GiB up to 1.0 GB, not 1024.0 MB', () => {
    expect(formatStorageLine(12, { usage: 1073741823, quota: 1073741823 })).toBe(
      '영상 12편 · 1.0 GB / 1.0 GB',
    );
  });

  it('floors a small usage value at 1 KB, never 0 KB', () => {
    expect(formatStorageLine(12, { usage: 500, quota: 500 })).toBe('영상 12편 · 1 KB / 1 KB');
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
