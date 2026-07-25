import { useState } from 'react';
import { Button } from '~/components/Button';
import { Input } from '~/components/Input';
import { StatusBadge } from '~/components/StatusBadge';
import { useApiKey } from '~/features/api-key/useApiKey';

export function App() {
  const { status, saveState, testState, save, remove, test } = useApiKey();
  const [draft, setDraft] = useState('');

  const isPresent = status?.present === true;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">설정</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          YouTube Play Assistant를 사용하려면 Gemini API 키를 등록해주세요.
        </p>
      </header>

      <section className="mb-10 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium">Gemini API 키</h2>
          {isPresent && status && (
            <StatusBadge tone="ok">
              {status.maskedKey} 저장됨 · {new Date(status.savedAt).toLocaleDateString('ko-KR')}
            </StatusBadge>
          )}
        </div>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          Google AI Studio에서 무료로 발급받을 수 있습니다.{' '}
          <a
            className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
          >
            API 키 발급받기 →
          </a>
        </p>
        <div className="flex flex-col gap-4">
          <Input
            id="gemini-key"
            label="API 키"
            type="password"
            revealable
            placeholder={isPresent ? '새 키로 교체하려면 여기에 입력' : 'AIza…'}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              onClick={async () => {
                const ok = await save(draft);
                if (ok) setDraft('');
              }}
              disabled={saveState.kind === 'saving' || draft.trim().length === 0}
            >
              {saveState.kind === 'saving' ? '저장 중…' : '저장'}
            </Button>
            {isPresent && (
              <Button variant="danger" onClick={remove}>
                삭제
              </Button>
            )}
            {saveState.kind === 'success' && (
              <StatusBadge tone="ok">저장되었습니다. 연결 테스트를 권장합니다.</StatusBadge>
            )}
            {saveState.kind === 'error' && (
              <StatusBadge tone="error">저장 실패: {saveState.message}</StatusBadge>
            )}
          </div>
        </div>
      </section>

      <section className="mb-10 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-3 text-lg font-medium">연결 테스트</h2>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          저장된 키로 Gemini API에 짧은 요청을 보내 응답을 확인합니다.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={test}
            disabled={!isPresent || testState.kind === 'testing'}
          >
            {testState.kind === 'testing' ? '테스트 중…' : '테스트 요청 보내기'}
          </Button>
          <TestStateBadge state={testState} />
        </div>
      </section>

      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-2 text-lg font-medium">무료 티어 안내</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Gemini 2.5 Flash 무료 티어는 분당·일별 요청 수 제한이 있습니다. 자세한 한도는{' '}
          <a
            className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
            href="https://ai.google.dev/pricing"
            target="_blank"
            rel="noreferrer"
          >
            공식 요금 페이지
          </a>
          에서 확인하세요.
        </p>
      </section>
    </main>
  );
}

function TestStateBadge({ state }: { state: ReturnType<typeof useApiKey>['testState'] }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'testing':
      return <StatusBadge tone="muted">요청 중…</StatusBadge>;
    case 'ok':
      return (
        <StatusBadge tone="ok">
          ✓ 정상 응답 · {state.latencyMs}ms · {state.model}
        </StatusBadge>
      );
    case 'unauthorized':
      return <StatusBadge tone="error">✗ 401 · API 키를 확인해주세요 ({state.message})</StatusBadge>;
    case 'rate_limit':
      return <StatusBadge tone="warn">⚠ 429 · 잠시 후 다시 시도해주세요 ({state.message})</StatusBadge>;
    case 'network':
      return <StatusBadge tone="error">네트워크 오류: {state.message}</StatusBadge>;
    case 'unknown':
      return <StatusBadge tone="error">알 수 없는 오류: {state.message}</StatusBadge>;
  }
}
