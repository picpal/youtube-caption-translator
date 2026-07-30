// PRD §10 `VideoSummary`, narrowed to what the summary panel renders
// (spec 2026-07-30 §2). `createdAt` is an ISO string — the repo's
// TranslationRecord convention — a deliberate deviation from the spec
// sketch's `number`.
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
  createdAt: string;
}
