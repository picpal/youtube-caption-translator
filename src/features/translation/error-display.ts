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
// - background.ts's `START_TRANSLATION` handler sets the EXACT literal
//   `'API key not set'` when there is no saved key at all (fix round 1,
//   Important #2 — this response used to be silently discarded by the only
//   caller, `useTranslation.ts`'s `start()`; now that it reaches `error`/
//   `status:'failed'` like any other failure, it needs a mapping here too or
//   it would show as raw English in the exact "설정 확인" case Fix 2B's
//   `unauthorized` mapping already covers for an INVALID key).
// - Fix round (2026-07-29 task-brief.md, "transcript 열기 로직 SPA-상태
//   견고화"): pipeline.ts's `unavailableReasonMessage` sets the EXACT literal
//   `'Transcript panel failed to open'` when `requestTranscript` comes back
//   `{unavailable:true, reason:'open-failed'}` — the panel/signal existed but
//   content.ts's `openTranscriptPanel` strategy ladder exhausted its budget
//   without ever populating rows. Kept as a SEPARATE, more honest message
//   from `NO_TRANSCRIPT_PANEL_REASON` above: that one means "this video
//   genuinely has no script," which is false in this case and was the live
//   field bug this whole fix round exists to correct.
// - src/lib/gemini.ts's `generateSummary` sets `reason: 'bad_json'` when the
//   model's response fails schema validation (`normalizeSummaryPayload`,
//   src/lib/summary.ts) — entrypoints/background.ts's GENERATE_SUMMARY
//   handler (fix round, Important #2) embeds this as `"bad_json: <message>"`,
//   the same reason-token convention as the translation reasons above, so
//   this file's shared substring matching now covers summary failures too.
const NO_TRANSCRIPT_PANEL_REASON = 'No transcript panel available for this video';
const API_KEY_NOT_SET_REASON = 'API key not set';
const TRANSCRIPT_OPEN_FAILED_REASON = 'Transcript panel failed to open';

export function translationErrorDisplay(reason: string): string {
  if (reason === NO_TRANSCRIPT_PANEL_REASON) {
    return '이 영상은 스크립트(대본)를 제공하지 않아 자막을 생성할 수 없어요';
  }
  if (reason === TRANSCRIPT_OPEN_FAILED_REASON) {
    return '스크립트 패널을 여는 데 실패했어요. 페이지를 새로고침한 뒤 다시 시도해주세요.';
  }
  if (reason === API_KEY_NOT_SET_REASON || reason.includes('unauthorized')) {
    return 'API 키가 유효하지 않아요. 설정에서 키를 확인해주세요';
  }
  if (reason.includes('rate_limit')) {
    return '요청이 많아요. 잠시 후 다시 시도해주세요';
  }
  if (reason.includes('network')) {
    return '네트워크 연결이 불안정해요. 잠시 후 다시 시도해주세요';
  }
  if (reason.includes('bad_json')) {
    return '요약 응답을 해석하지 못했어요. 다시 시도해주세요.';
  }
  return reason;
}
