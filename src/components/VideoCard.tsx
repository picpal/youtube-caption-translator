import { useState } from 'react';
import type { ExtractedVideoMeta } from '~/lib/video-meta';
import type { CaptionAvailability } from '~/types/video';

export interface VideoCardProps {
  /**
   * The active tab's video record. `null` before any metadata has arrived at
   * all (first paint, or a non-video tab that hasn't been filtered out by
   * the caller yet) — VideoCard renders a loading skeleton in that case
   * rather than flashing placeholder text like the M0 markup did.
   */
  video: ExtractedVideoMeta | null;
  /**
   * True while `video` (when present) is still a `provisional` report — see
   * `useCurrentVideo`'s doc comment. Used only to decide what a `null`
   * `durationSeconds` means: `loading` -> still pending behind e.g. a
   * pre-roll ad (show a subtle "checking" placeholder instead of a badge);
   * not `loading` -> settled, meaning genuinely unknown or live (omit the
   * badge entirely rather than lying with `0:00`).
   *
   * `channelName` and `captionAvailability` are rendered the same way
   * regardless of this flag: their own `null` already means "ask again
   * later" independent of the report's overall status.
   */
  loading: boolean;
}

/**
 * Design source: docs/design/extension-popup.dc.html, the "READY · LIGHT"
 * block — thumbnail + duration badge, two-line-clamped title, channel, and
 * the caption-availability bar. Ported 1:1 in structure from the inline
 * markup entrypoints/sidepanel/App.tsx's `ReadyBody` used to hardcode as M0
 * placeholders (see that file's history / the M0 placeholder table in
 * .superpowers/sdd/2026-07-27-m1-video-recognition/task-9-brief.md).
 */
export function VideoCard({ video, loading }: VideoCardProps) {
  if (!video) {
    return (
      <>
        <div className="flex gap-3 px-4 pb-3.5 pt-4">
          <div className="h-[54px] w-24 flex-none rounded-[5px] bg-[repeating-linear-gradient(135deg,#eceef0_0_6px,#e3e6e9_6px_12px)] dark:bg-[repeating-linear-gradient(135deg,#2a2d31_0_6px,#23262a_6px_12px)]" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[13px] font-semibold leading-snug text-neutral-500 dark:text-neutral-400">
              영상 정보 로딩 중
            </span>
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">—</span>
          </div>
        </div>
        <CaptionBar availability={null} />
      </>
    );
  }

  return (
    <>
      <div className="flex gap-3 px-4 pb-3.5 pt-4">
        <Thumbnail
          thumbnailUrl={video.thumbnailUrl}
          title={video.title}
          durationSeconds={video.durationSeconds}
          durationPending={loading}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
            {video.title}
          </span>
          {video.channelName ? (
            <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              {video.channelName}
            </span>
          ) : (
            <span className="truncate text-[11px] italic text-neutral-400 dark:text-neutral-500">
              채널 확인 중…
            </span>
          )}
        </div>
      </div>

      <CaptionBar availability={video.captionAvailability} />
    </>
  );
}

function Thumbnail({
  thumbnailUrl,
  title,
  durationSeconds,
  durationPending,
}: {
  thumbnailUrl: string;
  title: string;
  durationSeconds: number | null;
  durationPending: boolean;
}) {
  // `thumbnailUrl` is derived from the video id and has never been verified
  // to resolve over HTTP (see video-meta.ts) — fall back to the striped
  // placeholder background instead of a broken-image glyph on a 404.
  const [broken, setBroken] = useState(false);

  return (
    <div className="relative h-[54px] w-24 flex-none overflow-hidden rounded-[5px] bg-[repeating-linear-gradient(135deg,#eceef0_0_6px,#e3e6e9_6px_12px)] dark:bg-[repeating-linear-gradient(135deg,#2a2d31_0_6px,#23262a_6px_12px)]">
      {!broken && (
        // eslint-disable-next-line jsx-a11y/alt-text -- decorative; the title is already rendered as text alongside it.
        <img
          src={thumbnailUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      )}
      {durationSeconds !== null ? (
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-px font-mono text-[9px] tabular-nums text-white">
          {formatDuration(durationSeconds)}
        </span>
      ) : durationPending ? (
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-px font-mono text-[9px] text-white/80">
          확인 중
        </span>
      ) : null}
      <span className="sr-only">{title}</span>
    </div>
  );
}

/** `3661` -> `"1:01:01"`, `368` -> `"6:08"`. Callers must not pass `null`. */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

function CaptionBar({ availability }: { availability: CaptionAvailability | null }) {
  const { label, dotClass } = captionDisplay(availability);
  return (
    <div className="mx-4 mb-4 flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <span className={`block h-1.5 w-1.5 flex-none rounded-full ${dotClass}`} />
      <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{label}</span>
    </div>
  );
}

/**
 * Maps all five `CaptionAvailability | null` states to display text. `none`
 * and `null` ("checking") are kept textually distinct from each other and
 * from the three "captions exist" states, per the M1 Task 9 brief — the
 * three positive states (`available`/`auto-only`/`unknown`) share a dot
 * color but are still worded distinctly.
 */
function captionDisplay(availability: CaptionAvailability | null): {
  label: string;
  dotClass: string;
} {
  switch (availability) {
    case null:
      return { label: '자막 정보 확인 중', dotClass: 'bg-neutral-400 dark:bg-neutral-600' };
    case 'available':
      return { label: '영어 자막 있음', dotClass: 'bg-neutral-900 dark:bg-neutral-100' };
    case 'auto-only':
      return { label: '자막 있음 (자동 생성)', dotClass: 'bg-neutral-900 dark:bg-neutral-100' };
    case 'unknown':
      return { label: '자막 있음', dotClass: 'bg-neutral-900 dark:bg-neutral-100' };
    case 'none':
      return { label: '자막 없음', dotClass: 'bg-neutral-400 dark:bg-neutral-600' };
  }
}
