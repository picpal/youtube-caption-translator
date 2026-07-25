# Implementation Plan — YouTube Play Assistant

- 관련 문서: [PRD.md](./PRD.md)
- 저장소: https://github.com/picpal/youtube-play-assistant.git
- 작성일: 2026-07-25
- 원칙: 개인용 · MVP 우선 · 각 마일스톤마다 실제로 유튜브에서 동작 확인

---

## 0. 확정 사항

| 항목 | 결정 |
|---|---|
| 프레임워크 | wxt |
| UI | React 18 + TypeScript |
| 스타일링 | Tailwind CSS |
| AI 모델 | Gemini 2.5 Flash (Google AI Studio 무료 티어) |
| 저장소 | `chrome.storage.local` (설정·키), IndexedDB (자막·번역·북마크) |
| Side Panel | Chrome Side Panel API |
| Content Script | 자막 오버레이 + 재생 시간 동기화만 |
| Background SW | API 키 접근·Gemini 호출·캐시 관리 |
| 저장소 호스팅 | GitHub (`picpal/youtube-play-assistant`) |

---

## 1. 아키텍처

```
┌─────────────────────────────────────────────────────┐
│  Chrome                                             │
│                                                     │
│  ┌───────────────┐   ┌──────────────────────────┐   │
│  │ Content Script│◄──┤ Background Service Worker│   │
│  │ (youtube.com) │   │  - API key 접근          │   │
│  │  - 오버레이   │   │  - Gemini 호출           │   │
│  │  - 재생시간   │──►│  - 캐시 관리 (IndexedDB) │   │
│  └───────┬───────┘   └──────────┬───────────────┘   │
│          │                       │                  │
│          │  messages             │  storage         │
│          ▼                       ▼                  │
│  ┌───────────────┐   ┌──────────────────────────┐   │
│  │ Side Panel    │   │ Options 페이지           │   │
│  │  - Transcript │   │  - API 키 관리           │   │
│  │  - Summary    │   │  - 자막 옵션             │   │
│  │  - Bookmarks  │   │  - 연결 테스트           │   │
│  │  - Export     │   └──────────────────────────┘   │
│  └───────────────┘                                  │
│          ▲                                          │
│          │                                          │
│    chrome.storage.local (settings, api_key)         │
│    IndexedDB (video cache, bookmarks)               │
└─────────────────────────────────────────────────────┘
```

**보안 원칙**: API 키는 Service Worker 컨텍스트에만 존재. Content Script는 `{ type: 'TRANSLATE', payload }` 형태 메시지만 전송하고 결과 수신.

---

## 2. 폴더 구조 (초안)

```
youtube-play-assistant/
├── .gitignore
├── README.md
├── PRD.md
├── IMPLEMENTATION_PLAN.md
├── package.json
├── tsconfig.json
├── wxt.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── assets/
│   └── icons/
├── entrypoints/
│   ├── background.ts          # Service Worker
│   ├── content.ts             # 유튜브 페이지 주입
│   ├── options/               # Options 페이지
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── App.tsx
│   └── sidepanel/             # Side Panel
│       ├── index.html
│       ├── main.tsx
│       └── App.tsx
├── src/
│   ├── components/            # 공통 UI (Button, Input, StatusBadge...)
│   ├── features/
│   │   ├── api-key/           # 키 관리 로직·훅
│   │   ├── youtube/           # 영상 인식·자막 추출
│   │   ├── translation/       # Gemini 호출·용어집·병렬 처리
│   │   ├── transcript/        # Transcript UI·동기화
│   │   ├── summary/           # 요약
│   │   ├── bookmarks/         # 북마크
│   │   ├── search/            # 검색
│   │   └── export/            # Markdown·SRT
│   ├── lib/
│   │   ├── storage.ts         # chrome.storage 래퍼
│   │   ├── db.ts              # IndexedDB (Dexie 또는 idb)
│   │   ├── messaging.ts       # 타입 안전한 메시지 채널
│   │   └── gemini.ts          # Gemini API 클라이언트
│   ├── types/
│   │   ├── message.ts         # 메시지 스키마
│   │   └── models.ts          # PRD §10 데이터 모델 타입
│   └── styles/
│       └── globals.css        # Tailwind base
└── docs/
    └── screenshots/           # Options·SidePanel 캡처
```

---

## 3. 마일스톤

| M | 이름 | 목표 | 완료 기준 |
|---|---|---|---|
| **M0** | 프로젝트 초기화 + API 키 관리 | wxt 스캐폴딩, GitHub 연결, Options 페이지 완성 | 확장 로드 후 Options에서 키 저장·테스트 통과 |
| **M1** | 영상 인식 + Side Panel 뼈대 | Content Script가 유튜브 영상 인식, Side Panel 열림 | Side Panel에 영상 제목·시간 표시, 온보딩 화면 동작 |
| **M2** | 자막 추출 + Gemini 번역 파이프라인 | 영어 자막 확보 후 한국어 번역까지 | 영상 하나 골라서 번역된 Transcript 텍스트 콘솔 출력 |
| **M3** | Transcript UI + 자막 오버레이 + 동기화 | 재생 위치에 맞춰 하이라이트·스크롤, 클릭 이동 | 영상 재생하며 자막 오버레이 + Transcript 실시간 동작 |
| **M4** | 북마크 + 검색 + Summary | Phase 2 기능 완성 | 북마크 저장·검색·요약 조회 가능 |
| **M5** | 학습 노트 · SRT 내보내기 | MVP 마무리 | Markdown·SRT 다운로드 동작 |

각 M 종료 시 커밋·태그·스크린샷 저장. M0~M3까지가 실질적 MVP.

---

## 4. M0 — 프로젝트 초기화 + API 키 관리 (첫 스프린트 상세)

### 4.1 산출물
- 로컬에서 빌드·로드 가능한 확장
- Options 페이지에서 Gemini API 키 저장·삭제·연결 테스트 가능
- GitHub 리포지토리에 초기 커밋 push
- Side Panel에 온보딩 화면 (키 미등록 시)

### 4.2 태스크

#### T0. 저장소 초기화
- [ ] `git init`
- [ ] `.gitignore` 작성 (node_modules, .wxt, .env, dist, .output)
- [ ] GitHub 원격 연결: `git remote add origin https://github.com/picpal/youtube-play-assistant.git`
- [ ] PRD, IMPLEMENTATION_PLAN 초기 커밋

#### T1. wxt 스캐폴딩
- [ ] `pnpm dlx wxt@latest init youtube-play-assistant --template react-ts` (현 디렉토리에서 진행하도록 조정)
- [ ] Tailwind 설정 추가 (`@tailwindcss/postcss` 또는 v4 사용)
- [ ] `wxt.config.ts`에 `permissions: ['storage', 'sidePanel', 'activeTab']`, `host_permissions: ['https://www.youtube.com/*', 'https://generativelanguage.googleapis.com/*']`
- [ ] Options 페이지 entrypoint 등록
- [ ] Side Panel entrypoint 등록 + `sidePanel.default_path`
- [ ] Content Script matches: `https://www.youtube.com/*`
- [ ] 빌드 확인: `pnpm dev` → `chrome://extensions` 로드

#### T2. 공통 인프라
- [ ] `src/lib/storage.ts` — `getSetting/setSetting` 래퍼
- [ ] `src/lib/messaging.ts` — 타입 안전 메시지 채널 (`sendToBackground<T>()`)
- [ ] `src/types/message.ts` — 메시지 타입 유니온 정의 (`SAVE_API_KEY`, `TEST_API_KEY`, `TRANSLATE`, `EXTRACT_TRANSCRIPT` 등)
- [ ] `src/lib/gemini.ts` — Gemini `generateContent` 호출 함수 (fetch 기반, 에러 코드 분류)

#### T3. Options 페이지
- [ ] `App.tsx` 레이아웃 (헤더 + "Gemini API 키" 섹션 + "연결 테스트" 섹션)
- [ ] `useApiKey()` 훅 (`storage.local.geminiApiKey` 읽기·쓰기·삭제)
- [ ] Password Input + 표시 토글 + 저장 버튼
- [ ] 저장 후 마스킹 표시 (`••••` + 마지막 4자리)
- [ ] 저장 상태 4종 (idle/saving/success/error) 렌더링
- [ ] 연결 테스트: Background로 메시지 → Gemini 짧은 프롬프트 호출 → 결과 반환
- [ ] 연결 테스트 결과 상태 3종 (성공/401/429)
- [ ] Google AI Studio 발급 링크

#### T4. Background Service Worker
- [ ] `SAVE_API_KEY` / `GET_API_KEY_STATUS` / `DELETE_API_KEY` 핸들러
- [ ] `TEST_API_KEY` 핸들러 (Gemini에 `"ping"` 프롬프트 전송, 응답 시간 측정)
- [ ] 에러 정규화: 401·429·network·unknown 4종
- [ ] Side Panel API 초기화: `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`

#### T5. Side Panel 뼈대
- [ ] `App.tsx` — 최초 진입 시 `GET_API_KEY_STATUS` 조회
- [ ] 키 없음 → 온보딩 화면 렌더 ("API 키를 등록해주세요" + "설정 열기" 버튼)
- [ ] "설정 열기" → `chrome.runtime.openOptionsPage()`
- [ ] 헤더에 키 상태 인디케이터 (점 색상)

#### T6. 스타일링 & 디자인 이식
- [ ] Claude로 만든 디자인 아티팩트 → 프로젝트에 컴포넌트로 이식
- [ ] 다크 모드 우선, 라이트 모드 병행 (Tailwind `dark:`)
- [ ] 공통 컴포넌트 `Button`, `Input`, `StatusBadge` 분리

#### T7. 초기 커밋 & Push
- [ ] `git add . && git commit -m "chore: initial scaffolding with API key management"`
- [ ] `git push -u origin main`

### 4.3 완료 기준 (Definition of Done)
- Chrome에 확장 로드 → 유튜브 페이지 접속 → 확장 아이콘 클릭 → Side Panel 열림
- Side Panel에 온보딩 화면 표시 → "설정 열기" 클릭 → Options 페이지 열림
- API 키 입력·저장 → 마스킹 상태 표시 → 연결 테스트 성공
- Side Panel 재진입 시 온보딩 화면 대신 정상 상태 인디케이터 표시

### 4.4 예상 리스크
- **Tailwind v4 + wxt 통합**: 문서 부족할 수 있음. 문제 시 v3로 폴백.
- **Chrome Side Panel API 최소 버전**: Chrome 114+ 필요. 로컬 크롬 버전 사전 확인.
- **Gemini 무료 티어 API 키 발급**: Google 계정 로그인 필요.

---

## 5. M1~M5 개요 (각 M당 반나절~1일 상정)

### M1. 영상 인식 + Side Panel 뼈대
- Content Script: URL·videoId 추출, SPA 이동 감지 (MutationObserver)
- Video 메타 (제목·채널·재생시간) 추출
- Content → Background → Side Panel 메시지 전달
- Side Panel에 영상 정보 카드 + `AI 자막 생성` 버튼 표시
- Shorts / 라이브 / 접근 제한 감지 → 미지원 배너

### M2. 자막 추출 + Gemini 번역 파이프라인
- YouTube timedtext 엔드포인트 조사 (`youtube.com/api/timedtext`) — 대안 라이브러리 검토 (`youtube-transcript` 등)
- 자막 → segment 배열로 정규화
- 용어집 생성: 전체 자막을 한 번의 요약 프롬프트로 → 주요 용어 리스트
- 구간 번역: 5~10 segment씩 배치, 병렬 3 동시성 상한
- rate limit 대응: 429 시 지수 백오프
- 결과 IndexedDB 캐시 (`videoId` 기준)
- 진행률 이벤트를 Side Panel에 스트리밍

### M3. Transcript UI + 자막 오버레이 + 동기화
- Content Script: 유튜브 플레이어 위 `<div>` 오버레이 삽입, `timeupdate` 이벤트 리스닝
- Side Panel Transcript: 가상 스크롤 (react-window)
- 재생 위치 → 현재 segment 강조 + 자동 스크롤 (사용자 스크롤 감지 시 자동 스크롤 일시 정지)
- Transcript 항목 클릭 → Content Script로 `SEEK` 메시지
- 자막 표시 모드 토글 (영/한/영한)

### M4. 북마크 + 검색 + Summary
- 북마크: IndexedDB `bookmarks` 테이블, Bookmarks 탭
- 검색: 클라이언트 사이드 필터링 (fuse.js 또는 단순 includes)
- 하이라이트: 검색어 강조, 이전/다음 이동
- Summary: 별도 프롬프트 호출, 발표 구조 중심 (§7.5 원칙)

### M5. 학습 노트 · SRT 내보내기
- Markdown 노트 생성 → `Blob` 다운로드
- SRT 포맷 변환 → 다운로드
- Options에 캐시 삭제 버튼

---

## 6. 개발 가이드라인

### 6.1 커밋 규칙
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- 브랜치 전략: 개인용이므로 `main` 직접 push, 마일스톤별 태그 (`v0.1.0-m0`, ...)

### 6.2 코드 규칙
- 타입 강제: `any` 금지, 메시지 스키마는 유니온 타입
- 함수형 React, hooks 우선
- Tailwind 클래스는 컴포넌트 안 인라인, 재사용 시 `@apply` 대신 컴포넌트 추출
- 주석은 WHY만, WHAT은 코드로

### 6.3 테스트 전략
- MVP 단계에서는 자동 테스트 없음, 실제 유튜브 페이지에서 수동 검증
- Phase 3 이후 파이프라인 로직 단위 테스트 도입 검토 (vitest)

### 6.4 시크릿 관리
- API 키는 절대 커밋 금지
- `.env`, `.env.local` `.gitignore` 포함
- Google Cloud Console에서 API 키에 Chrome 확장 ID 제한 (Options 페이지에 안내)

---

## 7. 즉시 다음 액션 (오늘)

1. 이 PRD와 계획 검토 → OK 하면 T0(git init) + T1(wxt 스캐폴딩) 즉시 실행
2. Claude로 만든 디자인 아티팩트 URL(또는 코드) 공유
3. M0 완료 시 Side Panel 온보딩 + Options 페이지 스크린샷 확인

---

## 8. 오픈 이슈

- [ ] YouTube 자막 추출 방식 확정 (공식 timedtext vs 서드파티 라이브러리 vs innertube 우회) — M2 착수 전 결정
- [ ] Gemini 프롬프트 설계 (용어집 프롬프트, 번역 프롬프트, 요약 프롬프트) — M2에서 iterate
- [ ] 자막 오버레이가 유튜브 컨트롤과 겹칠 때 위치 조정 정책 — M3
- [ ] IndexedDB 스키마 마이그레이션 전략 — Phase 3에서 검토
