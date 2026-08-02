import type { TargetLang } from '~/lib/target-lang';

// spec 2026-08-02 §4.1. 스토어에 들어가는 모양과 패널이 주고받는 모양이 같다 —
// 라이브러리(`TranslationDigest`)와 달리 경량 투영을 만들지 않는 이유는 규모다:
// 한 건이 최대 두 문장 스냅샷(약 500 B)이고 영상당 수십 건이라, 50건이 약 25 KB로
// 구조화 복제에 부담이 되지 않는다.

interface BookmarkBase {
  /** `crypto.randomUUID()`. 호출부가 만들어 넘긴다 — 이 모듈도 db도 난수를 읽지 않는다. */
  bookmarkId: string;
  /** 출처 행. 중복 판정에만 쓰고 렌더에는 쓰지 않는다 — 재번역으로 세그먼트가
   * 재분할되면 어긋날 수 있는 값이라, 화면에 보이는 텍스트는 아래 스냅샷이 낸다. */
  segmentId: string;
  /** 시크 앵커. 초 단위라 세그먼트가 재분할돼도 유효하다. */
  startSec: number;
  createdAt: string;
  /** finding M1 — 저장 순간 패널의 번역 언어. 값을 계산으로 나중에 채울 수 있는
   * 다른 필드(§4.1의 "나중에 필드를 더해도 공짜")와 달리, 이건 저장 그 시점에만
   * 알 수 있는 값이라 지금 안 담으면 기존 북마크는 영원히 못 채운다. 지금은
   * write-only다 — 불일치 배너나 내보내기 표시는 아직 만들지 않는다. */
  targetLang?: TargetLang;
}

/**
 * 판별 유니온인 이유: 네 필드를 전부 nullable로 늘어놓으면 `kind: 'row'`인데
 * `sourceText`가 `null`인 레코드가 타입상 합법이 된다. 유니온이면 그 조합이
 * 컴파일 단계에서 불가능하고, `kind`로 좁힌 뒤에는 옵셔널 체이닝 없이 읽는다.
 */
export type Bookmark =
  // 행 통째 — 원문은 반드시 있고, 번역은 아직 없을 수 있다(미번역 세그먼트).
  | (BookmarkBase & { kind: 'row'; sourceText: string; translatedText: string | null })
  // 드래그 조각 — 사용자가 고른 텍스트 하나뿐. 원문/번역을 구분하지 않는다.
  | (BookmarkBase & { kind: 'excerpt'; excerpt: string });

/** `bookmarks` 스토어의 레코드. keyPath: 'videoId'. */
export interface BookmarkRecord {
  videoId: string;
  bookmarks: Bookmark[];
}
