// 라이브러리 뷰(spec 2026-08-01) 전용 타입 둘. 둘 다 순수 타입 선언이라 런타임
// 코드가 없다.
import type { TargetLang } from '~/lib/target-lang';
import type { TranslationStatus } from '~/types/transcript';

/**
 * `translations` 스토어를 커서로 훑으면서 레코드당 남기는 것. `segments` 배열은
 * `length`만 취하고 버린다 — 목록에 필요한 건 개수뿐인데 배열 자체는 1시간 영상
 * 하나가 약 186 KB다(실측). db 레이어 밖으로 나가는 값이므로 db.ts가 아니라
 * 여기에 둔다.
 */
export interface TranslationDigest {
  videoId: string;
  status: TranslationStatus;
  segmentCount: number;
  /** 레코드의 `targetLang ?? 'ko'`를 이미 적용한 값 — 읽는 쪽이 다시 기본값을
   * 채울 필요가 없다. */
  targetLang: TargetLang;
  updatedAt: string;
}

/**
 * background가 세 스토어를 조인해 만든 목록 한 행. 패널로 건너가는 유일한 모양이다.
 *
 * 왜 `TranslationRecord`를 그대로 보내지 않는가: 실측으로 완료 레코드가 자막
 * 구간당 약 594 B라, 영상 100편이면 약 18 MB가 `sendMessage`의 구조화 복제를
 * 통과한다. 이 투영은 같은 100편에 약 8 KB다.
 */
export interface LibraryEntry {
  videoId: string;
  /** `videos` 스토어에 짝이 없으면 `videoId`를 그대로 쓴다 — 제목 없는 행을
   * 만들지 않는다. */
  title: string;
  channelName: string | null;
  thumbnailUrl: string;
  durationSeconds: number | null;
  status: TranslationStatus;
  targetLang: TargetLang;
  segmentCount: number;
  /** 요약이 없으면 빈 배열. 제목과 함께 검색 대상이다. */
  keywords: string[];
  hasSummary: boolean;
  /** 정렬 키 (내림차순). */
  updatedAt: string;
  /** 지금 background에서 이 영상의 번역 또는 요약 잡이 도는 중. 삭제 금지 신호이며,
   * 패널이 목록을 읽은 시점의 스냅샷이라 낡을 수 있다 — 진짜 검사는 background의
   * 삭제 핸들러가 한다. */
  inFlight: boolean;
}
