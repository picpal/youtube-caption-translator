// 라이브러리 뷰(spec 2026-08-01)의 결정·표시 로직 전부. 이 저장소에는 컴포넌트
// 렌더 테스트 하니스가 없으므로(@testing-library 미설치), `LibraryView`가 내리는
// 판단은 하나도 컴포넌트 안에 두지 않고 여기에서 테스트한다 —
// `playback-sync.ts`/`summary.ts`와 같은 규율이다.
import { TARGET_LANG_LABELS } from '~/lib/target-lang';
import { formatTimestamp } from '~/lib/transcript-parse';
import type { LibraryEntry } from '~/types/library';
import type { TranslationStatus } from '~/types/transcript';

/** 검색어와 제목/키워드를 같은 방식으로 정규화한다. */
function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function matches(entry: LibraryEntry, needle: string): boolean {
  if (entry.title.toLowerCase().includes(needle)) return true;
  return entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle));
}

/**
 * 제목 **또는** 요약 키워드 부분일치. 채널명과 자막 본문은 대상이 아니다 —
 * spec §2가 검색 기준을 이 둘로 못박았다.
 *
 * 디바운스하지 않는다: 대상이 로컬 배열 수십 건이라 입력마다 다시 훑어도 무시할
 * 수 있는 비용이고, 디바운스는 타이핑에 지연만 더한다.
 */
export function filterLibrary(entries: LibraryEntry[], query: string): LibraryEntry[] {
  const needle = normalize(query);
  if (needle === '') return entries;
  return entries.filter((entry) => matches(entry, needle));
}

export const MAX_MATCHED_KEYWORDS = 3;

/**
 * 이 행이 검색어에 걸린 이유가 키워드였다면 그 키워드들. 목록 행에 키워드가 평소
 * 보이지 않기 때문에, 이게 없으면 제목과 무관해 보이는 결과가 이유 없이 튀어나온
 * 것처럼 읽힌다.
 */
export function matchedKeywords(entry: LibraryEntry, query: string): string[] {
  const needle = normalize(query);
  if (needle === '') return [];
  return entry.keywords
    .filter((keyword) => keyword.toLowerCase().includes(needle))
    .slice(0, MAX_MATCHED_KEYWORDS);
}

export interface EntryBadge {
  tone: 'error' | 'warn' | 'muted';
  label: string;
}

/**
 * `done`은 정상이라 뱃지를 달지 않는다 — 목록 대부분이 done이므로 전부에 뱃지를
 * 달면 신호가 사라진다.
 */
export function entryBadge(status: TranslationStatus): EntryBadge | null {
  if (status === 'done') return null;
  if (status === 'failed') return { tone: 'error', label: '실패' };
  if (status === 'analyzing' || status === 'translating') return { tone: 'warn', label: '진행 중' };
  return { tone: 'muted', label: '미완료' };
}

function formatEntryDate(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) return `${month}월 ${day}일`;
  return `${date.getFullYear()}년 ${month}월 ${day}일`;
}

/**
 * 행의 둘째 줄. 값이 없는 조각은 자리를 비우는 게 아니라 **통째로 뺀다** —
 * `durationSeconds`가 `null`일 때 `0:00`을 그리는 것은 `VideoMeta`의 문서화된
 * 규약이 금지하는 "확신에 찬 거짓말"이다.
 */
export function formatEntryMeta(entry: LibraryEntry, now: Date): string {
  const parts: string[] = [];
  if (entry.channelName !== null && entry.channelName !== '') parts.push(entry.channelName);
  if (entry.durationSeconds !== null) parts.push(formatTimestamp(entry.durationSeconds));
  parts.push(TARGET_LANG_LABELS[entry.targetLang]);
  const date = formatEntryDate(entry.updatedAt, now);
  if (date !== '') parts.push(date);
  return parts.join(' · ');
}

export function formatCountLabel(shown: number, total: number): string {
  return shown === total ? `${total}편` : `${shown} / ${total}편`;
}

/** `navigator.storage.estimate()`의 결과 중 이 화면이 쓰는 부분만. */
export interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}

/**
 * 단위를 반올림된 표시값 기준으로 고른다 — 원시 바이트로 단위를 먼저 정하면
 * `1048575`(≈1 MiB 미만)처럼 `toFixed(1)`이 그 단위 안에서 `1024`로 올림되는
 * 값이 "1024 KB"/"1024.0 MB"로 굳어버린다(리뷰에서 발견). 위 단위부터 확인해
 * 반올림 결과가 그 단위에서 1 이상이면 그 단위로 확정한다.
 */
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (Number(gb.toFixed(1)) >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (Number(mb.toFixed(1)) >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 목록 하단 한 줄. `usage`는 이 확장 오리진 **전체**의 사용량이라 번역본 외의
 * 것도 포함한다 — 그래서 "영상 N편이 M MB"처럼 인과로 묶지 않고 `·`로 나열한다.
 * 추정치를 못 얻으면 편수만 말한다.
 */
export function formatStorageLine(count: number, estimate: StorageEstimateLike | null): string {
  const head = `영상 ${count}편`;
  if (estimate === null) return head;
  const { usage, quota } = estimate;
  if (typeof usage !== 'number' || typeof quota !== 'number') return head;
  return `${head} · ${formatBytes(usage)} / ${formatBytes(quota)}`;
}

/**
 * 삭제 실패 사유를 사용자 문구로. background는 원문 영어 사유를 돌려주고 한국어
 * 문구는 패널이 만든다 — `translationErrorDisplay`와 같은 규약이다. 사유를
 * 구분하는 이유: 실패를 전부 "진행 중이라"로 표시하면 DB 오류일 때 사용자에게
 * 틀린 원인을 알려주게 된다.
 */
export function deleteErrorMessage(error: string): string {
  if (error === 'job in flight') return '진행 중이라 지울 수 없어요. 끝난 뒤에 다시 시도해주세요';
  return '지우지 못했어요. 다시 시도해주세요';
}
