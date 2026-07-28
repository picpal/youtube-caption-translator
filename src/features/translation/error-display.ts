// Task R7 (Fix 2B) — real-user test found the `failed` state's error text
// was the raw English `reason` string straight out of the pipeline (e.g.
// `"No transcript panel available for this video"`), shown as-is under the
// 다시 시도 button. This maps the KNOWN reason strings this codebase actually
// produces to short Korean guidance; anything unrecognized is returned
// VERBATIM rather than guessed at — an English string the user can still
// read/report beats a confidently wrong Korean one.
//
// Every check below targets a REAL string, grepped from the two places that
// build `TranslationRecord.error.reason`:
// - pipeline.ts's `failPipeline` sets `reason` to the EXACT literal
//   `'No transcript panel available for this video'` when `requestTranscript`
//   returns `{ unavailable: true }` (no transcript engagement panel at all).
// - pipeline.ts's `summarizeFailures` embeds each hard chunk failure's own
//   `TranslateBatchReason`/`GeminiErrorReason` LITERALLY, as
//   `"chunk <n>: <reason> (<message>)"` (see gemini.ts's `classifyGeminiError`
//   for `'unauthorized'`/`'rate_limit'`/`'network'`, and `translateBatch`'s
//   own `'truncated'`/`'bad_json'`) — so a plain substring check on the bare
//   reason token matches regardless of which/how many chunks failed or what
//   the message text around it says. `'network'` also covers
//   `GEMINI_FETCH_TIMEOUT_MS`'s abort path (gemini.ts): a timed-out fetch is
//   classified `'network'` too, there is no separate timeout reason.
const NO_TRANSCRIPT_PANEL_REASON = 'No transcript panel available for this video';

export function translationErrorDisplay(reason: string): string {
  if (reason === NO_TRANSCRIPT_PANEL_REASON) {
    return '이 영상은 스크립트(대본)를 제공하지 않아 자막을 생성할 수 없어요';
  }
  if (reason.includes('unauthorized')) {
    return 'API 키가 유효하지 않아요. 설정에서 키를 확인해주세요';
  }
  if (reason.includes('rate_limit')) {
    return '요청이 많아요. 잠시 후 다시 시도해주세요';
  }
  if (reason.includes('network')) {
    return '네트워크 연결이 불안정해요. 잠시 후 다시 시도해주세요';
  }
  return reason;
}
