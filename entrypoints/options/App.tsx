import { useState } from 'react';
import { Button } from '~/components/Button';
import { Input } from '~/components/Input';
import { StatusBadge } from '~/components/StatusBadge';
import { useApiKey } from '~/features/api-key/useApiKey';

// Ported from docs/design/api-key-settings.dc.html
// Section "3A — API 키 관리 — Options 페이지 · Side Panel"
// Only "1 · OPTIONS PAGE" (dark: L30-107, light: L315-392) plus the
// state-pattern call-outs "4 · 저장 / 검증 피드백" (L196-240 / L478-522) and
// "5 · 연결 테스트 결과" (L243-273 / L525-555) are ported here — those two
// blocks aren't Side Panel mockups, they're the save/test feedback states
// this very page needs to cover all 6+1 test-state kinds. The "SIDE PANEL"
// labelled blocks (2, 3) are intentionally skipped per brief.
export function App() {
  const { status, saveState, testState, save, remove, test } = useApiKey();
  const [draft, setDraft] = useState('');

  const isPresent = status?.present === true;

  return (
    <div className="flex min-h-screen justify-center bg-[#f2f2f3] px-4 py-10 dark:bg-[#0f0f0f] sm:px-8 md:py-16">
      <div className="h-fit w-full max-w-[920px] overflow-hidden rounded-[10px] border border-[#e4e4e6] bg-white shadow-[0_12px_32px_rgba(16,18,22,.08)] dark:border-[#292929] dark:bg-[#141414] dark:shadow-[0_16px_40px_rgba(0,0,0,.5)]">
        {/* title bar chrome */}
        <div className="flex items-center gap-2.5 border-b border-[#eeeeef] bg-[#fbfbfc] px-6 py-3.5 dark:border-[#262626] dark:bg-[#171717]">
          <span className="block h-4 w-4 rounded-[4px] bg-[#17181a] dark:bg-[#ededed]" />
          <span className="text-[13px] font-semibold text-[#17181a] dark:text-[#ededed]">
            YouTube Play Assistant
          </span>
          <span className="text-[13px] text-[#b3b6bb] dark:text-[#6f6f6f]">/</span>
          <span className="text-[13px] text-[#3d4045] dark:text-[#c9c9c9]">설정</span>
          <div className="ml-auto">
            {status === null ? (
              <StatusBadge tone="muted" variant="pill">
                확인 중
              </StatusBadge>
            ) : isPresent ? (
              <StatusBadge tone="ok" variant="pill">
                키 등록됨
              </StatusBadge>
            ) : (
              <StatusBadge tone="muted" variant="pill">
                키 없음
              </StatusBadge>
            )}
          </div>
        </div>

        {/* content */}
        <div className="flex max-w-[660px] flex-col gap-3.5 px-6 pb-6 pt-7">
          {/* Gemini API 키 */}
          <section className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-sm font-semibold tracking-tight text-[#17181a] dark:text-[#ededed]">
                Gemini API 키
              </h2>
              <p className="text-[12.5px] leading-relaxed text-[#6c6f74] dark:text-[#9a9a9a]">
                Google AI Studio에서 무료로 발급받을 수 있습니다. 키는 이 브라우저의{' '}
                <code className="rounded border border-[#e8e8ea] bg-[#f2f2f3] px-[5px] py-px font-mono text-[11.5px] text-[#3d4045] dark:border-[#2c2c2c] dark:bg-[#1e1e1e] dark:text-[#c9c9c9]">
                  chrome.storage.local
                </code>{' '}
                에만 저장되며, 별도 서버로 전송되지 않습니다.
              </p>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 w-fit border-b border-[#d8d8da] pb-px text-[12.5px] font-semibold text-[#17181a] dark:border-[#3a3a3a] dark:text-[#ededed]"
              >
                API 키 발급받기 →
              </a>
            </div>

            <div className="mt-1.5 flex gap-2">
              <Input
                id="gemini-key"
                aria-label="Gemini API 키"
                type="password"
                revealable
                invalid={saveState.kind === 'error'}
                className="flex-1"
                placeholder={isPresent ? '새 키로 교체하려면 여기에 입력' : 'AIza…'}
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
              />
              <Button
                onClick={async () => {
                  const ok = await save(draft);
                  if (ok) setDraft('');
                }}
                disabled={saveState.kind === 'saving' || draft.trim().length === 0}
              >
                {saveState.kind === 'saving' ? (
                  <>
                    <Spinner /> 저장 중
                  </>
                ) : (
                  '저장'
                )}
              </Button>
            </div>

            {saveState.kind === 'error' && (
              <div className="flex items-start gap-2">
                <span className="text-xs leading-relaxed text-[oklch(0.55_0.17_25)] dark:text-[oklch(0.68_0.17_25)]">
                  !
                </span>
                <span className="text-xs leading-relaxed text-[#17181a] dark:text-[#e4e4e4]">
                  저장 실패: {saveState.message}
                </span>
              </div>
            )}

            {saveState.kind === 'success' && (
              <StatusBadge tone="ok" variant="chip">
                저장되었습니다 · 연결 테스트를 권장합니다
              </StatusBadge>
            )}

            {isPresent && status && (
              <div className="flex items-center gap-2.5 rounded-[7px] border border-[#e4e4e6] bg-[#f7f7f8] px-3 py-2.5 dark:border-[#2a2a2a] dark:bg-[#181818]">
                <span className="block h-1.5 w-1.5 flex-none rounded-full bg-[oklch(0.60_0.13_150)] dark:bg-[oklch(0.68_0.13_150)]" />
                <span className="font-mono text-[11.5px] tracking-[0.06em] text-[#2c2f33] dark:text-[#dcdcdc]">
                  {status.maskedKey}
                </span>
                <span className="text-[11.5px] tabular-nums text-[#6c6f74] dark:text-[#9a9a9a]">
                  저장됨 · {new Date(status.savedAt).toLocaleDateString('ko-KR')}
                </span>
                <Button variant="secondary" size="xs" className="ml-auto" onClick={remove}>
                  삭제
                </Button>
              </div>
            )}
          </section>

          <div className="my-1.5 h-px bg-[#eeeeef] dark:bg-[#262626]" />

          {/* 연결 테스트 */}
          <section className="flex flex-col gap-2.5">
            <h2 className="text-sm font-semibold text-[#17181a] dark:text-[#ededed]">연결 테스트</h2>
            <p className="text-[12.5px] leading-relaxed text-[#6c6f74] dark:text-[#9a9a9a]">
              저장한 키로 실제 요청을 한 번 보내 응답과 지연 시간을 확인합니다.
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={test}
                disabled={!isPresent || testState.kind === 'testing'}
              >
                테스트 요청 보내기
              </Button>
              <TestStateBadge state={testState} />
            </div>
          </section>

          <div className="my-1.5 h-px bg-[#eeeeef] dark:bg-[#262626]" />

          {/* 무료 티어 안내 */}
          <section className="flex flex-col gap-2.5">
            <h2 className="text-sm font-semibold text-[#17181a] dark:text-[#ededed]">무료 티어 안내</h2>
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[#eeeeef] bg-[#eeeeef] tabular-nums dark:border-[#2a2a2a] dark:bg-[#2a2a2a] sm:grid-cols-3">
              <div className="flex flex-col gap-0.5 bg-white px-3.5 py-3 dark:bg-[#181818]">
                <span className="text-[17px] font-semibold text-[#17181a] dark:text-[#ededed]">250</span>
                <span className="text-[10.5px] text-[#8a8d92] dark:text-[#7a7a7a]">일일 요청 (무료 티어)</span>
              </div>
              <div className="flex flex-col gap-0.5 bg-white px-3.5 py-3 dark:bg-[#181818]">
                <span className="text-[17px] font-semibold text-[#17181a] dark:text-[#ededed]">10 RPM</span>
                <span className="text-[10.5px] text-[#8a8d92] dark:text-[#7a7a7a]">분당 요청 한도</span>
              </div>
              <div className="flex flex-col gap-0.5 bg-white px-3.5 py-3 dark:bg-[#181818]">
                <span className="text-[17px] font-semibold text-[#17181a] dark:text-[#ededed]">≈ 4~6</span>
                <span className="text-[10.5px] text-[#8a8d92] dark:text-[#7a7a7a]">1시간 영상 1편당 요청</span>
              </div>
            </div>
            <p className="text-[11.5px] leading-relaxed text-[#8a8d92] dark:text-[#7a7a7a]">
              한도는 Google 정책에 따라 변경될 수 있습니다. 한도 초과 시 번역은 중단되고 추출된 Transcript는
              유지됩니다.
            </p>
            <a
              href="https://ai.google.dev/pricing"
              target="_blank"
              rel="noreferrer"
              className="w-fit border-b border-[#d8d8da] pb-px text-[12.5px] font-semibold text-[#17181a] dark:border-[#3a3a3a] dark:text-[#ededed]"
            >
              무료 티어 정보 →
            </a>
          </section>
        </div>

        {/* footer chrome — version only; the design's GitHub / 변경 내역 links
            point nowhere real in this project, so they're omitted rather than
            shipped as dead links */}
        <div className="flex items-center gap-3 border-t border-[#eeeeef] bg-[#fbfbfc] px-6 py-3 dark:border-[#262626] dark:bg-[#171717]">
          <span className="font-mono text-[10.5px] tabular-nums text-[#9a9da2] dark:text-[#6f6f6f]">
            v0.0.1 · Manifest V3
          </span>
        </div>
      </div>
    </div>
  );
}

function TestStateBadge({ state }: { state: ReturnType<typeof useApiKey>['testState'] }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'testing':
      return (
        <StatusBadge tone="muted" variant="chip">
          <Spinner /> 테스트 요청 중…
        </StatusBadge>
      );
    case 'ok':
      return (
        <StatusBadge tone="ok" variant="chip">
          정상 응답 · {state.latencyMs}ms ·{' '}
          <span className="font-mono text-[11px] text-[#6c6f74] dark:text-[#9a9a9a]">{state.model}</span>
        </StatusBadge>
      );
    case 'unauthorized':
      return (
        <StatusBadge tone="error" variant="chip">
          401 Unauthorized · API 키를 확인해주세요 ({state.message})
        </StatusBadge>
      );
    case 'rate_limit':
      return (
        <StatusBadge tone="warn" variant="chip">
          429 Rate Limit · 잠시 후 다시 시도해주세요 ({state.message})
        </StatusBadge>
      );
    case 'network':
      return (
        <StatusBadge tone="error" variant="chip">
          네트워크 오류: {state.message}
        </StatusBadge>
      );
    case 'unknown':
      return (
        <StatusBadge tone="error" variant="chip">
          알 수 없는 오류: {state.message}
        </StatusBadge>
      );
  }
}

function Spinner() {
  return (
    <span className="block h-3 w-3 flex-none animate-spin rounded-full border-2 border-[#9a9a9a] border-t-transparent" />
  );
}
