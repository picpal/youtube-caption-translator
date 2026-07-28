import { Fragment, useEffect, useState } from 'react';
import { Button } from '~/components/Button';
import { StatusBadge } from '~/components/StatusBadge';
import { UnsupportedBanner } from '~/components/UnsupportedBanner';
import { VideoCard } from '~/components/VideoCard';
import { useApiKey } from '~/features/api-key/useApiKey';
import { progressPercent, stepForStatus, type ProcessingStep } from '~/features/translation/progress-display';
import { useTranslation, type TranslationProgressState } from '~/features/translation/useTranslation';
import { useCurrentVideo } from '~/features/video/useCurrentVideo';
import { classifyYoutubeUrl, type YoutubePageKind } from '~/lib/youtube';
import type { TranslationRecord, TranslationStatus } from '~/types/transcript';

// 'checking' is this component's own pre-first-query state, layered on top
// of the 4-way `YoutubePageKind` — not one of its members, since
// `classifyYoutubeUrl` always has an answer once given a url (even
// `undefined` resolves to `'other'`); there is simply no url to classify yet
// on the very first render.
type PageKind = 'checking' | YoutubePageKind;

// This is the single source of truth for the panel's top-level branch
// (watch / shorts / live / other-or-non-YouTube). It is intentionally NOT
// `useCurrentVideo().kind`, even though that hook computes the same
// `classifyYoutubeUrl` value internally: that hook's `kind` only becomes
// meaningful once its own tab-identity effect has run, and gating the
// top-level branch on it would mean this component's shorts/live detection
// depends on a second component's internal state happening to have settled
// first (the exact "two sources of truth fighting" risk Task 8 flagged).
// This effect already does its own independent `chrome.tabs.query` +
// `onActivated`/`onUpdated` detection (unchanged from the pre-Task-10 M0
// logic, just upgraded from the boolean `isYoutubeWatchUrl` to the 4-way
// `classifyYoutubeUrl`), so the branch below never needs to wait on a
// content-script report existing.
//
// `useCurrentVideo()` is still used, but only inside `ReadyBody`, for the
// one thing this effect genuinely cannot know: whether a *watch* page's
// extraction pipeline actually produced a video (the `no-metadata` reason).
export function App() {
  const { status } = useApiKey();
  const [pageKind, setPageKind] = useState<PageKind>('checking');

  const loading = status === null;
  const present = status?.present === true;
  const ready = present && pageKind === 'watch';

  // The panel is long-lived (unlike the popup this logic was originally
  // written for, which was destroyed and recreated on every open) — it
  // survives tab switches and in-page navigation, so a mount-only query is
  // not enough. Re-run the same detection whenever the active tab could
  // have changed: the user switched tabs (`onActivated`) or the active tab
  // navigated in place (`onUpdated` — YouTube is an SPA, so moving between
  // videos fires a `url` change on the existing tab rather than a fresh
  // page load/tab-created event).
  //
  // `chrome.windows.onFocusChanged` is deliberately NOT subscribed to: it
  // fires when focus moves between browser windows, but it never changes
  // which tab is active *within* a given window. Since detection is always
  // scoped via `currentWindow: true` to the window the panel itself is
  // hosted in, a focus change elsewhere carries no information this
  // detection needs — `onActivated`/`onUpdated` on that window already
  // cover every way its active tab can change.
  useEffect(() => {
    let cancelled = false;

    const detect = () => {
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (cancelled) return;
        setPageKind(classifyYoutubeUrl(tab?.url));
      });
    };

    detect();

    const handleActivated = () => detect();

    // onUpdated fires for every tab, not just the active one — guard on
    // `tab.active` so background-tab churn doesn't trigger a re-query. Then
    // re-detect only on a real navigation lifecycle signal: a `url` change
    // (SPA video switches, full reloads) OR a `status` change. Gating on
    // `url` alone would miss a critical case — when the active tab navigates
    // in place to a host outside this extension's permissions (e.g. the user
    // types a non-YouTube address into the tab bar), Chrome REDACTS
    // `changeInfo.url` to `undefined`, yet still delivers the `status`
    // lifecycle (loading/complete). Without the `status` fallback we'd never
    // re-run detection for "the user left YouTube," leaving a stale video
    // card for a page we're no longer on. Pure title/favicon/audible churn
    // carries neither `url` nor `status`, so it's still filtered out — one
    // detect per meaningful event, as before.
    const handleUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (!tab.active) return;
      if (changeInfo.url === undefined && changeInfo.status === undefined) return;
      detect();
    };

    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">YouTube Play Assistant</h1>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge tone={loading ? 'muted' : present ? 'ok' : 'warn'}>
            {loading ? '확인 중' : present ? '준비됨' : '설정 필요'}
          </StatusBadge>
          <button
            type="button"
            onClick={() => chrome.runtime.openOptionsPage()}
            aria-label="설정 열기"
            className="rounded p-1 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      {ready ? (
        <div className="flex-1 overflow-auto">
          <ReadyBody />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6">
          {loading ? (
            <LoadingBody />
          ) : !present ? (
            <OnboardingBody />
          ) : pageKind === 'shorts' ? (
            <UnsupportedBanner reason="shorts" />
          ) : pageKind === 'live' ? (
            <UnsupportedBanner reason="live" />
          ) : (
            <NonYoutubeBody />
          )}
        </div>
      )}
    </div>
  );
}

function LoadingBody() {
  return (
    <p className="text-sm text-neutral-500 dark:text-neutral-400">불러오는 중…</p>
  );
}

function NonYoutubeBody() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 pt-10 text-center">
      <p className="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
        유튜브 영상 페이지로 이동해주세요
      </p>
    </div>
  );
}

// Panel-native READY layout. Design source: docs/design/extension-popup.dc.html
// (the "READY · LIGHT" block) — originally built for the 360px popup and
// ported here 1:1 in structure, then re-spaced for the panel's ~400px width
// and unconstrained height: 3.5-scale paddings/gaps become 4-scale, and the
// 88x50 thumbnail becomes an exact-16:9 96x54 so it doesn't look stretched at
// the wider column. The popup's own "패널 열기" button is dropped — the panel
// is the destination now, not a link to one.
//
// The thumbnail/title/channel block and the caption-availability bar are
// real data as of Task 9, via VideoCard + useCurrentVideo. The
// `AI 자막 생성` button and the 처리 단계 footer are wired to the live
// translation state as of M2 Task 8, via useTranslation (below). Only the
// 자막 표시 selector remains static — M3's display-mode concern, not this
// task's.
function ReadyBody() {
  const { video, loading, tabId } = useCurrentVideo();
  const videoId = video?.videoId ?? null;
  const { status, progress, record, start, error } = useTranslation({ videoId, tabId });

  // `no-metadata`: the pipeline settled for this watch-page tab (`loading`
  // is false — see useCurrentVideo's doc comment on what that requires) and
  // still produced no video record. This is the one UnsupportedReason that
  // legitimately comes from the extraction pipeline rather than the URL
  // alone — App's top-level branch already guarantees `pageKind === 'watch'`
  // by the time ReadyBody is mounted at all, so there is nothing further to
  // check here beyond "did it settle, and is it still empty".
  if (!loading && video === null) {
    return (
      <div className="p-6">
        <UnsupportedBanner reason="no-metadata" onRetry={retryActiveTab} />
      </div>
    );
  }

  return (
    <>
      <VideoCard video={video} loading={loading} />

      <div className="px-4">
        <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
          자막 표시
        </span>
        <div className="mt-2 flex overflow-hidden rounded-[7px] border border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            className="flex-1 border-0 bg-neutral-100 py-2 text-[11.5px] font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          >
            영한 동시
          </button>
          <button
            type="button"
            className="flex-1 border-0 border-l border-neutral-200 bg-white py-2 text-[11.5px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            한국어
          </button>
          <button
            type="button"
            className="flex-1 border-0 border-l border-neutral-200 bg-white py-2 text-[11.5px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            영어
          </button>
        </div>
      </div>

      <div className="p-4">
        <TranslateButton
          ready={videoId !== null && tabId !== null}
          status={status}
          progress={progress}
          error={error}
          onStart={start}
        />
      </div>

      <ProcessingStepper status={status} progress={progress} record={record} />
    </>
  );
}

// M2 Task 8 — the §9 `AI 자막 생성` state machine:
// - not `ready` (videoId/tabId not resolved yet): disabled, neutral label —
//   `useTranslation`'s own `start()` already no-ops in this state, so this
//   just keeps the button from looking clickable when it silently wouldn't
//   do anything.
// - `idle`: enabled, kicks off `start()`.
// - `extracting`/`analyzing`/`translating`: disabled with a step-aware
//   label; `translating` additionally shows the live, divide-by-zero-safe
//   percent via `progressPercent`.
// - `done`: disabled, reads as complete. Re-translating and rendering the
//   translated segment list are out of this task's scope (Task 9).
// - `failed`: re-enabled as a 다시 시도 retry affordance, with the failure
//   reason surfaced above it.
function TranslateButton({
  ready,
  status,
  progress,
  error,
  onStart,
}: {
  ready: boolean;
  status: TranslationStatus | 'idle';
  progress: TranslationProgressState | null;
  error: string | null;
  onStart: () => void;
}) {
  if (!ready) {
    return (
      <Button disabled aria-disabled className="w-full">
        준비 중…
      </Button>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-col gap-2">
        {error ? (
          <p className="text-[11.5px] leading-relaxed text-red-600 dark:text-red-400">{error}</p>
        ) : null}
        <Button onClick={onStart} className="w-full">
          다시 시도
        </Button>
      </div>
    );
  }

  if (status === 'extracting' || status === 'analyzing' || status === 'translating') {
    return (
      <Button disabled aria-disabled className="w-full">
        {processingLabel(status, progress)}
      </Button>
    );
  }

  if (status === 'done') {
    return (
      <Button disabled aria-disabled className="w-full">
        번역 완료
      </Button>
    );
  }

  // 'idle'
  return (
    <Button onClick={onStart} className="w-full">
      AI 자막 생성
    </Button>
  );
}

function processingLabel(
  status: 'extracting' | 'analyzing' | 'translating',
  progress: TranslationProgressState | null,
): string {
  if (status === 'extracting') return 'Transcript 추출 중…';
  if (status === 'analyzing') return '용어 분석 중…';
  // 'translating' is the only step whose progress event actually streams
  // (pipeline.ts emits one `onProgress` per completed batch), so it is the
  // only label worth a live percent. `progress` can still briefly be `null`
  // here — e.g. a panel reopened onto an already-`translating` record whose
  // status came from the initial GET_TRANSLATION fetch, before this
  // session's own Port has delivered a first message for the resumed job —
  // so this guards on more than just `total === 0`.
  if (progress === null) return '한국어 번역 중…';
  return `한국어 번역 중… ${progressPercent(progress.done, progress.total)}%`;
}

const STEP_LABELS = ['Transcript 추출', '용어 분석', '한국어 번역', '자막 적용'] as const;

type StepVisualState = 'done' | 'active' | 'failed' | 'pending';

const STEP_TEXT_CLASS: Record<StepVisualState, string> = {
  done: 'text-neutral-600 dark:text-neutral-400',
  active: 'font-semibold text-neutral-900 dark:text-neutral-100',
  failed: 'font-semibold text-red-600 dark:text-red-400',
  pending: 'text-neutral-400 dark:text-neutral-600',
};

// `status === 'done'` marks every step done regardless of `activeStep`'s
// exact value — once the whole job is done there is nothing left mid-flight
// to distinguish between steps.
function stepVisualState(
  stepNum: number,
  activeStep: ProcessingStep,
  status: TranslationStatus | 'idle',
): StepVisualState {
  if (status === 'done') return 'done';
  if (stepNum < activeStep) return 'done';
  if (stepNum === activeStep && activeStep !== 0) return status === 'failed' ? 'failed' : 'active';
  return 'pending';
}

// The idle-state hint is the original static copy; while a job is actively
// processing it is replaced with a live `done / total` count — guarded the
// same way `progressPercent` is (a `total` of 0, or no `progress` at all
// yet, just omits the count rather than rendering a bogus "0 / 0").
function stepperCaption(
  status: TranslationStatus | 'idle',
  progress: TranslationProgressState | null,
): string {
  if (status === 'failed') return '실패한 단계부터 다시 시도할 수 있습니다';
  if (status === 'done') return '번역이 완료되었습니다';
  if (status === 'idle') return '약 40초 소요 · 처리 중에도 영상은 계속 재생됩니다';
  if (progress && progress.total > 0) {
    return `${progress.done} / ${progress.total} · 처리 중에도 영상은 계속 재생됩니다`;
  }
  return '처리 중에도 영상은 계속 재생됩니다';
}

// M2 Task 8 — live 처리 단계 stepper. `stepForStatus` covers the plain
// status->step mapping (extracting=1/analyzing=2/translating=3/done=4); the
// `activeStep` resolution below layers on top of it for the one case that
// mapping alone cannot express — WHICH step a `failed` status stopped at:
// 1) prefer the live Port's `progress.step` (most current, and set together
//    with `status` in useTranslation's own port-message handler, so this
//    covers a failure that happened live in this session);
// 2) fall back to the persisted record's `error.step` for a job that failed
//    in a past session and was never resumed here (no Port message ever
//    arrives for it this time — this is the common "reopen the panel on an
//    old failure" path);
// 3) finally fall back to the plain mapping (idle, or a done/failed video
//    this session never streamed any progress for at all).
function ProcessingStepper({
  status,
  progress,
  record,
}: {
  status: TranslationStatus | 'idle';
  progress: TranslationProgressState | null;
  record: TranslationRecord | null;
}) {
  const activeStep = progress?.step ?? stepForStatus(record?.error?.step ?? status);

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-200 px-4 py-3.5 dark:border-neutral-800">
      <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
        처리 단계
      </span>
      <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
        {STEP_LABELS.map((label, i) => {
          const stepNum = i + 1;
          const state = stepVisualState(stepNum, activeStep, status);
          const marker = state === 'done' ? '✓' : state === 'failed' ? '!' : String(stepNum);
          const percent =
            state === 'active' && status === 'translating' && progress
              ? ` ${progressPercent(progress.done, progress.total)}%`
              : '';
          return (
            <Fragment key={label}>
              {i > 0 && <span className="text-neutral-300 dark:text-neutral-700">→</span>}
              <span className={STEP_TEXT_CLASS[state]}>
                {marker} {label}
                {percent}
              </span>
            </Fragment>
          );
        })}
      </div>
      <span className="text-[10.5px] text-neutral-400 dark:text-neutral-600">
        {stepperCaption(status, progress)}
      </span>
    </div>
  );
}

// The `no-metadata` retry affordance: forces a full page reload of the
// active tab. Chosen over re-pulling GET_CURRENT_VIDEO because a re-pull
// would only return the background's already-cached (empty) state — nothing
// re-triggers the content script's extraction without a fresh navigation.
// Requires no extra permission: `chrome.tabs.reload`/`.query` (unlike
// reading `tab.url` on an arbitrary tab) do not need the "tabs" permission,
// and this tab is already known to match this extension's youtube.com host
// permission (pageKind is only 'watch' for a youtube.com tab).
function retryActiveTab(): void {
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id !== undefined) chrome.tabs.reload(tab.id);
  });
}

function OnboardingBody() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
        <KeyIcon />
      </div>
      <div>
        <h2 className="text-base font-semibold">API 키를 등록해주세요</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          번역과 요약을 위해 Gemini API 키가 필요합니다. 개인 학습용이라면 Google AI Studio에서 무료로 발급할 수 있습니다.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Button onClick={() => chrome.runtime.openOptionsPage()}>설정 열기</Button>
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          API 키 발급받기 →
        </a>
      </div>
      <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-500">
        키는 이 브라우저에만 저장되며 외부로 전송되지 않습니다.
      </p>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.05a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.05a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.05a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
