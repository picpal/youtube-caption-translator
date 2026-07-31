# PRD: YouTube Caption Translator (개인용)

## 0. 문서 정보

- 문서명: YouTube Caption Translator PRD
- 버전: v0.2 (개인용 리비전)
- 원본: `ai_technical_video_player_prd.md` v0.1
- 목적: YouTube 영어 기술 영상을 한국어 자막·스크립트·북마크로 학습하기 위한 **개인용 Chrome 확장 프로그램** 정의
- 사용자: 본인 1인 (배포·수익화·다중 사용자 없음)

---

## 1. v0.1 대비 주요 변경 사항

| 항목 | v0.1 | v0.2 |
|---|---|---|
| 사용자 | 실무자 대상 배포 | 본인 1인 학습 |
| AI 백엔드 | 자체 백엔드 서버 + 인증 + 사용량 관리 | **없음.** Gemini API 직접 호출 |
| AI 모델 | 미정 | Gemini 2.5 Flash (무료 티어) → 품질 부족 시 교체 |
| API 키 관리 | 백엔드에서 관리 | **사용자 로컬 저장** (`chrome.storage.local`) |
| Notion/Obsidian 연동 | 로드맵 포함 | 초기 제외 (필요 시 Markdown 파일 저장) |
| 계정/인증/동기화 | 필요 | 제거 |
| MVP 정의 | §13과 §14 Phase 1이 상충 | **아래 §11에서 단일 정의로 통합** |
| 데이터 모델 | `User`, `userId` 등 다중 사용자 전제 | 단일 사용자, 유저 개념 삭제 |

---

## 2. 제품 개요

YouTube 영상 페이지에서 우측 Side Panel과 자막 오버레이를 통해 영어 자막을 한국어로 번역·표시하고, 타임스탬프 기반 스크립트·검색·북마크·요약을 제공하는 개인용 Chrome 확장 프로그램.

핵심 철학:

> 발표 자체에 집중하도록, 자막·탐색·번역에 뺏기는 시간을 없앤다.

---

## 3. 문제 정의 (요약)

1. 영어 자막만으로는 기술 발표 이해가 느리다.
2. 유튜브 자동 번역은 기술 용어에서 부정확하다.
3. 긴 영상에서 특정 발언 위치를 다시 찾기 어렵다.
4. 학습한 내용을 정리·복기하는 마찰이 크다.
5. AI 해설이 과하면 오히려 원문 의도를 왜곡한다.

---

## 4. 목표

### 4.1 핵심 목표
- 유튜브 영상 자동 인식 및 자막·Transcript 추출
- 문맥·용어집 기반 자연스러운 한국어 번역
- 영상 위 자막 오버레이 자동 적용
- 타임스탬프 스크립트·클릭 이동·재생 위치 자동 강조·자동 스크롤
- 키워드 검색·하이라이트·북마크
- Markdown 학습 노트 생성 및 파일 저장

### 4.2 비목표
- AI가 발표자 의도를 넘어 해설·평가하는 기능
- 자동 예제 코드·퀴즈·챗봇
- 영상 다운로드·재인코딩
- **[v0.2 추가]** 계정·로그인·기기 간 동기화
- **[v0.2 추가]** 자체 백엔드·요금제·과금
- **[v0.2 추가]** Notion·Obsidian 직접 연동 (Markdown export만)
- **[v0.2 추가]** 모바일 브라우저 대응

---

## 5. 사용자

본인 1인. 페르소나 분석 생략.

---

## 6. 핵심 시나리오

### A. 자막 생성·적용
1. 유튜브 영상 페이지 진입
2. Side Panel 자동 열림 (또는 확장 아이콘 클릭)
3. 현재 영상 자동 인식
4. `AI 자막 생성` 버튼 클릭
5. 영어 자막/Transcript 추출 → 한국어 번역 → 오버레이 적용
6. 우측 Side Panel에 Transcript·Summary 렌더링

### B. 스크립트 탐색
- 타임스탬프+영어 원문+한국어 표시
- 항목 클릭 → 영상 시점 이동
- 재생 위치에 따라 현재 항목 하이라이트·자동 스크롤

### C. 키워드 검색
- 영·한 통합 검색, 대소문자 무시
- 결과 클릭 시 이동, 스크립트 내 강조

### D. 북마크
- Transcript 항목 옆 별 아이콘
- Bookmarks 탭에서 저장 구간만 조회
- 클릭 시 영상 이동

### E. 학습 노트 저장
- `학습 노트 생성` → Markdown 파일 다운로드
- 영상 메타·요약·북마크·핵심 키워드 포함

---

## 7. 기능 요구사항

### 7.1 영상 인식
- 유튜브 영상 페이지 자동 감지 (SPA 이동 포함, MutationObserver)
- 영상 ID·제목·채널·재생 시간 추출
- Shorts / 라이브 / 비공개 / 지역 제한 영상은 **미지원 안내 표시**

### 7.2 자막·Transcript 추출
우선순위:
1. 제작자 제공 영어 자막
2. 유튜브 자동 생성 영어 자막
3. (v0.2 MVP 제외) 음성 인식

요구사항:
- 타임스탬프 보존
- 문장 단위 재구성, 중복 제거
- 코드·고유명사 식별

### 7.3 한국어 번역
- 전체 문맥·용어집 기반
- 기술 용어는 국내 관례 우선, 필요 시 영어 유지
- 코드·명령어·URL·라이브러리명 미번역
- 동일 용어 영상 내 일관 번역
- AI 해설 삽입 금지

### 7.4 자막 오버레이
- 유튜브 플레이어 위 레이어
- 유튜브 기본 CC와 중복 방지 (자동 OFF 옵션)
- 켜기·끄기 / 영어·한국어·영한 동시 표시
- 폰트 크기·배경 투명도·위치 설정
- 전체 화면·PiP·재생 속도 변경 시 동기화 유지

### 7.5 Summary
- 발표 문제·핵심 주장·섹션·키워드·결론
- AI 개인 의견·확장 해설 금지
- 원문으로 회귀 가능한 링크 구조

### 7.6 Transcript
- 타임스탬프 / 영어 원문 / 한국어 / 북마크 버튼 / 하이라이트
- 클릭 이동, 현재 항목 자동 강조·자동 스크롤
- 영어/한국어 표시 토글, 문장 복사

### 7.7 검색·하이라이트
- 영·한 통합, 대소문자 무시
- 결과 개수·타임스탬프 리스트
- 이전/다음 이동
- 자동 추출된 핵심 키워드 필터

### 7.8 북마크
- Transcript 항목 즉시 북마크
- 영상별 저장, 정렬, 해제
- 학습 노트에 자동 포함
- **SoT**: `Bookmark` 테이블 단일. `TranscriptSegment.isBookmarked` 필드 폐지 (v0.1 대비 정정)

### 7.9 학습 노트 저장
- 입력: 메타·요약·주요 섹션·키워드·북마크
- 출력: Markdown 파일 다운로드 (`영상제목_YYYY-MM-DD.md`)
- 원칙: 사용자 북마크 중심, AI 해설 최소

### 7.10 내보내기
- Markdown 다운로드
- 클립보드 복사
- SRT 자막 파일 다운로드
- **v0.2 MVP 제외**: VTT, Notion, Obsidian 직접 연동

### 7.11 학습 진행 상태 (Phase 2+)
- 마지막 재생 위치·시청 진행률 로컬 저장
- 재접속 시 이어보기

### 7.12 **[신규] API 키 관리**

#### 저장 위치
- `chrome.storage.local` 전용
- Content Script 노출 금지 → **Background Service Worker에서만 읽기**
- 유튜브 페이지 JS에서 접근 불가

#### 화면
1. **Options 페이지**
   - Gemini API 키 입력 (password 타입, 마스킹 토글)
   - 저장 / 삭제 / 표시 토글
   - 저장 후 상태: `••••abcd 저장됨 · YYYY-MM-DD`
   - 연결 테스트 버튼 (성공/401/429 상태별 메시지)
   - 무료 티어 한도 안내 링크
2. **Side Panel 온보딩 화면** (키 미등록 시)
   - "API 키를 등록해주세요" + Options 열기 CTA
   - 발급 링크 (`aistudio.google.com/apikey`)
   - "이 브라우저에만 저장됨" 고지
3. **Side Panel 상단 헤더**
   - 영상 제목 (좌) / 설정 아이콘 + 키 상태 인디케이터 (우)
4. **저장 피드백**: idle / saving / success / error 4상태
5. **연결 테스트 결과**: 성공 / 인증 실패 / rate limit 3상태

#### 보안
- Google Cloud Console에서 API 키에 **Chrome 확장 ID 제한** 필수
- Git 커밋 방지: 개발 중 로컬 파일에서 로드하되 최종 배포판은 UI 입력만
- 저장 시 마지막 4자리만 표시

---

## 8. UI 구조

```
┌──────────────────────────────┬────────────────┐
│ YouTube 영상 + 자막 오버레이 │ Side Panel     │
│                              │                │
│                              │ [헤더/설정]    │
│                              │ ┌──────────┐   │
│                              │ │ Summary  │   │
│                              │ │ Script   │   │
│                              │ │ Bookmark │   │
│                              │ │ Export   │   │
│                              │ └──────────┘   │
└──────────────────────────────┴────────────────┘
```

- 사이드 패널: **Chrome Side Panel API 사용** (페이지 DOM 주입 아님)
- 폭 부족 시 Transcript/Summary 탭 전환
- 자막 오버레이만 Content Script가 DOM 주입

---

## 9. 상태 정의

| 상태 | 표시 |
|---|---|
| API 키 미등록 | Side Panel 온보딩 화면 |
| 영상 없음 | "유튜브 영상 페이지로 이동해주세요" |
| 초기 | 영상 정보 + `AI 자막 생성` 버튼 |
| 처리 중 | 단계별 진행 표시 (추출→번역→검증→적용) |
| 완료 | 자막 활성화 + Summary + Transcript + 북마크 |
| 실패 | 실패 단계·원인 + 재시도 (가능 시 원문 Transcript만이라도 표시) |

---

## 10. 데이터 모델

모든 데이터는 `chrome.storage.local` 또는 `IndexedDB`에 저장. 사용자 개념 없음.

### Video
- `videoId`, `url`, `title`, `channelName`, `thumbnailUrl`, `duration`, `sourceLanguage`, `createdAt`, `updatedAt`

### TranscriptSegment
- `segmentId`, `videoId`, `startTime`, `endTime`, `sourceText`, `translatedText`, `speaker?`, `keywords[]`
- (`isBookmarked` 필드 삭제 — 북마크는 별도 테이블로만 관리)

### VideoSummary
- `videoId`, `purpose`, `mainArguments[]`, `sections[]`, `keywords[]`, `conclusion`

### Bookmark
- `bookmarkId`, `videoId`, `segmentId`, `timestamp`, `sourceText`, `translatedText`, `note?`, `createdAt`

### LearningProgress (Phase 2+)
- `videoId`, `lastPosition`, `watchedPercentage`, `lastWatchedAt`, `completed`

### Settings
- `geminiApiKey`, `subtitleMode` (`ko`/`en`/`both`), `fontSize`, `overlayOpacity`, `autoDisableYoutubeCC`

---

## 11. MVP 범위 (v0.1 §13/§14 통합 정리)

### MVP 포함
- 유튜브 일반 영상 인식
- 영어 자막 추출 (제작자·자동 자막)
- Gemini 2.5 Flash 기반 한국어 번역
- 자막 오버레이
- Transcript 표시·클릭 이동·재생 위치 동기화
- 검색·하이라이트
- 북마크
- Summary
- Markdown 학습 노트 다운로드
- SRT 다운로드
- API 키 관리 UI (Options + 온보딩)

### MVP 제외
- 음성 인식 (자막 없는 영상)
- Notion / Obsidian 직접 연동
- VTT 내보내기
- Shorts / 라이브
- 학습 진행 상태·이어보기
- 다국어 (영→한 전용)

---

## 12. 기술 구성

### 확장 프로그램
- Manifest V3
- 스택: **wxt + React + TypeScript + Tailwind CSS**
- Content Script: 자막 오버레이, 재생 시간 브로드캐스트, 유튜브 CC 제어
- Background Service Worker: API 키 저장·조회, Gemini API 호출, 캐시 관리
- Side Panel (Chrome Side Panel API): Transcript·Summary·북마크·설정 UI
- Options 페이지: API 키 관리 및 자막 옵션
- 저장소: `chrome.storage.local` (설정·키), `IndexedDB` (자막·번역·북마크 캐시)

### AI
- Gemini 2.5 Flash (Google AI Studio 무료 티어)
- API 키는 사용자가 발급·입력
- 품질 부족 시 후속 교체 옵션: Claude Haiku, GPT-4o mini

### AI 처리 파이프라인
```
Transcript 수집
    ↓
문장 정제·구간 병합
    ↓
영상 전체 주제·용어 1차 분석 (요약 모델 호출 1회)
    ↓
용어집 생성
    ↓
구간별 번역 (병렬, rate limit 준수)
    ↓
용어 일관성 검증 (동일 원어 → 동일 번역)
    ↓
타이밍 검증
    ↓
Summary 생성
    ↓
IndexedDB 캐시 저장
```

### 캐시
- Key: `videoId` + 자막 버전 해시
- TTL: 없음 (수동 삭제 UI 제공)
- 재방문 시 즉시 로드

---

## 13. 단계별 개발 계획

### Phase 1 — 자막 플레이어 MVP
- 프로젝트 스캐폴딩, Options 페이지, API 키 관리
- 유튜브 영상 인식, 자막 추출, Gemini 번역
- 자막 오버레이, Transcript 표시·동기화

### Phase 2 — 학습 탐색
- 검색·하이라이트
- 북마크
- Summary
- Markdown·SRT 내보내기

### Phase 3 — 편의 기능
- 학습 진행 상태·이어보기
- 자막 옵션 세분화 (폰트·색상·위치)
- IndexedDB 캐시 관리 UI

### Phase 4 (선택)
- 음성 인식 (Whisper API)
- Notion·Obsidian 연동
- 사용자 정의 용어집

---

## 14. 리스크 (개인용 관점)

| 리스크 | 대응 |
|---|---|
| 유튜브 DOM 변경 | MutationObserver + 어댑터 계층 |
| 자막 접근 제한 (일부 영상) | 실패 사유 명확 표시, 원문 Transcript만 대체 표시 |
| Gemini 무료 티어 rate limit | 배치·병렬 상한, 실패 시 지수 백오프, 재시도 UI |
| 긴 영상 번역 대기 | 구간 스트리밍 표시, 캐시 재사용 |
| API 키 유출 | Chrome 확장 ID 제한, `chrome.storage.local` 전용, Content Script 미노출 |
| 유튜브 ToS | 개인 학습 전용, 영상 다운로드 금지, 자막 원문·번역은 로컬 저장만 |
| Manifest V3 Service Worker 30초 timeout | 장시간 작업은 청크 단위, 상태를 storage에 저장 |

---

## 15. 제품 원칙

1. 발표자의 의도를 AI 해석보다 우선한다.
2. AI는 백그라운드에서 조용히 작동한다.
3. 모든 요약·번역은 원문으로 회귀 가능해야 한다.
4. 원하는 구간을 빠르게 다시 찾을 수 있어야 한다.
5. 자막 생성부터 적용까지 한 번의 클릭으로 완료.
6. 학습 결과는 로컬 파일로 소유·이동 가능해야 한다.
7. 개인 도구답게 단순함을 우선한다.

---

## 16. 한 줄 정의

> 영어 기술 영상을 한국어 자막·스크립트로 학습하는 개인용 YouTube Chrome 확장.
