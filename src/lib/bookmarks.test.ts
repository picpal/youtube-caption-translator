import { describe, expect, it } from 'vitest';
import {
  bookmarkedSegmentIds,
  createExcerptBookmark,
  createRowBookmark,
  findRowBookmark,
  normalizeSelection,
  rowMenuItems,
  sortBookmarks,
} from './bookmarks';
import type { Bookmark } from '~/types/bookmark';
import type { TranscriptSegment } from '~/types/transcript';

function rowBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    bookmarkId: 'bm-1',
    segmentId: 'vid:3',
    startSec: 30,
    createdAt: '2026-08-02T00:00:00.000Z',
    kind: 'row',
    sourceText: 'source',
    translatedText: '번역',
    ...overrides,
  } as Bookmark;
}

function excerptBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    bookmarkId: 'bm-x',
    segmentId: 'vid:3',
    startSec: 30,
    createdAt: '2026-08-02T00:00:00.000Z',
    kind: 'excerpt',
    excerpt: '조각',
    ...overrides,
  } as Bookmark;
}

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    segmentId: 'vid:3',
    videoId: 'vid',
    index: 3,
    startSec: 30.4,
    endSec: 40,
    sourceText: 'the key thing is the softmax',
    translatedText: '핵심은 소프트맥스입니다',
    ...overrides,
  };
}

describe('sortBookmarks', () => {
  it('orders by startSec ascending, not by save order', () => {
    const late = rowBookmark({ bookmarkId: 'late', startSec: 300, createdAt: '2026-08-02T00:00:00.000Z' });
    const early = rowBookmark({ bookmarkId: 'early', startSec: 12, createdAt: '2026-08-02T01:00:00.000Z' });

    expect(sortBookmarks([late, early]).map((b) => b.bookmarkId)).toEqual(['early', 'late']);
  });

  it('breaks a startSec tie by createdAt ascending', () => {
    const second = excerptBookmark({ bookmarkId: 'second', createdAt: '2026-08-02T02:00:00.000Z' });
    const first = excerptBookmark({ bookmarkId: 'first', createdAt: '2026-08-02T01:00:00.000Z' });

    expect(sortBookmarks([second, first]).map((b) => b.bookmarkId)).toEqual(['first', 'second']);
  });

  it('does not mutate its input', () => {
    const input = [rowBookmark({ startSec: 90 }), rowBookmark({ bookmarkId: 'bm-2', startSec: 10 })];
    sortBookmarks(input);
    expect(input[0].startSec).toBe(90);
  });
});

describe('bookmarkedSegmentIds', () => {
  it('collects only row bookmarks', () => {
    // 조각만 저장한 행의 ☆는 비어 있어야 한다 — 그 행을 통째로는 저장하지 않았다.
    const ids = bookmarkedSegmentIds([
      rowBookmark({ segmentId: 'vid:1' }),
      excerptBookmark({ segmentId: 'vid:9' }),
    ]);
    expect([...ids]).toEqual(['vid:1']);
  });

  it('is empty for an empty list', () => {
    expect(bookmarkedSegmentIds([]).size).toBe(0);
  });
});

describe('findRowBookmark', () => {
  it('finds the row bookmark for a segment', () => {
    const row = rowBookmark({ segmentId: 'vid:5' });
    expect(findRowBookmark([excerptBookmark(), row], 'vid:5')).toBe(row);
  });

  it('ignores an excerpt on the same segment', () => {
    expect(findRowBookmark([excerptBookmark({ segmentId: 'vid:5' })], 'vid:5')).toBeNull();
  });

  it('returns null when the segment has nothing', () => {
    expect(findRowBookmark([rowBookmark()], 'vid:99')).toBeNull();
  });
});

describe('createRowBookmark', () => {
  it('snapshots both texts and floors startSec to whole seconds', () => {
    const created = createRowBookmark(segment(), 'bm-new', new Date('2026-08-02T03:04:05.000Z'));

    expect(created).toEqual({
      bookmarkId: 'bm-new',
      segmentId: 'vid:3',
      // 30.4 -> 30. 시크와 내보내기 링크가 같은 정수를 쓰게 여기서 한 번만 자른다.
      startSec: 30,
      createdAt: '2026-08-02T03:04:05.000Z',
      kind: 'row',
      sourceText: 'the key thing is the softmax',
      translatedText: '핵심은 소프트맥스입니다',
    });
  });

  it('keeps translatedText null for a segment that is not translated yet', () => {
    const created = createRowBookmark(segment({ translatedText: null }), 'bm-new', new Date(0));
    if (created.kind !== 'row') throw new Error('expected a row bookmark');
    expect(created.translatedText).toBeNull();
    expect(created.sourceText).toBe('the key thing is the softmax');
  });

  it('records the targetLang the panel was set to at save time (finding M1)', () => {
    const created = createRowBookmark(segment(), 'bm-new', new Date('2026-08-02T03:04:05.000Z'), 'ja');
    expect(created.targetLang).toBe('ja');
  });
});

describe('createExcerptBookmark', () => {
  it('stores the selected text and the row s timestamp', () => {
    const created = createExcerptBookmark(segment(), '  the softmax  ', 'bm-x', new Date('2026-08-02T00:00:00.000Z'));

    expect(created).toEqual({
      bookmarkId: 'bm-x',
      segmentId: 'vid:3',
      startSec: 30,
      createdAt: '2026-08-02T00:00:00.000Z',
      kind: 'excerpt',
      // 앞뒤 공백은 저장 전에 털어낸다 — 드래그 선택은 거의 항상 공백을 물고 온다.
      excerpt: 'the softmax',
    });
  });

  it('records the targetLang the panel was set to at save time (finding M1)', () => {
    const created = createExcerptBookmark(
      segment(),
      'the softmax',
      'bm-x',
      new Date('2026-08-02T00:00:00.000Z'),
      'zh',
    );
    expect(created.targetLang).toBe('zh');
  });
});

describe('normalizeSelection', () => {
  it('returns null for nothing selected', () => {
    expect(normalizeSelection(null)).toBeNull();
    expect(normalizeSelection(undefined)).toBeNull();
  });

  it('returns null for whitespace-only selection', () => {
    // 행을 그냥 클릭해도 브라우저가 빈 Selection을 남긴다 — 그걸 조각으로 보면 안 된다.
    expect(normalizeSelection('   \n  ')).toBeNull();
  });

  it('trims a real selection', () => {
    expect(normalizeSelection(' the softmax ')).toBe('the softmax');
  });
});

describe('rowMenuItems', () => {
  it('offers saving when the row is not saved and nothing is selected', () => {
    expect(rowMenuItems({ saved: false, selectionText: null })).toEqual([
      { action: 'save-row', label: '이 문장 기억하기' },
    ]);
  });

  it('offers removing when the row is already saved', () => {
    expect(rowMenuItems({ saved: true, selectionText: null })).toEqual([
      { action: 'remove-row', label: '기억 해제' },
    ]);
  });

  it('adds the excerpt item when there is a selection', () => {
    expect(rowMenuItems({ saved: false, selectionText: 'the softmax' })).toEqual([
      { action: 'save-row', label: '이 문장 기억하기' },
      { action: 'save-excerpt', label: '선택한 부분만 기억하기' },
    ]);
  });

  it('offers both removing and excerpting on a saved row with a selection', () => {
    expect(rowMenuItems({ saved: true, selectionText: 'the softmax' })).toEqual([
      { action: 'remove-row', label: '기억 해제' },
      { action: 'save-excerpt', label: '선택한 부분만 기억하기' },
    ]);
  });
});
