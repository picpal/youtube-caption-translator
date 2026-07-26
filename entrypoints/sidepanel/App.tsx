import { useEffect, useState } from 'react';
import { Button } from '~/components/Button';
import { StatusBadge } from '~/components/StatusBadge';
import { useApiKey } from '~/features/api-key/useApiKey';

type TabKind = 'checking' | 'youtube' | 'other';

// The panel's host_permissions only cover youtube.com, so `tab.url` reads as
// undefined on any other origin — that's Chrome enforcing the permission
// boundary, not a bug. isYoutubeWatchUrl treats an unreadable url the same as
// a non-YouTube tab (falls through to `other`), which is the correct result
// either way.
function isYoutubeWatchUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      /(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.pathname === '/watch'
    );
  } catch {
    return false;
  }
}

export function App() {
  const { status } = useApiKey();
  const [tabKind, setTabKind] = useState<TabKind>('checking');

  const loading = status === null;
  const present = status?.present === true;
  const ready = present && tabKind === 'youtube';

  useEffect(() => {
    let cancelled = false;
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (cancelled) return;
      setTabKind(isYoutubeWatchUrl(tab?.url) ? 'youtube' : 'other');
    });
    return () => {
      cancelled = true;
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
          <button
            type="button"
            onClick={() => window.close()}
            aria-label="패널 닫기"
            className="flex h-6 w-6 items-center justify-center rounded-[5px] text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
      </header>

      {ready ? (
        <div className="flex-1 overflow-auto">
          <ReadyBody />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6">
          {loading ? <LoadingBody /> : present ? <NonYoutubeBody /> : <OnboardingBody />}
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
function ReadyBody() {
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

      <div className="mx-4 mb-4 flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="block h-1.5 w-1.5 flex-none rounded-full bg-neutral-400 dark:bg-neutral-600" />
        <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
          자막 정보 확인 중
        </span>
      </div>

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
        <Button disabled aria-disabled className="w-full">
          AI 자막 생성
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-t border-neutral-200 px-4 py-3.5 dark:border-neutral-800">
        <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
          처리 단계
        </span>
        <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
          <span>1 Transcript 추출</span>
          <span className="text-neutral-300 dark:text-neutral-700">→</span>
          <span>2 용어 분석</span>
          <span className="text-neutral-300 dark:text-neutral-700">→</span>
          <span>3 한국어 번역</span>
          <span className="text-neutral-300 dark:text-neutral-700">→</span>
          <span>4 자막 적용</span>
        </div>
        <span className="text-[10.5px] text-neutral-400 dark:text-neutral-600">
          약 40초 소요 · 처리 중에도 영상은 계속 재생됩니다
        </span>
      </div>
    </>
  );
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
