import { Button } from '~/components/Button';
import type { UnsupportedReason } from '~/types/video';

export interface UnsupportedBannerProps {
  reason: UnsupportedReason;
  /**
   * Present only for the two genuine-failure reasons (`restricted`,
   * `no-metadata`) — see the retry button rendering below. Ignored for
   * `shorts`/`live`, which are out-of-scope-by-design, not failures, and so
   * never offer a retry regardless of whether a handler is passed.
   */
  onRetry?: () => void;
}

// Wording matters here (see task-10-brief.md): `shorts`/`live` are stated
// matter-of-factly as out of scope by design (PRD §7.1) — this tool is for
// talks/lectures, not Shorts/live — not apologized for as if they were bugs.
// `restricted`/`no-metadata` are genuine failures, plainly named as such.
const COPY: Record<UnsupportedReason, string> = {
  shorts: '쇼츠는 지원하지 않습니다 — 강연·강의 영상 전용 도구입니다',
  live: '라이브 방송은 지원하지 않습니다 — 다시보기(VOD) 영상에서 이용해주세요',
  restricted: '연령 제한 또는 지역 제한 영상은 불러올 수 없습니다',
  'no-metadata': '영상 정보를 불러오지 못했습니다',
};

// Only the two genuine-failure reasons ever offer a retry — `shorts`/`live`
// are not failures, so there is nothing to retry.
const RETRYABLE: ReadonlySet<UnsupportedReason> = new Set(['restricted', 'no-metadata']);

/**
 * Design pattern source: entrypoints/sidepanel/App.tsx's `NonYoutubeBody` —
 * same centered, single-line, no-decoration layout, reused here so all of
 * the panel's "nothing to show" states read as one family.
 */
export function UnsupportedBanner({ reason, onRetry }: UnsupportedBannerProps) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 pt-10 text-center">
      <p className="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
        {COPY[reason]}
      </p>
      {RETRYABLE.has(reason) && onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          다시 시도
        </Button>
      ) : null}
    </div>
  );
}
