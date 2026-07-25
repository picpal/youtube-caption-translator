import { useEffect, useState } from 'react';
import { Button } from '~/components/Button';
import { StatusBadge } from '~/components/StatusBadge';
import { useApiKey } from '~/features/api-key/useApiKey';

type TabKind = 'checking' | 'youtube' | 'other';

async function openSidePanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
}

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
    <div className="flex w-[360px] flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3.5 py-2.5 dark:border-neutral-800">
        <span className="block h-3.5 w-3.5 rounded-[3px] bg-neutral-900 dark:bg-neutral-100" />
        <h1 className="truncate text-xs font-semibold tracking-tight">
          YouTube Play Assistant
        </h1>
        <span className="ml-auto">
          <StatusBadge tone={loading ? 'muted' : present ? 'ok' : 'warn'}>
            {loading ? '확인 중' : present ? '준비됨' : '설정 필요'}
          </StatusBadge>
        </span>
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          aria-label="설정"
          title="설정"
          className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <GearIcon />
        </button>
      </header>

      {loading ? (
        <LoadingBody />
      ) : !present ? (
        <OnboardingBody />
      ) : tabKind === 'youtube' ? (
        <ReadyBody />
      ) : (
        <NonYoutubeBody />
      )}
    </div>
  );
}

function LoadingBody() {
  return (
    <div className="p-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
      불러오는 중…
    </div>
  );
}

function OnboardingBody() {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-8 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
        <KeyIcon />
      </div>
      <div>
        <h2 className="text-sm font-semibold">API 키를 등록해주세요</h2>
        <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
          번역과 요약을 위해 Gemini API 키가 필요합니다. 개인 학습용이라면 Google AI Studio에서 무료로 발급할 수 있습니다.
        </p>
      </div>
      <Button size="sm" onClick={() => chrome.runtime.openOptionsPage()}>
        설정 열기
      </Button>
    </div>
  );
}

function NonYoutubeBody() {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-8 text-center">
      <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        유튜브 영상 페이지로 이동해주세요
      </p>
      <Button variant="secondary" size="sm" onClick={openSidePanel}>
        패널 열기
      </Button>
    </div>
  );
}

function ReadyBody() {
  return (
    <>
      <div className="flex gap-2.5 px-3.5 pb-3 pt-3.5">
        <div className="h-[50px] w-[88px] flex-none rounded-[5px] bg-[repeating-linear-gradient(135deg,#eceef0_0_6px,#e3e6e9_6px_12px)] dark:bg-[repeating-linear-gradient(135deg,#2a2d31_0_6px,#23262a_6px_12px)]" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-semibold leading-snug text-neutral-500 dark:text-neutral-400">
            영상 정보 로딩 중
          </span>
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500">—</span>
        </div>
      </div>

      <div className="mx-3.5 mb-3.5 flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="block h-1.5 w-1.5 flex-none rounded-full bg-neutral-400 dark:bg-neutral-600" />
        <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
          자막 정보 확인 중
        </span>
      </div>

      <div className="px-3.5">
        <span className="text-[10.5px] font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
          자막 표시
        </span>
        <div className="mt-1.5 flex overflow-hidden rounded-[7px] border border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            className="flex-1 border-0 bg-neutral-100 py-1.5 text-[11.5px] font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          >
            영한 동시
          </button>
          <button
            type="button"
            className="flex-1 border-0 border-l border-neutral-200 bg-white py-1.5 text-[11.5px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            한국어
          </button>
          <button
            type="button"
            className="flex-1 border-0 border-l border-neutral-200 bg-white py-1.5 text-[11.5px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            영어
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 p-3.5">
        <Button disabled aria-disabled className="w-full">
          AI 자막 생성
        </Button>
        <Button variant="secondary" className="w-full" onClick={openSidePanel}>
          패널 열기
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-neutral-200 px-3.5 py-2.5 dark:border-neutral-800">
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

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.05a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.05a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.05a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
