import { useEffect, useMemo, useState } from 'react';
import { StatusBadge } from '~/components/StatusBadge';
import {
  entryBadge,
  filterLibrary,
  formatCountLabel,
  formatEntryMeta,
  formatStorageLine,
  matchedKeywords,
  type StorageEstimateLike,
} from '~/lib/library';
import { sendMessage } from '~/lib/messaging';
import type { LibraryEntry } from '~/types/library';

/**
 * 지금까지 자막을 만든 영상 목록 (spec 2026-08-01). 이 컴포넌트는 판단을 하지
 * 않는다 — 필터·뱃지·표기 결정은 전부 `~/lib/library`의 순수 함수가 내리고
 * 여기서는 그 결과를 그린다. 이 저장소에 컴포넌트 렌더 테스트 하니스가 없기
 * 때문에 세운 규율이다.
 */
export function LibraryView({ onOpenVideo }: { onOpenVideo: (videoId: string) => void }) {
  // `null` = 아직 안 불러옴. 빈 배열(정말 하나도 없음)과 구분해야 빈 상태 문구를
  // 로딩 중에 잘못 띄우지 않는다.
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [storage, setStorage] = useState<StorageEstimateLike | null>(null);

  useEffect(() => {
    let cancelled = false;
    void sendMessage({ type: 'GET_LIBRARY' }).then((list) => {
      if (!cancelled) setEntries(list);
    });
    // 사이드패널은 확장과 같은 오리진이라 background를 경유할 이유가 없다.
    // 거부되면 편수만 보여준다 (formatStorageLine이 null을 그렇게 다룬다).
    void navigator.storage
      ?.estimate()
      .then((estimate) => {
        if (!cancelled) setStorage(estimate);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 날짜 표기가 "올해면 연도 생략"이라 기준 시각이 필요하다. 마운트 시점에 한 번
  // 고정한다 — 렌더마다 new Date()를 만들면 useMemo가 매번 무효화된다.
  const now = useMemo(() => new Date(), []);
  const shown = useMemo(() => (entries === null ? [] : filterLibrary(entries, query)), [entries, query]);

  if (entries === null) {
    return <p className="p-6 text-sm text-neutral-500 dark:text-neutral-400">불러오는 중…</p>;
  }

  if (entries.length === 0) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 pt-10 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">아직 저장한 영상이 없어요</p>
        <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          유튜브 영상에서 AI 자막을 만들면 여기에 쌓입니다
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 pt-4">
        <h2 className="text-sm font-semibold">저장한 영상</h2>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {formatCountLabel(shown.length, entries.length)}
        </span>
      </div>

      <div className="px-4 pt-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="제목이나 키워드로 검색"
          aria-label="저장한 영상 검색"
          className="w-full rounded-[7px] border border-neutral-200 bg-white px-3 py-2 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
        />
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
          검색 결과가 없어요
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900">
          {shown.map((entry) => (
            <LibraryRow
              key={entry.videoId}
              entry={entry}
              query={query}
              now={now}
              onOpen={() => onOpenVideo(entry.videoId)}
            />
          ))}
        </ul>
      )}

      <p className="px-4 py-4 text-[10.5px] text-neutral-500 dark:text-neutral-400">
        {formatStorageLine(entries.length, storage)}
      </p>
    </div>
  );
}

function LibraryRow({
  entry,
  query,
  now,
  onOpen,
}: {
  entry: LibraryEntry;
  query: string;
  now: Date;
  onOpen: () => void;
}) {
  const badge = entryBadge(entry.status);
  const keywords = matchedKeywords(entry, query);

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <img
          src={entry.thumbnailUrl}
          alt=""
          width={64}
          height={36}
          className="mt-0.5 h-9 w-16 shrink-0 rounded object-cover"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className="line-clamp-2 text-[12.5px] font-medium leading-snug text-neutral-900 dark:text-neutral-100">
              {entry.title}
            </span>
            {badge !== null && (
              <span className="shrink-0">
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
              </span>
            )}
          </span>
          <span className="mt-1 block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
            {formatEntryMeta(entry, now)}
          </span>
          {keywords.length > 0 && (
            <span className="mt-1 block truncate text-[11px] text-neutral-600 dark:text-neutral-300">
              {keywords.join(' · ')}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
