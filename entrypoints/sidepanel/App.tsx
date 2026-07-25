import { Button } from '~/components/Button';
import { StatusBadge } from '~/components/StatusBadge';
import { useApiKey } from '~/features/api-key/useApiKey';

export function App() {
  const { status } = useApiKey();
  const loading = status === null;
  const present = status?.present === true;

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

      <div className="flex-1 overflow-auto p-6">
        {loading ? <LoadingBody /> : present ? <ReadyBody /> : <OnboardingBody />}
      </div>
    </div>
  );
}

function LoadingBody() {
  return (
    <p className="text-sm text-neutral-500 dark:text-neutral-400">불러오는 중…</p>
  );
}

function ReadyBody() {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
      M1에서 영상 인식과 자막 생성 기능이 추가됩니다.
    </div>
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
