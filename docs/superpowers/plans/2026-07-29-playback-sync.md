# Playback Sync (클릭 시크 + 시간 동기 하이라이트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 번역 자막 리스트와 영상 재생을 양방향 연동 — 행 클릭 시 해당 `startSec`으로 시크, 재생 위치의 행을 하이라이트 + 자동 스크롤.

**Architecture:** 패널이 `chrome.tabs.connect(tabId, { name: PLAYBACK_PORT })`로 콘텐츠 스크립트에 **직접** 연결하는 단일 양방향 포트. CS→패널은 스로틀된 `{t, paused}` 틱 스트림, 패널→CS는 `init`/`seek` 명령. SW는 전혀 관여하지 않는다(시청 내내 SW를 깨워두지 않기 위한 의도적 선택 — 스펙 §2의 M2 제약 개정 참조). 시간→행 매핑·스로틀·스크롤 정지 판단은 순수 함수로 분리해 TDD.

**Tech Stack:** WXT + React 18 + TS 5 + Tailwind, vitest. Chrome MV3 (기존 host_permissions로 충분).

**Spec:** `docs/superpowers/specs/2026-07-29-playback-sync-design.md` (승인됨)

## Global Constraints

- 서페이스는 사이드 패널 + Options 둘뿐. manifest/권한 변경 금지 (`tabs` 권한 금지, `chrome.tabs.connect`는 host permission으로 동작).
- 직결 Port는 **재생 연동에 한정**. 번역 파이프라인 트리거·조회는 기존대로 bg 경유 유지 (스펙 §2).
- 포트 프로토콜: 패널의 첫 메시지는 반드시 `{ type: 'init', videoId }`. CS는 `ytd-watch-flexy[video-id]` 불일치 시 즉시 disconnect. init 전 스트림 금지.
- 시크는 `video.currentTime`만 변경 — 재생/일시정지 상태 불변.
- 순수 로직(`src/lib/`)은 TDD (실패 테스트 → RED 확인 → 구현 → GREEN).
- 각 태스크 후 게이트: `npx tsc --noEmit` 0 · `npm test` 전체 통과 · `npm run build` 성공.
- UI 문구 한국어 / 코드·주석·커밋 영어. Conventional Commits, 태스크 마지막 스텝에서만 커밋.
- `.env.local`, `.chrome-dev-profile/`, `.chrome-dev-output/`, `.superpowers/` 읽기·커밋 금지.
- 브랜치: `feat/playback-sync` (main에서 분기).

---

### Task 1: 순수 헬퍼 — 활성 행 탐색 · 틱 스로틀 · 스크롤 정지 판단

**Files:**
- Create: `src/lib/playback-sync.ts`
- Test: `src/lib/playback-sync.test.ts`

**Interfaces:**
- Consumes: `TranscriptSegment`(의 `startSec`) — `src/types/transcript.ts:8` (`startSec: number`, 오름차순 저장됨).
- Produces (이후 태스크가 그대로 사용):
  - `activeSegmentIndex(segments: readonly Pick<TranscriptSegment, 'startSec'>[], t: number): number | null`
  - `shouldEmitTick(lastEmitAtMs: number | null, nowMs: number, intervalMs?: number): boolean` (기본 500)
  - `isAutoScrollSuspended(lastUserScrollAtMs: number | null, nowMs: number, suspendMs?: number): boolean` (기본 5000)
  - `isUserScroll(nowMs: number, programmaticScrollUntilMs: number | null): boolean`

- [ ] **Step 1: 실패 테스트 작성**

`src/lib/playback-sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  activeSegmentIndex,
  isAutoScrollSuspended,
  isUserScroll,
  shouldEmitTick,
} from './playback-sync';

const segs = (...starts: number[]) => starts.map((startSec) => ({ startSec }));

describe('activeSegmentIndex', () => {
  it('returns null for an empty list', () => {
    expect(activeSegmentIndex([], 10)).toBeNull();
  });

  it('returns null when t is before the first segment', () => {
    expect(activeSegmentIndex(segs(5, 10, 20), 4.9)).toBeNull();
  });

  it('returns the index whose startSec equals t exactly', () => {
    expect(activeSegmentIndex(segs(0, 10, 20), 10)).toBe(1);
  });

  it('returns the previous index while t is between two starts', () => {
    expect(activeSegmentIndex(segs(0, 10, 20), 19.99)).toBe(1);
  });

  it('returns the last index when t is past the last start', () => {
    expect(activeSegmentIndex(segs(0, 10, 20), 9999)).toBe(2);
  });

  it('handles a single-segment list', () => {
    expect(activeSegmentIndex(segs(3), 2)).toBeNull();
    expect(activeSegmentIndex(segs(3), 3)).toBe(0);
  });
});

describe('shouldEmitTick', () => {
  it('always emits the first tick (no previous emit)', () => {
    expect(shouldEmitTick(null, 1000)).toBe(true);
  });

  it('suppresses a tick inside the interval', () => {
    expect(shouldEmitTick(1000, 1499)).toBe(false);
  });

  it('emits once the interval has elapsed (inclusive)', () => {
    expect(shouldEmitTick(1000, 1500)).toBe(true);
  });

  it('honors a custom interval', () => {
    expect(shouldEmitTick(1000, 1200, 100)).toBe(true);
  });
});

describe('isAutoScrollSuspended', () => {
  it('is not suspended when the user has never scrolled', () => {
    expect(isAutoScrollSuspended(null, 99999)).toBe(false);
  });

  it('is suspended within the window after a user scroll', () => {
    expect(isAutoScrollSuspended(1000, 5999)).toBe(true);
  });

  it('resumes once the window has fully elapsed', () => {
    expect(isAutoScrollSuspended(1000, 6000)).toBe(false);
  });

  it('honors a custom window', () => {
    expect(isAutoScrollSuspended(1000, 1500, 400)).toBe(false);
  });
});

describe('isUserScroll', () => {
  it('treats any scroll as user scroll when nothing programmatic is pending', () => {
    expect(isUserScroll(1000, null)).toBe(true);
  });

  it('ignores scroll events inside the programmatic window', () => {
    expect(isUserScroll(1000, 1300)).toBe(false);
  });

  it('treats scrolls at/after the window end as user scrolls', () => {
    expect(isUserScroll(1300, 1300)).toBe(true);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `npx vitest run src/lib/playback-sync.test.ts`
Expected: FAIL — `Cannot find module './playback-sync'` (또는 함수 미정의).

- [ ] **Step 3: 구현**

`src/lib/playback-sync.ts`:

```ts
import type { TranscriptSegment } from '~/types/transcript';

/** CS-side tick throttle interval (spec §2: timeupdate throttled to 500ms). */
export const PLAYBACK_TICK_INTERVAL_MS = 500;

/** Auto-scroll stays suspended this long after a genuine user scroll (spec §3.3). */
export const AUTO_SCROLL_SUSPEND_MS = 5000;

/**
 * The last index whose `startSec <= t`, or `null` when `t` is before the
 * first segment (or the list is empty). Binary search — segments are stored
 * in ascending `startSec` order (rowsToSegments preserves transcript order).
 */
export function activeSegmentIndex(
  segments: readonly Pick<TranscriptSegment, 'startSec'>[],
  t: number,
): number | null {
  if (segments.length === 0 || t < segments[0].startSec) return null;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].startSec <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Throttle decision for the CS tick stream: first tick always emits. */
export function shouldEmitTick(
  lastEmitAtMs: number | null,
  nowMs: number,
  intervalMs: number = PLAYBACK_TICK_INTERVAL_MS,
): boolean {
  return lastEmitAtMs === null || nowMs - lastEmitAtMs >= intervalMs;
}

/**
 * Whether auto-scroll is currently suspended because the user scrolled the
 * list themselves within the last `suspendMs` (spec §3.3 — no hijacking).
 */
export function isAutoScrollSuspended(
  lastUserScrollAtMs: number | null,
  nowMs: number,
  suspendMs: number = AUTO_SCROLL_SUSPEND_MS,
): boolean {
  return lastUserScrollAtMs !== null && nowMs - lastUserScrollAtMs < suspendMs;
}

/**
 * Distinguishes a genuine user scroll from the scroll event our own
 * `scrollIntoView` fires: events inside the programmatic window (set right
 * before calling scrollIntoView) do not count as user scrolls.
 */
export function isUserScroll(
  nowMs: number,
  programmaticScrollUntilMs: number | null,
): boolean {
  return programmaticScrollUntilMs === null || nowMs >= programmaticScrollUntilMs;
}
```

- [ ] **Step 4: GREEN 확인**

Run: `npx vitest run src/lib/playback-sync.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: 게이트 + 커밋**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 모두 통과.

```bash
git add src/lib/playback-sync.ts src/lib/playback-sync.test.ts
git commit -m "feat(playback): pure helpers for active-row lookup, tick throttle, scroll suspension"
```

---

### Task 2: 포트 프로토콜 타입 + CS playback 포트 핸들러

**Files:**
- Modify: `src/types/message.ts` (파일 끝, `TRANSLATION_PROGRESS_PORT` 근처 — line ~197)
- Modify: `entrypoints/content.ts` (§ scraper 아래 새 섹션 + `defineContentScript`의 `main()`에 onConnect 등록 — line ~368 이후)

**Interfaces:**
- Consumes: Task 1의 `shouldEmitTick`, `PLAYBACK_TICK_INTERVAL_MS`; content.ts 기존 `currentVideoId(): string | null` (line ~325).
- Produces (Task 3이 그대로 사용):
  - `export const PLAYBACK_PORT = 'playback';`
  - `export type PlaybackPanelMessage = { type: 'init'; videoId: string } | { type: 'seek'; seconds: number };`
  - `export interface PlaybackTick { t: number; paused: boolean; }`
  - CS 동작 계약: init 게이트 통과 시 즉시 첫 틱 1회 전송, 이후 스로틀 스트림 + seeked/play/pause 즉시 틱, video-id 불일치 감지 시 self-disconnect.

- [ ] **Step 1: 타입 추가**

`src/types/message.ts` 끝에 (기존 `TRANSLATION_PROGRESS_PORT` 선언 아래):

```ts
/**
 * Playback sync (spec: docs/superpowers/specs/2026-07-29-playback-sync-design.md).
 * The ONE deliberate exception to "panel talks only to background": the panel
 * connects DIRECTLY to the content script via `chrome.tabs.connect(tabId,
 * { name: PLAYBACK_PORT })`, because a periodic playback stream routed
 * through the SW would keep it awake for the whole watch session — the exact
 * cost M2 confined keepalive to pipeline runs to avoid. Pipeline
 * trigger/query messaging stays background-routed, unchanged.
 */
export const PLAYBACK_PORT = 'playback';

/** Panel -> content script, over PLAYBACK_PORT. First message MUST be init. */
export type PlaybackPanelMessage =
  | { type: 'init'; videoId: string }
  | { type: 'seek'; seconds: number };

/** Content script -> panel, over PLAYBACK_PORT: throttled playback ticks. */
export interface PlaybackTick {
  t: number;
  paused: boolean;
}
```

- [ ] **Step 2: CS 핸들러 구현**

`entrypoints/content.ts` — scraper 섹션 뒤에 추가 (import에 `PLAYBACK_PORT`, `PlaybackPanelMessage`, `PlaybackTick` + `shouldEmitTick` 추가):

```ts
// ---------------------------------------------------------------------------
// Playback sync port (spec §3.1). The panel connects directly (no SW hop —
// see PLAYBACK_PORT's doc comment in types/message.ts) and must send
// { type: 'init', videoId } first; ticks only start after the init gate
// passes. The <video> element survives SPA navigations with new content, so
// every emit re-checks the page's video-id and self-disconnects on mismatch
// (same staleness reasoning as handleRequestTranscript's §6a gate).

function findVideoElement(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('#movie_player video') ??
    document.querySelector<HTMLVideoElement>('video')
  );
}

function attachPlaybackPort(port: chrome.runtime.Port): void {
  let video: HTMLVideoElement | null = null;
  let expectedVideoId: string | null = null;
  let lastEmitAtMs: number | null = null;
  let detach: (() => void) | null = null;

  const cleanup = () => {
    detach?.();
    detach = null;
    video = null;
  };

  // Self-initiated disconnects do NOT fire our own onDisconnect listener —
  // cleanup must run explicitly on this path.
  const bail = () => {
    cleanup();
    port.disconnect();
  };

  const emitTick = (force: boolean) => {
    if (video === null) return;
    const now = Date.now();
    if (!force && !shouldEmitTick(lastEmitAtMs, now)) return;
    if (currentVideoId() !== expectedVideoId) {
      bail();
      return;
    }
    lastEmitAtMs = now;
    const tick: PlaybackTick = { t: video.currentTime, paused: video.paused };
    port.postMessage(tick);
  };

  const handleTimeupdate = () => emitTick(false);
  const handleImmediate = () => emitTick(true);

  port.onMessage.addListener((msg: PlaybackPanelMessage) => {
    if (msg.type === 'init') {
      expectedVideoId = msg.videoId;
      if (currentVideoId() !== msg.videoId) {
        bail();
        return;
      }
      video = findVideoElement();
      if (video === null) {
        bail();
        return;
      }
      const el = video;
      el.addEventListener('timeupdate', handleTimeupdate);
      el.addEventListener('seeked', handleImmediate);
      el.addEventListener('play', handleImmediate);
      el.addEventListener('pause', handleImmediate);
      detach = () => {
        el.removeEventListener('timeupdate', handleTimeupdate);
        el.removeEventListener('seeked', handleImmediate);
        el.removeEventListener('play', handleImmediate);
        el.removeEventListener('pause', handleImmediate);
      };
      // Immediate first tick so the panel highlights without waiting for the
      // next natural timeupdate (which never comes while paused).
      emitTick(true);
      return;
    }
    // msg.type === 'seek' — spec §2: currentTime only, play state untouched.
    if (video !== null && currentVideoId() === expectedVideoId) {
      video.currentTime = msg.seconds;
    }
  });

  port.onDisconnect.addListener(cleanup);
}
```

그리고 `defineContentScript`의 `main()` 안, 기존 `chrome.runtime.onMessage.addListener` 등록들 옆에:

```ts
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === PLAYBACK_PORT) attachPlaybackPort(port);
    });
```

- [ ] **Step 3: 게이트 확인**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 모두 통과 (CS 핸들러는 DOM/chrome 결합 — 리포 관례상 순수 부분(Task 1)만 단위 테스트, 나머지는 Task 5 실 Chrome 검증. 이 관례 유지가 요구사항이다: jsdom 컴포넌트/CS 하네스를 새로 도입하지 말 것).

- [ ] **Step 4: 커밋**

```bash
git add src/types/message.ts entrypoints/content.ts
git commit -m "feat(content): playback port — init-gated tick stream + seek command"
```

---

### Task 3: 패널 훅 `usePlaybackSync`

**Files:**
- Create: `src/features/playback/usePlaybackSync.ts`

**Interfaces:**
- Consumes: Task 2의 `PLAYBACK_PORT`, `PlaybackPanelMessage`, `PlaybackTick` (`~/types/message`).
- Produces (Task 4가 그대로 사용):
  - `usePlaybackSync(params: UsePlaybackSyncParams): UsePlaybackSyncResult`
  - `UsePlaybackSyncParams = { videoId: string | null; tabId: number | null; enabled: boolean }`
  - `UsePlaybackSyncResult = { currentTime: number | null; paused: boolean | null; seek: (seconds: number) => void }`

- [ ] **Step 1: 구현**

`src/features/playback/usePlaybackSync.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { PLAYBACK_PORT, type PlaybackPanelMessage, type PlaybackTick } from '~/types/message';

/** How often a dead stream retries connecting while the hook stays enabled. */
const RECONNECT_RETRY_MS = 3000;

export interface UsePlaybackSyncParams {
  videoId: string | null;
  tabId: number | null;
  /** Connect only while the transcript list is actually shown (spec §3.2). */
  enabled: boolean;
}

export interface UsePlaybackSyncResult {
  /** Latest streamed playback position, or null before the first tick. */
  currentTime: number | null;
  paused: boolean | null;
  /** Seeks the video. Lazily reconnects first if the stream port is dead. */
  seek: (seconds: number) => void;
}

/**
 * Panel side of the playback port (spec §3.2) — the deliberate direct
 * panel<->content-script connection (see PLAYBACK_PORT's doc comment for why
 * this one stream does NOT go through the background SW). Mirrors
 * useTranslation's lifecycle discipline: reset + reconnect per
 * [videoId, tabId, enabled] change, lazy reconnect on a dead port (here via
 * both a retry interval and seek()'s reconnect-before-send), cleanup on
 * unmount. The content script owns the staleness gate (it self-disconnects
 * on a video-id mismatch), so this hook only manages connection liveness.
 */
export function usePlaybackSync({ videoId, tabId, enabled }: UsePlaybackSyncParams): UsePlaybackSyncResult {
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const deadRef = useRef(true);
  const connectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setCurrentTime(null);
    setPaused(null);
    portRef.current = null;
    deadRef.current = true;
    connectRef.current = null;

    if (!enabled || videoId === null || tabId === null) return;

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      try {
        const port = chrome.tabs.connect(tabId, { name: PLAYBACK_PORT });
        portRef.current = port;
        deadRef.current = false;
        port.onMessage.addListener((msg: PlaybackTick) => {
          if (cancelled) return;
          setCurrentTime(msg.t);
          setPaused(msg.paused);
        });
        port.onDisconnect.addListener(() => {
          // Only the CURRENT port may flip the dead flag — a stale port's
          // disconnect must not kill a newer connection (same guard shape as
          // useTranslation's generation checks).
          if (portRef.current === port) {
            portRef.current = null;
            deadRef.current = true;
          }
        });
        const init: PlaybackPanelMessage = { type: 'init', videoId };
        port.postMessage(init);
      } catch {
        // No receiving end (orphaned/absent CS) — stay dead; the retry
        // interval below keeps trying while the hook is enabled.
        portRef.current = null;
        deadRef.current = true;
      }
    };
    connectRef.current = connect;

    connect();
    const retry = setInterval(() => {
      if (deadRef.current) connect();
    }, RECONNECT_RETRY_MS);

    return () => {
      cancelled = true;
      clearInterval(retry);
      connectRef.current = null;
      portRef.current?.disconnect();
      portRef.current = null;
      deadRef.current = true;
    };
  }, [videoId, tabId, enabled]);

  function seek(seconds: number): void {
    if (deadRef.current) connectRef.current?.();
    const msg: PlaybackPanelMessage = { type: 'seek', seconds };
    try {
      portRef.current?.postMessage(msg);
    } catch {
      // Port died between the reconnect attempt and the send — the retry
      // interval will restore the stream; the click is simply dropped.
    }
  }

  return { currentTime, paused, seek };
}
```

- [ ] **Step 2: 게이트 확인**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 모두 통과 (chrome 포트 결합 훅 — 리포 관례상 단위 테스트 없음, Task 5에서 실 Chrome 검증. `useTranslation.ts`가 같은 취급).

- [ ] **Step 3: 커밋**

```bash
git add src/features/playback/usePlaybackSync.ts
git commit -m "feat(panel): usePlaybackSync hook — direct playback port with lazy reconnect"
```

---

### Task 4: TranscriptList 행 클릭·하이라이트·자동 스크롤 + ReadyBody 배선

**Files:**
- Modify: `src/components/TranscriptList.tsx`
- Modify: `entrypoints/sidepanel/App.tsx` (`ReadyBody`, line ~252 및 `TranscriptList` 사용부 line ~375)

**Interfaces:**
- Consumes: Task 1의 `activeSegmentIndex`, `isAutoScrollSuspended`, `isUserScroll` (`~/lib/playback-sync`); Task 3의 `usePlaybackSync`; 기존 `useCurrentVideo().tabId`, `useTranslation().record`, `showTranscriptList`, `displayMode`.
- Produces: `TranscriptListProps`에 `activeIndex?: number | null`, `onSeekRow?: (segment: TranscriptSegment) => void` 추가 (기존 props 불변 — 미지정 시 기존 렌더와 동일해야 함).

- [ ] **Step 1: TranscriptList 확장**

`src/components/TranscriptList.tsx` — props 확장 + 행 인터랙션 + 자동 스크롤. `import { useEffect, useRef } from 'react';` 와 `import { isAutoScrollSuspended, isUserScroll } from '~/lib/playback-sync';` 추가. `TranscriptListProps`를:

```ts
export interface TranscriptListProps {
  segments: TranscriptSegment[];
  displayMode?: DisplayMode;
  /** Index of the row matching current playback, or null (no highlight). */
  activeIndex?: number | null;
  /** Row click -> seek. Rows render as plain text when omitted. */
  onSeekRow?: (segment: TranscriptSegment) => void;
}
```

컴포넌트 본문을 다음으로 교체 (visibleTexts/DisplayMode 등 기존 export는 그대로):

```tsx
export function TranscriptList({ segments, displayMode = 'both', activeIndex = null, onSeekRow }: TranscriptListProps) {
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastUserScrollAtRef = useRef<number | null>(null);
  const programmaticUntilRef = useRef<number | null>(null);

  // Capture-phase document listener: the actual scroll container is the
  // panel's outer overflow div (App.tsx), not this component, and capture
  // catches it regardless of which ancestor scrolls. Scroll events fired by
  // our own scrollIntoView (below) are excluded via the programmatic window
  // (isUserScroll) so auto-scroll doesn't suspend itself.
  useEffect(() => {
    const handleScroll = () => {
      const now = Date.now();
      if (isUserScroll(now, programmaticUntilRef.current)) {
        lastUserScrollAtRef.current = now;
      }
    };
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', handleScroll, { capture: true });
  }, []);

  // Follow the active row (spec §3.3): nearest-block scroll, suspended for
  // AUTO_SCROLL_SUSPEND_MS after a genuine user scroll.
  useEffect(() => {
    if (activeIndex === null) return;
    const row = rowRefs.current[activeIndex];
    if (row === null || row === undefined) return;
    const now = Date.now();
    if (isAutoScrollSuspended(lastUserScrollAtRef.current, now)) return;
    programmaticUntilRef.current = now + 300;
    row.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
      {segments.map((segment, i) => {
        const texts = visibleTexts(segment, displayMode);
        const active = i === activeIndex;
        const interactive = onSeekRow !== undefined;
        return (
          <div
            key={segment.segmentId}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            {...(interactive
              ? {
                  role: 'button' as const,
                  tabIndex: 0,
                  onClick: () => onSeekRow(segment),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSeekRow(segment);
                    }
                  },
                }
              : {})}
            className={`flex gap-2.5 px-4 py-3 ${
              active ? 'bg-neutral-100 dark:bg-neutral-800/60' : ''
            } ${interactive ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900' : ''}`}
          >
            <span className="w-10 flex-none font-mono text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
              {formatTimestamp(segment.startSec)}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              {texts.kind === 'dual' ? (
                <>
                  <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {texts.secondaryText}
                  </span>
                  <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                    {texts.primaryText}
                  </span>
                </>
              ) : texts.kind === 'secondary-only' ? (
                <span className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {texts.text}
                </span>
              ) : (
                <span className="text-[13px] leading-relaxed text-neutral-900 dark:text-neutral-100">
                  {texts.text}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

주의: 기존 행 JSX가 R7에서 `visibleTexts` 기반으로 이미 리팩터돼 있다 — 위 코드는 그 구조를 유지한 채 ref/인터랙션/하이라이트만 더한 것. 실제 파일의 현재 JSX와 대조해 **기존 세 렌더 분기(dual/secondary-only/primary-only)의 클래스 문자열을 바꾸지 말 것**.

- [ ] **Step 2: ReadyBody 배선**

`entrypoints/sidepanel/App.tsx` — import 추가:

```ts
import { activeSegmentIndex } from '~/lib/playback-sync';
import { usePlaybackSync } from '~/features/playback/usePlaybackSync';
```

`ReadyBody` 안, `showTranscriptList` 계산(line ~318) **아래**에:

```ts
  // Playback sync (spec §3.2): stream only while the list is on screen.
  const playback = usePlaybackSync({ videoId, tabId, enabled: showTranscriptList });
  const activeIndex =
    showTranscriptList && record !== null && playback.currentTime !== null
      ? activeSegmentIndex(record.segments, playback.currentTime)
      : null;
```

`TranscriptList` 사용부(line ~375)를:

```tsx
          <TranscriptList
            segments={record.segments}
            displayMode={displayMode}
            activeIndex={activeIndex}
            onSeekRow={(segment) => playback.seek(segment.startSec)}
          />
```

- [ ] **Step 3: 게이트 확인**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 모두 통과 (기존 TranscriptList.test.ts의 `visibleTexts` 테스트 불변 통과 포함).

- [ ] **Step 4: 커밋**

```bash
git add src/components/TranscriptList.tsx entrypoints/sidepanel/App.tsx
git commit -m "feat(panel): row click-to-seek + active-row highlight with auto-scroll"
```

---

### Task 5: 실 Chrome 검증 (컨트롤러 주도, CDP)

**Files:** 없음 (검증 전용 — 스크립트는 세션 스크래치패드에서).

**Interfaces:**
- Consumes: 빌드된 확장(`.output/chrome-mv3`), CDP(9222), 번역 `done` 레코드가 있는 영상 탭.

검증 항목 (스펙 §5) — 각각 stdout 원문을 원장에 남긴다:

- [ ] **Step 1: 확장 리로드 + 영상 탭 리로드** (`Extensions.loadUnpacked`, 이후 탭 reload — 고아 CS 방지).
- [ ] **Step 2: 클릭 시크** — done 레코드 영상에서 패널(-탭)을 열고 자막 행 N을 CDP로 클릭 → 영상 탭에서 `document.querySelector('video').currentTime`이 해당 세그먼트 `startSec` ±1s인지 실측. Expected: 일치.
- [ ] **Step 3: 재생 상태 불변** — 영상을 일시정지시킨 뒤 다른 행 클릭 → `video.paused === true` 유지 실측. Expected: true 유지 + currentTime 점프.
- [ ] **Step 4: 하이라이트 추적** — 재생 상태로 두고 패널 DOM을 3~4회 폴링(2s 간격) → active 행(`bg-neutral-100` 클래스)이 시간에 따라 다음 행으로 이동하는지 실측. Expected: 인덱스 단조 증가.
- [ ] **Step 5: SPA 재연결** — 관련 영상 앵커 실클릭으로 이동 후 뒤로가기 → 패널 videoId 사이클 후 스트림 재개(하이라이트 다시 갱신) + 콘솔 에러 0 실측. (`Page.navigate` 금지 — M2 함정 §5.)
- [ ] **Step 6: 원장 기록** — 각 스텝 stdout 원문 append.

---

## Self-Review 결과 (작성 후 점검)

- 스펙 커버리지: §2(포트·init·seek·스로틀·즉시 틱) → Task 2, §3.1 → Task 2, §3.2 → Task 3, §3.3(행 클릭·하이라이트·자동 스크롤·정지) → Task 1+4, §3.4 → Task 1, §5 → Task 5. 잔여 갭 없음.
- 플레이스홀더 스캔: 코드 스텝 전부 실코드. 통과.
- 타입 일관성: `PLAYBACK_PORT`/`PlaybackPanelMessage`/`PlaybackTick`(T2 정의 → T3 소비), `activeSegmentIndex`·`isAutoScrollSuspended`·`isUserScroll`·`shouldEmitTick`(T1 정의 → T2/T4 소비), `UsePlaybackSyncResult.seek(seconds)`(T3 → T4 `playback.seek(segment.startSec)`) 서명 일치 확인.
