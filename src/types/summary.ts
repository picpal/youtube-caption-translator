// PRD §10 `VideoSummary`, narrowed to what the summary panel renders
// (spec 2026-07-30 §2). `createdAt` is an ISO string — the repo's
// TranslationRecord convention — a deliberate deviation from the spec
// sketch's `number`.
import type { TargetLang } from '~/lib/target-lang';

export interface SummarySection {
  startSec: number;
  title: string;
}

export interface VideoSummary {
  videoId: string;
  purpose: string;
  mainArguments: string[];
  sections: SummarySection[];
  keywords: string[];
  conclusion: string;
  model: string;
  /** Language this summary's text fields are IN. Optional because
   * pre-existing summaries (persisted before language generalization) lack
   * it — every reader treats `undefined` as `'ko'`, matching
   * `TranslationRecord.targetLang`'s same convention. */
  targetLang?: TargetLang;
  createdAt: string;
}
