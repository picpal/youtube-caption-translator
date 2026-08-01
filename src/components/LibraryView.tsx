import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '~/components/Button';
import { StatusBadge } from '~/components/StatusBadge';
import {
  deleteErrorMessage,
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
  // `GET_LIBRARY`가 거부되면(서비스워커가 아직 안 깨어있어 "Receiving end does
  // not exist" 등) `entries`는 영원히 null로 남는다 — "불러오는 중"과 구분해야
  // 무한 로딩 대신 재시도 방법을 보여줄 수 있다. 빈 배열로 대체하지 않는 이유:
  // 그러면 "아직 저장한 영상이 없어요"가 뜨는데, 실제로는 있는지 없는지 몰라서
  // 못 물어본 것뿐이다 — `durationSeconds`가 null일 때 0:00을 안 찍는 것과 같은
  // 규율이다.
  const [loadFailed, setLoadFailed] = useState(false);
  // 재시도 버튼이 아래 effect를 다시 돌리게 하는 가장 단순한 방법 — 값 자체는
  // 쓰지 않고 의존성 배열만 바꾼다.
  const [reloadToken, setReloadToken] = useState(0);
  // 한 번에 한 행만 확인 상태다 — 다른 행의 휴지통을 누르면 이전 확인은 닫힌다.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ videoId: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    void sendMessage({ type: 'GET_LIBRARY' })
      .then((res) => {
        if (cancelled) return;
        // `res.ok === false` means the read itself failed (see message.ts's
        // GET_LIBRARY doc comment) — same retry path as a rejected
        // sendMessage below, not a second error surface.
        if (res.ok) {
          setEntries(res.entries);
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
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
  }, [reloadToken]);

  // 날짜 표기가 "올해면 연도 생략"이라 기준 시각이 필요하다. 마운트 시점에 한 번
  // 고정한다 — 렌더마다 new Date()를 만들면 useMemo가 매번 무효화된다.
  const now = useMemo(() => new Date(), []);
  const remove = async (videoId: string) => {
    setFailure(null);
    const res = await sendMessage({ type: 'DELETE_LIBRARY_ENTRY', payload: { videoId } });
    setConfirmingId(null);
    if (res.ok) {
      // 낙관적 제거가 아니라 응답 이후 제거다 — 전체 재조회는 필요 없다.
      setEntries((prev) => (prev === null ? prev : prev.filter((e) => e.videoId !== videoId)));
      return;
    }
    // 가장 흔한 실패는 진행 중 거부다(background가 `job in flight`로 답한다).
    // 목록은 그대로 두고 그 행에만 사유를 띄운다.
    setFailure({ videoId, message: deleteErrorMessage(res.error) });
  };
  const shown = useMemo(() => (entries === null ? [] : filterLibrary(entries, query)), [entries, query]);

  if (loadFailed) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 pt-10 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">목록을 불러오지 못했어요</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setEntries(null);
            setLoadFailed(false);
            setReloadToken((token) => token + 1);
          }}
        >
          다시 시도
        </Button>
      </div>
    );
  }

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
              confirming={confirmingId === entry.videoId}
              failedMessage={failure?.videoId === entry.videoId ? failure.message : null}
              onOpen={() => onOpenVideo(entry.videoId)}
              onAskDelete={() => setConfirmingId(entry.videoId)}
              onCancelDelete={() => setConfirmingId(null)}
              onConfirmDelete={() => void remove(entry.videoId)}
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
  confirming,
  failedMessage,
  onOpen,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  entry: LibraryEntry;
  query: string;
  now: Date;
  confirming: boolean;
  failedMessage: string | null;
  onOpen: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const badge = entryBadge(entry.status);
  const keywords = matchedKeywords(entry, query);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 확인 단계에 들어가면 포커스를 [취소]로 보낸다. [삭제]에 두면 엔터를 한 번 더
  // 누르는 것만으로 지워지는데, 이 삭제는 되돌릴 수 없고 재생성에 5~8분과 Gemini
  // 호출이 다시 든다.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
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

        {entry.inFlight ? (
          // 진행 중에는 지울 수 없다 — 번역 도중 레코드가 사라지면 다음
          // upsertBatch가 트랜잭션을 abort시켜 파이프라인이 이유 없이 죽는다.
          // background도 같은 검사를 독립적으로 한다(이 값은 목록을 읽은 시점의
          // 스냅샷이라 낡을 수 있다).
          <span
            className="shrink-0 p-1 text-neutral-300 dark:text-neutral-700"
            title="진행 중에는 지울 수 없어요"
            aria-label="진행 중에는 지울 수 없어요"
          >
            <TrashIcon />
          </span>
        ) : (
          <button
            type="button"
            onClick={onAskDelete}
            aria-label="자막 삭제"
            className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {confirming && (
        // Escape를 이 컨테이너에서 받는다 — 키 이벤트가 버블링되므로 [삭제]에
        // 포커스가 가 있어도 동작한다.
        <div
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancelDelete();
          }}
          className="mt-2 flex items-center justify-between gap-2 rounded-[7px] bg-neutral-50 px-3 py-2 dark:bg-neutral-900"
        >
          <span className="text-[11px] text-neutral-700 dark:text-neutral-300">
            이 영상의 자막을 지울까요?
          </span>
          <span className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={onConfirmDelete}
              className="rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
            >
              삭제
            </button>
            <button
              type="button"
              ref={cancelRef}
              onClick={onCancelDelete}
              className="rounded px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              취소
            </button>
          </span>
        </div>
      )}

      {failedMessage !== null && (
        <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{failedMessage}</p>
      )}
    </li>
  );
}

/** 헤더 아이콘들과 같은 방식의 인라인 SVG. */
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}
