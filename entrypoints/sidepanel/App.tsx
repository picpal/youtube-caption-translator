import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '~/components/Button';
import { StatusBadge } from '~/components/StatusBadge';
import { SummaryPanel } from '~/components/SummaryPanel';
import { TranscriptList, type DisplayMode } from '~/components/TranscriptList';
import { UnsupportedBanner } from '~/components/UnsupportedBanner';
import { VideoCard } from '~/components/VideoCard';
import { useApiKey } from '~/features/api-key/useApiKey';
import { usePlaybackSync } from '~/features/playback/usePlaybackSync';
import { useSummary } from '~/features/summary/useSummary';
import { translationErrorDisplay } from '~/features/translation/error-display';
import {
  formatElapsedTime,
  translatePhaseLabel,
} from '~/features/translation/progress-display';
import { useTranslation, type TranslationProgressState } from '~/features/translation/useTranslation';
import { useCurrentVideo } from '~/features/video/useCurrentVideo';
import { activeSegmentIndex } from '~/lib/playback-sync';
import { formatTimestamp } from '~/lib/transcript-parse';
import { loadPanelPrefs, savePanelDisplayMode, savePanelLastTab, type PanelTab } from '~/lib/panel-prefs';
import {
  DEFAULT_TARGET_LANG,
  getTargetLang,
  saveTargetLang,
  TARGET_LANG_LABELS,
  TARGET_LANG_STORAGE_KEY,
  TARGET_LANGS,
  type TargetLang,
} from '~/lib/target-lang';
import { classifyYoutubeUrl, type YoutubePageKind } from '~/lib/youtube';
import type { TranslationRecord, TranslationStatus } from '~/types/transcript';
import type { CaptionAvailability } from '~/types/video';

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
  // Fix round B — the panel's OWN page (this div, not `document`) is the
  // scroll container: the outer shell above is pinned to `min-h-screen`
  // rather than growing with content, so this `overflow-auto` div is where
  // all real scrolling happens. Owned here (not inside ReadyBody) since it's
  // this element's ref, and passed down so ReadyBody's tab-switch reset
  // (B2) and floating scroll-to-top button (B3) can both act on it.
  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
    // Fix round 3 — `min-h-screen` GROWS with content instead of pinning to
    // the viewport, so the `flex-1 overflow-auto` div below never actually
    // becomes shorter than its content and never gets a real internal
    // scrollbar: the DOCUMENT scrolls instead (confirmed live via CDP — no
    // element had scrollHeight > clientHeight except document.scrollingElement).
    // That made B3's `useScrollTopVisible` listener (attached to this ref'd
    // div) never fire and its `scrollTo` target a div that never moves.
    // `h-screen` pins this shell to exactly the viewport height instead, so
    // the header takes its fixed portion and `flex-1` is constrained to
    // what's left — the div genuinely scrolls, and the document doesn't
    // (globals.css sets no explicit html/body height, so body's rendered
    // height just follows this single `h-screen` child with no left-over
    // document-level overflow).
    <div className="flex h-screen flex-col">
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
        <div ref={scrollContainerRef} className="panel-scrollbar flex-1 overflow-auto">
          <ReadyBody scrollContainerRef={scrollContainerRef} />
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
// Task 9 fix round 1: `useTranslation`'s `handlePortMessage` sets the
// derived `status` this component reads SYNCHRONOUSLY from the terminal Port
// message, but only kicks off the async `refetchRecord()` alongside it (see
// that hook's doc comments) — so on a fail -> retry -> succeed transition
// there is at least one render where `status === 'done'` while `record`
// still holds the PREVIOUS (`failed`) attempt's stale segments, before the
// refetch's response lands. `record.status === status` is only true once
// the SAME GET_TRANSLATION response that produced `record.segments` also
// produced the `status` this render is comparing against — i.e. the two are
// guaranteed to be from one atomic snapshot, never a stale segments array
// paired with a fresher derived status (or vice versa). Both the transcript
// list and the console dump gate on this, not just on `status` alone.
function isRecordCurrentForStatus(
  status: TranslationStatus | 'idle',
  record: TranslationRecord | null,
): record is TranslationRecord {
  return record !== null && record.status === status;
}

// Task R2 (progress UX polish) — a single translate chunk is now ~15s
// (MAX_SEGMENTS_PER_REQUEST=50, pipeline.ts), but that's still long enough
// that a static "번역 중… 요청 전송" label sitting at the same chunk-percent
// the whole time can read as frozen. This ticks a panel-local elapsed-second
// counter for as long as `active` is true — deliberately NOT sourced from
// `TranslationProgress` (the brief is explicit: elapsed time is a panel-side
// liveness signal, never threaded through the background Port). Resets to 0
// the moment `active` flips true->false or false->true, so re-entering the
// translating phase (a retry, or a fresh chunk after a rate-limit wait)
// always starts the visible counter fresh rather than carrying over a stale
// value from a previous attempt or step. Cleared via the effect's own
// cleanup on unmount or whenever `active` changes.
function useElapsedSeconds(active: boolean): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    setElapsedSeconds(0);
    if (!active) return;

    const startedAt = Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [active]);

  return elapsedSeconds;
}

// Fix round B3 — "meaningfully scrolled" threshold for the floating
// scroll-to-top button. No spec-mandated value; picked as a visually
// obvious scroll depth, not tied to any content measurement.
const SCROLL_TOP_BUTTON_THRESHOLD_PX = 300;

// Fix round B3 — tracks whether the panel's own scroll container (App.tsx's
// `overflow-auto` div, passed down as `scrollContainerRef`) is scrolled past
// the threshold above, for the floating scroll-to-top button's visibility.
// A plain scroll listener on that ONE element, deliberately not the
// capture-phase `document` trick TranscriptList uses for its own auto-scroll
// suspension: that trick exists there to catch a scroll on the container
// from a component that doesn't hold a ref to it, but this hook is handed
// the ref directly, so a listener on the real element is simpler and needs
// no target-identity guessing.
function useScrollTopVisible(containerRef: RefObject<HTMLDivElement | null>, thresholdPx: number): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const handleScroll = () => {
      setVisible(container.scrollTop > thresholdPx);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [containerRef, thresholdPx]);

  return visible;
}

// The 자막 표시 selector options (Task R7, Fix 1) — data-driven so the
// buttons below are a plain `.map`, not two hand-copied `<button>`s that
// could drift out of sync with each other.
const DISPLAY_MODE_OPTIONS: ReadonlyArray<{ mode: DisplayMode; label: string }> = [
  { mode: 'both', label: '원문+번역' },
  { mode: 'ko', label: '번역만' },
];

// The thumbnail/title/channel block and the caption-availability bar are
// real data as of Task 9, via VideoCard + useCurrentVideo. The
// `AI 자막 생성` button is wired to the live translation state as of
// M2 Task 8, via useTranslation (below). The finished transcript list
// (M2 Task 9) renders below the 생성 button once a `done`/`failed` record
// has segments. The 자막 표시 selector (Task R7, Fix 1) now actually
// switches `TranscriptList`'s `displayMode` — persisted to
// `chrome.storage.local` via `panel-prefs` (M3, spec 2026-07-30-panel-prefs)
// and restored on mount.
function ReadyBody({ scrollContainerRef }: { scrollContainerRef: RefObject<HTMLDivElement | null> }) {
  const { video, loading, tabId } = useCurrentVideo();
  const videoId = video?.videoId ?? null;
  const { status, progress, record, start, error, pending } = useTranslation({ videoId, tabId });
  const elapsedSeconds = useElapsedSeconds(status === 'translating');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('both');

  // Panel prefs persistence (M3 spec 2026-07-30-panel-prefs). Both restored
  // values come from one mount-time load; WRITES happen only in the two
  // onClick handlers below — automatic transitions (the snap-back effect
  // further down) must never persist, or reopening the panel would clobber
  // a stored 'summary' with 'transcript' during the moment the gate is
  // still closed while the translation record loads.
  //
  // displayMode is applied as soon as the load resolves — unless the user
  // already clicked a mode button in that ~ms window (touched ref wins).
  // lastTab is NOT applied here: it's parked in state and applied by the
  // gate-keyed effect below, because restoring 'summary' before
  // showSummaryTab is true would be immediately snapped back to
  // 'transcript' by the existing effect.
  const displayModeTouchedRef = useRef(false);
  const [storedLastTab, setStoredLastTab] = useState<PanelTab | null>(null); // null = not loaded yet
  useEffect(() => {
    let cancelled = false;
    void loadPanelPrefs()
      .then((prefs) => {
        if (cancelled) return;
        if (!displayModeTouchedRef.current) setDisplayMode(prefs.displayMode);
        setStoredLastTab(prefs.lastTab);
      })
      .catch(() => {}); // swallow rejection if extension context invalidated mid-session
    return () => {
      cancelled = true;
    };
  }, []);

  // 번역 언어 — the global translation target (spec 2026-07-31-lang-…).
  // Mirrors chrome.storage so a change made on the Options page while the
  // panel is open is reflected here too (and vice versa — both surfaces
  // edit the same key). Reading never writes; only the select's onChange
  // persists.
  const [targetLang, setTargetLang] = useState<TargetLang>(DEFAULT_TARGET_LANG);
  useEffect(() => {
    let cancelled = false;
    void getTargetLang().then((lang) => {
      if (!cancelled) setTargetLang(lang);
    }).catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !(TARGET_LANG_STORAGE_KEY in changes)) return;
      const next = changes[TARGET_LANG_STORAGE_KEY].newValue;
      if (TARGET_LANGS.includes(next as TargetLang)) setTargetLang(next as TargetLang);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  // DoD #2 — dump the finished transcript to the console once per
  // completion. Keyed on `videoId` (not a plain boolean) so switching to a
  // different already-`done` video dumps that video's own transcript too,
  // but re-rendering the SAME video's `done` state (e.g. a progress-unrelated
  // re-render, or the button label's elapsed-time tick while translating)
  // never re-logs. A ref rather than state: this is a one-shot side effect
  // with no corresponding UI, so it doesn't need to trigger a re-render itself.
  //
  // Gated through `isRecordCurrentForStatus` (not just `status === 'done'`):
  // without it, the stale-record render on a fail -> retry -> succeed
  // transition would consume the `dumpedVideoIdRef` guard against the OLD
  // failed record, and the correct final transcript would never get dumped
  // once the real `done` record actually arrived a moment later.
  const dumpedVideoIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'done' || videoId === null) return;
    if (!isRecordCurrentForStatus(status, record)) return;
    if (dumpedVideoIdRef.current === videoId) return;
    dumpedVideoIdRef.current = videoId;
    const rows = record.segments
      .map((s) => `${formatTimestamp(s.startSec)} | ${s.sourceText} | ${s.translatedText ?? ''}`)
      .join('\n');
    console.log(`[YT Play Assistant] translation done — ${videoId}\n${rows}`);
  }, [status, record, videoId]);

  // The list is only meaningful once the job has reached a terminal state
  // with something to show: `done` (full EN+KO) or `failed` (EN plus
  // whatever KO batches completed before the failure — Task 9's "실패 →
  // 원문만이라도 표시", handled row-by-row inside TranscriptList itself via
  // each segment's own `translatedText`). Never during
  // `extracting`/`analyzing`/`translating` — the TranslateButton's own
  // processing label already owns that phase, and `record` can still hold a
  // stale prior-video snapshot or partially-filled segments mid-flight (see
  // useTranslation's `record` doc comment) that would be misleading to render
  // as if finished.
  //
  // `isRecordCurrentForStatus` (not just `record !== null`) additionally
  // excludes the fail -> retry -> succeed transition's one-render window
  // where `status` has already flipped to `'done'`/`'failed'` but `record`
  // is still the PREVIOUS attempt's stale segments — see that function's
  // doc comment. Without it this list would flash the old attempt's rows
  // for a frame before the real ones replace them (and during a live retry,
  // where derived `status` is `'translating'` but the persisted
  // `record.status` is still `'failed'` from before, it is excluded anyway
  // by the `status === 'done' || status === 'failed'` check below).
  //
  // Computed above the `no-metadata` early return (below) rather than after
  // it: `usePlaybackSync` is a hook, and the Rules of Hooks require every
  // hook to run on every render regardless of which branch a component takes
  // — a conditional return above it would make the hook count differ
  // between the no-metadata render and every other render. `videoId === null`
  // in that branch already makes `showTranscriptList` false, so the hook
  // stays disabled (no connection attempt) there exactly as before.
  const showTranscriptList =
    (status === 'done' || status === 'failed') &&
    isRecordCurrentForStatus(status, record) &&
    record.segments.length > 0;

  // Fix round, Important #1 — the Summary tab additionally requires a DONE
  // translation: `showTranscriptList` alone is also true for `'failed'` (the
  // transcript still shows whatever source/KO rows completed before the
  // failure), but a failed video has no persisted `TranslationRecord` a
  // summary could ever be generated from — background's `runSummaryGeneration`
  // guard would just reject it. Gating the tab bar (and `useSummary` itself)
  // on this, rather than `showTranscriptList`, keeps the Summary tab from
  // ever appearing for a video that can't actually produce one.
  const showSummaryTab = showTranscriptList && status === 'done';

  // 번역 언어 mismatch (spec 2026-07-31-lang-…) — a cached record was
  // translated under a PAST `번역 언어` setting that no longer matches the
  // current one. Missing `targetLang` (records persisted before Task 3)
  // reads as `'ko'`, the only language that ever existed pre-generalization.
  const translationLangMismatch =
    showTranscriptList && record !== null && (record.targetLang ?? 'ko') !== targetLang;
  const translationLangMismatchBanner = translationLangMismatch && (
    <p className="mx-4 mt-3 rounded-[7px] bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      이 번역은 {TARGET_LANG_LABELS[record?.targetLang ?? 'ko']}본입니다 · 현재 설정 {TARGET_LANG_LABELS[targetLang]} — 다시 생성으로 교체할 수 있어요
    </p>
  );

  // Playback sync (spec §3.2): stream only while the list is on screen.
  const playback = usePlaybackSync({ videoId, tabId, enabled: showTranscriptList });
  const activeIndex =
    showTranscriptList && record !== null && playback.currentTime !== null
      ? activeSegmentIndex(record.segments, playback.currentTime)
      : null;

  // Fix round C1 — mirrors `activeIndex` into a ref so the tab-switch effect
  // below can read its current value without depending on it (that effect
  // must stay keyed on `[activeTab]` alone — see its own comment). Assigned
  // during render, same as every other hook here, so it's always current by
  // the time an effect reads it.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  // Summary tab (M3 spec §5). All hooks below live above the no-metadata
  // early return for the same Rules-of-Hooks reason documented on
  // showTranscriptList above.
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary'>('transcript');
  const summaryState = useSummary({ videoId, enabled: showSummaryTab });
  const summaryElapsedSeconds = useElapsedSeconds(summaryState.status === 'generating');

  // 번역 언어 mismatch, summary side — the summary itself has no other
  // language check (it's Gemini-generated prose, not per-segment data a
  // reader could otherwise tell apart), so this is load-bearing: without it
  // a cached summary in a stale language would render with no signal at all
  // that it doesn't match the current `번역 언어` setting.
  const summaryLangMismatch =
    summaryState.summary !== null && (summaryState.summary.targetLang ?? 'ko') !== targetLang;
  const summaryLangMismatchBanner = summaryLangMismatch && (
    <p className="mx-4 mt-3 rounded-[7px] bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      이 요약은 {TARGET_LANG_LABELS[summaryState.summary?.targetLang ?? 'ko']}본입니다 · 현재 설정 {TARGET_LANG_LABELS[targetLang]} — 다시 생성 시 함께 갱신됩니다
    </p>
  );

  // Fix round, Important #1 — if a live retry flips `status` away from
  // `'done'` while the Summary tab is showing (or the tab bar disappears for
  // any other reason `showSummaryTab` can go false mid-session), snap the
  // selection back to the one tab that's always safe to render; otherwise
  // `activeTab` could be left as `'summary'` with no tab bar to ever change
  // it back.
  useEffect(() => {
    if (!showSummaryTab) setActiveTab('transcript');
  }, [showSummaryTab]);

  // One-shot restore of the persisted tab, at the first moment BOTH are
  // true: the Summary gate is open and prefs have loaded. Keyed on both so
  // either arrival order works — if the gate opens before storage resolves
  // (or vice versa), the restore simply waits for the other. The ref makes
  // it once-per-mount: a mid-session retry that closes and reopens the gate
  // gets the snap-back's 'transcript', not a surprise jump back to Summary.
  // If the user manually clicked Summary in the gate-open/prefs-loading window,
  // activeTab is already 'summary' when the restore fires — in that case,
  // don't arm restoringTabRef (the scroll effect has no [activeTab] re-run to
  // clear it), to avoid leaking the flag into a later, unrelated click.
  const lastTabRestoredRef = useRef(false);
  const restoringTabRef = useRef(false);
  useEffect(() => {
    if (!showSummaryTab || lastTabRestoredRef.current || storedLastTab === null) return;
    lastTabRestoredRef.current = true;
    if (storedLastTab === 'summary') {
      if (activeTab !== 'summary') restoringTabRef.current = true;
      setActiveTab('summary');
    }
  }, [showSummaryTab, storedLastTab, activeTab]);

  // Fix round B2 — switching tabs must never leave the newly-active tab
  // showing wherever the previous tab happened to be scrolled to. The
  // panel's own page is the scroll container (App.tsx), not a per-tab
  // scroll area, so there is no separate scroll position to preserve or
  // restore.
  //
  // Fix round C1 — the reset is now asymmetric, not "always top" (updates
  // the B2 note above): switching TO Summary always resets to the top
  // (a summary has no notion of "current playback position" to return to).
  // Switching TO Transcript resets to the top only when there is no active
  // row (`activeIndexRef.current === null` — nothing is playing, or the
  // video hasn't reached any segment yet); when a row IS playing, this
  // effect skips the reset entirely and leaves positioning to
  // TranscriptList's OWN mount-time effect, which scrolls its active row
  // into view every time it (re)mounts — including when the user switches
  // back to the Transcript tab from Summary. That means returning to
  // Transcript during playback restores the row you were on, instead of
  // snapping to the top just to have TranscriptList immediately jump you
  // back down.
  //
  // `scrollIntoView` walks up to find the nearest scrollable ancestor on its
  // own; `block: 'start'` lands this wrapper's own top edge (where the
  // sticky tab bar sits, when it's rendered) flush with the viewport's top,
  // with the freshly-mounted tab's content immediately below it.
  // `behavior: 'instant'` — no animation, consistent with B3's button below.
  // Note: on the no-active-row path, this can still trip TranscriptList's
  // own user-scroll suspension for ~5s (its capture-phase scroll listener
  // can't distinguish this from a real user scroll) — accepted per the
  // brief, not coupled around.
  //
  // Fix round 2 (Moderate) — this effect also fired on ReadyBody's first
  // render (the tab section can already be mounted at first paint, e.g.
  // reopening the panel on a video that's already `done`), snapping the
  // freshly opened panel's scroll away from the header the instant it
  // appeared. `firstTabRenderRef` skips exactly that one mount-time run;
  // every subsequent `activeTab` change still goes through the logic above.
  //
  // Kept keyed on `[activeTab]` ONLY — `activeIndexRef` (not `activeIndex`
  // itself) is how this effect reads the current row without re-running on
  // every playback tick, which would otherwise fight TranscriptList's own
  // auto-scroll on every segment change.
  const tabSectionRef = useRef<HTMLDivElement>(null);
  const firstTabRenderRef = useRef(true);
  useEffect(() => {
    if (firstTabRenderRef.current) {
      firstTabRenderRef.current = false;
      return;
    }
    if (restoringTabRef.current) {
      restoringTabRef.current = false;
      return;
    }
    if (activeTab === 'transcript' && activeIndexRef.current !== null) return;
    tabSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [activeTab]);

  // Fix round B3 — floating scroll-to-top button visibility.
  const scrollTopVisible = useScrollTopVisible(scrollContainerRef, SCROLL_TOP_BUTTON_THRESHOLD_PX);

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

      <div className="flex gap-3 px-4">
        <div className="min-w-0 flex-1">
          <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
            자막 표시
          </span>
          <div className="mt-2 flex overflow-hidden rounded-[7px] border border-neutral-200 dark:border-neutral-800">
            {DISPLAY_MODE_OPTIONS.map(({ mode, label }, i) => {
              const selected = displayMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    displayModeTouchedRef.current = true;
                    setDisplayMode(mode);
                    void savePanelDisplayMode(mode).catch(() => {}); // swallow rejection if extension context invalidated
                  }}
                  className={`flex-1 border-0 py-2 text-[11.5px] ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-800' : ''} ${
                    selected
                      ? 'bg-neutral-100 font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 dark:bg-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex w-[104px] shrink-0 flex-col">
          <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
            번역 언어
          </span>
          <select
            value={targetLang}
            onChange={(e) => {
              const lang = e.target.value as TargetLang;
              setTargetLang(lang);
              void saveTargetLang(lang).catch(() => {});
            }}
            className="mt-2 w-full rounded-[7px] border border-neutral-200 bg-white py-2 pl-2 pr-1 text-[11.5px] text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100"
          >
            {TARGET_LANGS.map((lang) => (
              <option key={lang} value={lang}>
                {TARGET_LANG_LABELS[lang]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="p-4">
        <TranslateButton
          ready={videoId !== null && tabId !== null}
          status={status}
          progress={progress}
          error={error}
          elapsedSeconds={elapsedSeconds}
          pending={pending}
          captionAvailability={video?.captionAvailability ?? null}
          onStart={start}
        />
      </div>

      {showTranscriptList && record !== null && (
        <div ref={tabSectionRef} className="border-t border-neutral-200 dark:border-neutral-800">
          {showSummaryTab ? (
            <>
              {/* Fix round B1 — sticky within the panel's own scroll
                  container (App.tsx's `overflow-auto` div), with an opaque
                  background so scrolled-past content doesn't show through
                  underneath it. Only rendered at all when `showSummaryTab`
                  — a `failed` video's transcript-only render below has no
                  tab bar to keep on screen. */}
              <div
                className="sticky top-0 z-10 flex border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
                role="tablist"
              >
                {(
                  [
                    ['transcript', 'Transcript'],
                    ['summary', 'Summary'],
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    onClick={() => {
                      setActiveTab(tab);
                      void savePanelLastTab(tab).catch(() => {}); // swallow rejection if extension context invalidated
                    }}
                    className={`flex-1 border-0 py-2.5 text-[12px] ${
                      activeTab === tab
                        ? 'font-semibold text-neutral-900 shadow-[inset_0_-2px_0_0_currentColor] dark:text-neutral-100'
                        : 'text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {activeTab === 'transcript' ? (
                <>
                  {translationLangMismatchBanner}
                  <TranscriptList
                    segments={record.segments}
                    displayMode={displayMode}
                    activeIndex={activeIndex}
                    onSeekRow={(segment) => playback.seek(segment.startSec)}
                  />
                </>
              ) : (
                <>
                  {summaryLangMismatchBanner}
                  <SummaryPanel
                    summary={summaryState.summary}
                    status={summaryState.status}
                    error={summaryState.error}
                    elapsedSeconds={summaryElapsedSeconds}
                    onGenerate={summaryState.generate}
                    onSeekSection={(startSec) => playback.seek(startSec)}
                  />
                </>
              )}
            </>
          ) : (
            // Fix round, Important #1 — a `failed` video (or any other case
            // where `showSummaryTab` is false): no tab bar, transcript
            // always renders, with the original pre-Summary-tab micro-label
            // restored exactly as it looked before this feature existed.
            <>
              <div className="px-4 pt-3.5">
                <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
                  번역 결과
                </span>
              </div>
              {translationLangMismatchBanner}
              <TranscriptList
                segments={record.segments}
                displayMode={displayMode}
                activeIndex={activeIndex}
                onSeekRow={(segment) => playback.seek(segment.startSec)}
              />
            </>
          )}
        </div>
      )}

      {scrollTopVisible && (
        <button
          type="button"
          onClick={() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' })}
          aria-label="맨 위로"
          className="fixed bottom-4 right-6 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900/85 text-sm text-white shadow-lg hover:bg-neutral-900 dark:bg-neutral-100/85 dark:text-neutral-900 dark:hover:bg-neutral-100"
        >
          ↑
        </button>
      )}
    </>
  );
}

// M2 Task 8 — the §9 `AI 자막 생성` state machine:
// - not `ready` (videoId/tabId not resolved yet): disabled, neutral label —
//   `useTranslation`'s own `start()` already no-ops in this state, so this
//   just keeps the button from looking clickable when it silently wouldn't
//   do anything.
// - `pending` (Task R7, Fix 2A): disabled "요청 중…", regardless of `status` —
//   see `pending`'s own doc comment on `useTranslation` for why this exists
//   and how it clears. Checked right after `!ready` (a click can only ever
//   set `pending` while `ready`, so this ordering never actually matters in
//   practice, but keeping the "can this even be true right now" checks
//   first reads clearest).
// - `idle`: enabled, kicks off `start()` — UNLESS (Task R7, Fix 3) this
//   video's `captionAvailability` is known to be `'none'`, in which case
//   there is nothing to generate from and the button is disabled with that
//   explained instead.
// - `extracting`/`analyzing`/`translating`: disabled with a step-aware
//   label (phase, chunk, and elapsed-time detail while translating).
// - `done`: disabled, reads as complete, PLUS (Task 10) a secondary
//   `다시 생성` affordance calling the same `start()` — otherwise a cached
//   `done` video could never be re-checked against YouTube's current
//   captions. `start()` re-runs `START_TRANSLATION`, and the pipeline's own
//   cache decision (pipeline.ts, untouched by Task 10) takes it from there:
//   same `captionHash` -> near-instant cache-hit return (see pipeline.ts's
//   "returns the existing record as-is with no Gemini calls" cache-hit
//   test), different hash -> a fresh skeleton, i.e. an actual regeneration.
//   This is user-initiated, not automatic, so it does not reintroduce a
//   revisit-time re-scrape.
// - `failed`: re-enabled as a 다시 시도 retry affordance, with the failure
//   reason surfaced above it — translated to Korean via
//   `translationErrorDisplay` (Task R7, Fix 2B) rather than shown as the raw
//   pipeline reason string.
function TranslateButton({
  ready,
  status,
  progress,
  error,
  elapsedSeconds,
  pending,
  captionAvailability,
  onStart,
}: {
  ready: boolean;
  status: TranslationStatus | 'idle';
  progress: TranslationProgressState | null;
  error: string | null;
  elapsedSeconds: number;
  pending: boolean;
  captionAvailability: CaptionAvailability | null;
  onStart: () => void;
}) {
  if (!ready) {
    return (
      <Button disabled aria-disabled className="w-full">
        준비 중…
      </Button>
    );
  }

  if (pending) {
    return (
      <Button disabled aria-disabled className="w-full">
        요청 중…
      </Button>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-col gap-2">
        {error ? (
          <p className="text-[11.5px] leading-relaxed text-red-600 dark:text-red-400">
            {translationErrorDisplay(error)}
          </p>
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
        {/* Task R2: a pulsing dot is the "still working" liveness signal
            during step 3, alongside the elapsed-time text baked into
            `processingLabel` below — neither causes layout shift (fixed-size
            dot, text length varies but the button itself doesn't resize). */}
        {status === 'translating' && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />
        )}
        <span>{processingLabel(status, progress, elapsedSeconds)}</span>
      </Button>
    );
  }

  if (status === 'done') {
    return (
      <div className="flex items-center gap-2">
        <Button disabled aria-disabled className="flex-1">
          번역 완료
        </Button>
        <Button
          variant="secondary"
          onClick={onStart}
          className="shrink-0"
          title="자막이 바뀌었다면 새로 생성합니다"
        >
          다시 생성
        </Button>
      </div>
    );
  }

  // 'idle'. Task R7 (Fix 3): a video the extraction pipeline already knows
  // has NO captions at all can't produce anything for `AI 자막 생성` to work
  // from — gate on the exact `'none'` value only. `'unknown'`/`'auto-only'`/
  // `null` all leave the button enabled: `'unknown'`/`null` genuinely don't
  // know yet (a post-SPA DOM read, or nothing read at all — see
  // `CaptionAvailability`'s own doc comment), and `'auto-only'` DOES have a
  // transcript panel (auto-generated captions still populate one), so there
  // is something real for the pipeline to extract either way.
  if (captionAvailability === 'none') {
    return (
      <Button disabled aria-disabled className="w-full">
        자막 없음 — 생성 불가
      </Button>
    );
  }

  return (
    <Button onClick={onStart} className="w-full">
      AI 자막 생성
    </Button>
  );
}

function processingLabel(
  status: 'extracting' | 'analyzing' | 'translating',
  progress: TranslationProgressState | null,
  elapsedSeconds: number,
): string {
  if (status === 'extracting') return 'Transcript 추출 중…';
  if (status === 'analyzing') return '용어 분석 중…';
  // 'translating' is the only step whose progress event carries a live
  // sub-phase (pipeline.ts emits `sending`/`receiving`/`parsing` per chunk,
  // M2 refactor §4 — no more per-segment counter). `progress` can still
  // briefly be `null` here — e.g. a panel reopened onto an already-
  // `translating` record whose status came from the initial GET_TRANSLATION
  // fetch, before this session's own Port has delivered a first message for
  // the resumed job.
  // Task R2: the elapsed-time suffix is always appended while translating
  // (even with `progress === null`) — this is the panel-side liveness
  // signal the pulsing dot alone doesn't fully cover, and it's available
  // regardless of whether a Port message has arrived yet.
  const elapsedSuffix = ` · ${formatElapsedTime(elapsedSeconds)}`;
  if (progress === null) return `번역 중…${elapsedSuffix}`;
  const phaseLabel = translatePhaseLabel(progress.phase);
  // Multi-chunk videos (2hr+) additionally show which chunk is in progress;
  // most videos are a single chunk, where this suffix would just be a
  // redundant "1/1" — omitted in that case.
  const chunkSuffix = progress.totalChunks > 1 ? ` (${progress.chunkIndex}/${progress.totalChunks})` : '';
  const base = phaseLabel ? `번역 중… ${phaseLabel}${chunkSuffix}` : `번역 중…${chunkSuffix}`;
  return `${base}${elapsedSuffix}`;
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
