# Playback Sync — 클릭 시크 + 시간 동기 하이라이트 설계

날짜: 2026-07-29 · 상태: 승인됨 (A안: 패널↔CS 직결 Port)
선행: M2 완료 (`v0.1.0-m2`), transcript-open SPA 핫픽스 (`30a4b9c`)

## 1. 목표

번역 자막 리스트와 영상 재생을 양방향으로 연동한다.

1. **클릭 시크**: 자막 행 클릭 → 영상이 해당 세그먼트의 `startSec`으로 이동한다.
2. **시간 동기 하이라이트**: 재생 위치에 해당하는 자막 행이 강조되고, 리스트가 그 행을 따라 자동
   스크롤한다.

성공 기준(실 Chrome): 행 클릭 시 `video.currentTime`이 해당 `startSec`으로 점프하고, 재생 중
하이라이트가 현재 발화 행을 따라가며, SPA 이동·탭 전환 후에도 크래시 없이 재연결된다.

## 2. 전송 구조 — 패널↔CS 직결 Port (승인된 결정)

패널이 `chrome.tabs.connect(tabId, { name: PLAYBACK_PORT })`로 콘텐츠 스크립트에 **직접**
연결한다. 이 포트 하나로 양방향을 처리한다:

- CS → 패널: `{ t: number, paused: boolean }` — video `timeupdate`를 스로틀(500ms)한 스트림.
  seek/play/pause 이벤트 시에는 스로틀을 건너뛰고 즉시 1회 전송(반응성).
- 패널 → CS: `{ type: 'seek', seconds: number }` — CS가 `video.currentTime = seconds` 설정.
  재생/일시정지 상태는 변경하지 않는다.

**M2 제약의 의도적 개정**: M2 goal의 "패널은 bg에만 말한다"는 요청-트리거 스크래핑(단발
요청/응답)을 단순화하기 위한 제약이었다. 주기적 재생 스트림을 SW 경유로 보내면 초당 1회
메시지가 시청 내내 SW를 깨워 두어, keepalive를 파이프라인 구간으로 한정한 M2의 설계 의도와
충돌한다. 직결 Port는 SW를 전혀 관여시키지 않으며(연결·메시지 모두 SW 미경유), host
permission으로 충분해 새 권한이 필요 없다. **재생 연동에 한해** 직결을 허용하고, 번역
파이프라인 트리거·조회는 기존대로 bg 경유를 유지한다.

기각한 대안: (B) SW 경유 폴링/스트림 — SW 상시 기상 비용. (C) 패널 로컬 시계 추정 — 유저
스크럽 시 어긋남, 이득 없음.

## 3. 컴포넌트

### 3.1 CS: playback 포트 핸들러 (`entrypoints/content.ts`)
- `chrome.runtime.onConnect`로 `PLAYBACK_PORT` 수락. 패널이 보내는 **첫 메시지는 반드시**
  `{ type: 'init', videoId }`이며, CS는 이를 `ytd-watch-flexy[video-id]`와 대조해 불일치 시 즉시
  disconnect한다(§6a 스테일 게이트와 동일한 이유). init 이전에는 스트림을 시작하지 않는다.
- video 요소: `#movie_player video`(폴백 `document.querySelector('video')`).
- `timeupdate` 리스너 + 500ms 스로틀 전송, `seeked`/`play`/`pause`는 즉시 전송.
- `seek` 명령 수신 → `video.currentTime = seconds`.
- 포트 disconnect 시 리스너 해제(누수 방지). SPA 이동으로 video-id가 바뀌면 CS가 포트를 끊는다
  (기존 내비게이션 감지 훅에 연결) → 패널이 재연결을 담당.

### 3.2 패널 훅: `usePlaybackSync({ videoId, tabId, enabled })` (`src/features/playback/`)
- 반환: `{ currentTime: number | null, seek(seconds: number): void }`.
- `enabled`일 때만 연결(번역 리스트가 보일 때 — ReadyBody의 `showTranscriptList`와 동일 조건).
- `onDisconnect` → 표시는 유지하되 스트림 중단; 재연결은 lazy(다음 seek 호출 시 즉시 +
  주기 재시도 타이머). M2 useTranslation의 lazy-reconnect 패턴 재사용.
- `videoId`/`tabId` 변경 시 기존 포트 정리 후 재설정(effect 규율은 기존 훅들과 동일).

### 3.3 리스트: `TranscriptList` 확장 (`src/components/TranscriptList.tsx`)
- 새 props: `activeIndex: number | null`, `onSeekRow?: (segment) => void`.
- **행 전체가 클릭 대상**(유튜브 자체 transcript 패널 관례). hover 배경 + `cursor-pointer`,
  키보드 접근(`role="button"` 상당 + Enter) — 기존 스타일 관례에 맞춰 구현.
- `activeIndex` 행: 강조 스타일 + 자동 스크롤(`scrollIntoView({ block: 'nearest' })`).
- **자동 스크롤 정지**: 유저가 리스트를 직접 스크롤하면 ~5초간 자동 스크롤을 멈춘다(하이재킹
  방지). 정지/재개 판단은 순수 함수로 추출.

### 3.4 활성 행 계산 (`src/lib/` 순수 로직, TDD)
- `activeSegmentIndex(segments, t)`: `startSec` 오름차순 전제, `startSec <= t`인 마지막 인덱스
  (이진 탐색). `t`가 첫 세그먼트 이전이면 `null`.

## 4. 알려진 한계 (수용)

- 세그먼트가 ~220자 병합 단위라 시크·하이라이트 granularity가 행당 10~20초. M3 백로그의
  `MERGE_TARGET_CHARS` 재검토와 연결되며 이번 범위에서 다루지 않는다.
- 백그라운드 탭에서는 패널이 안 보이므로(사이드패널은 활성 탭 기준) 스트림 유휴 낭비 없음.

## 5. 검증

- vitest: `activeSegmentIndex` 경계(이전/정확히 시작/사이/마지막 이후), 스로틀 판단, 스크롤
  정지 판단 — 순수 함수 단위 테스트. 기존 게이트(tsc 0 · 전체 테스트 · build) 유지.
- 실 Chrome(CDP): ① 행 클릭 → `video.currentTime` 점프 실측 ② 재생 중 하이라이트가 행을
  따라감 ③ SPA 이동 후 재연결·무크래시 ④ 시크가 재생/일시정지 상태를 바꾸지 않음.

## 6. 비범위

- 시간 동기 강조의 세그먼트 내 진행률 표시, 요약 패널, 표시모드 영속화, 패널 단축키(전부 M3
  백로그의 별도 항목).
