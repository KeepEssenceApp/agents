// The parts of the contract (contract/openapi.yaml) this agent uses, as types and numbers.
// The contract is the source; when it changes, change this file to match.

export type Step = "triage" | "analysis" | "digest" | "deep_read" | "deep_dive";
export type WorkKind = "triage" | "analysis" | "digest" | "deep_read";
export type Verdict = "worth_deep_dive" | "good_to_know" | "skippable";
export type Lang = "zh" | "en";

export const VERDICTS: readonly Verdict[] = ["worth_deep_dive", "good_to_know", "skippable"];

/** Field limits from `x-limits` and the `*Result` schemas. Lengths are in characters. */
export const LIMITS = {
  claimMaxItems: 10,
  analysisSummary: 60,
  analysisKeyFact: 120,
  analysisPoints: 3,
  analysisPoint: 120,
  analysisRelatedHint: 120,
  digestSummary: 600,
  digestWorth: 50,
  digestWorthLine: 160,
  digestQuestion: 160,
  deepReadText: 20000,
  deepReadQuestions: 8,
  deepReadQuestion: 200,
  deepReadEntry: 500,
  searchQuery: 100,
  usageModel: 80,
} as const;

export interface WorkCount {
  kind: WorkKind;
  count: number;
  oldest_due_at?: string | null;
}

export interface Claim {
  claim_id: string | null;
  kind: WorkKind;
  expires_at: string | null;
  work: { ref: string; title?: string }[];
}

export interface Rules {
  rules: string;
  preference?: string | null;
  lang?: Lang;
  timezone?: string;
}

export interface Related {
  kind: "item" | "digest" | "note";
  ref: string;
  title: string;
  excerpt?: string;
}

export interface ItemContext {
  item: {
    id: string;
    kind: "link" | "text" | "image" | "file";
    title: string;
    site?: string | null;
    url?: string | null;
    opening?: string;
    body?: string | null;
    content_unavailable?: boolean;
    asset_url?: string | null;
    saved_at?: string;
  };
  analysis?: { summary?: string; key_fact?: string; points?: string[]; verdict?: Verdict; unavailable?: boolean } | null;
  related?: Related[];
}

export interface DigestContext {
  day: string;
  covers?: string[];
  analyses: {
    item_id: string;
    title: string;
    site?: string | null;
    url?: string | null;
    summary?: string;
    key_fact?: string;
    points?: string[];
    verdict?: Verdict;
    unavailable?: boolean;
    signal?: string | null;
    in_queue?: boolean;
  }[];
}

export interface SearchMatches {
  matches: { kind: "digest" | "note"; ref: string; title: string; excerpt: string }[];
}

export interface AnalysisResult {
  kind: "analysis";
  item_id: string;
  unavailable?: boolean;
  summary?: string;
  key_fact?: string;
  points?: string[];
  verdict?: Verdict;
  related_hint?: string;
}

export interface DigestResult {
  kind: "digest";
  day: string;
  summary: string;
  worth?: { item_id: string; line: string }[];
  question: string;
}

export interface DeepReadResult {
  kind: "deep_read";
  item_id: string;
  read: string;
  found: string;
  questions: string[];
  entry?: string;
}

export type Result = AnalysisResult | DigestResult | DeepReadResult;

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

export interface SubmitOutcome {
  outcomes: { ref: string; accepted: boolean; reason?: string }[];
}
