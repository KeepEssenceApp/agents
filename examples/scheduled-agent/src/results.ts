// From what the model wrote to what the contract accepts. The core takes fields, not free text,
// and refuses anything over a limit, so every result goes through here before it is handed back.
import { LIMITS, VERDICTS, type AnalysisResult, type DeepReadResult, type DigestContext, type DigestResult, type Verdict } from "./contract.ts";

/** One line, at most `max` characters (not bytes, not UTF-16 units). */
export function oneLine(value: unknown, max: number): string {
  return cut(typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "", max);
}

/** Several lines allowed, at most `max` characters. */
export function passage(value: unknown, max: number): string {
  return cut(typeof value === "string" ? value.trim() : "", max);
}

function cut(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("").trimEnd()}…`;
}

function lines(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => oneLine(entry, maxLength)).filter(Boolean).slice(0, maxItems);
}

/** The model is asked for one JSON object; some wrap it in a code fence or a sentence. */
export function parseObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not answer with a JSON object.");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The model did not answer with a JSON object.");
  return parsed as Record<string, unknown>;
}

const VERDICT_BY_LABEL: Record<string, Verdict> = {
  值得深挖: "worth_deep_dive",
  知道就行: "good_to_know",
  可以略过: "skippable",
  "worth a deep dive": "worth_deep_dive",
  "good to know": "good_to_know",
  skippable: "skippable",
};

/** The content could not be fetched: say so and nothing else. No points, no verdict. */
export function unavailableAnalysis(itemId: string): AnalysisResult {
  return { kind: "analysis", item_id: itemId, unavailable: true };
}

export function toAnalysis(itemId: string, raw: Record<string, unknown>): AnalysisResult {
  const summary = oneLine(raw.summary, LIMITS.analysisSummary);
  const keyFact = oneLine(raw.key_fact, LIMITS.analysisKeyFact);
  const label = typeof raw.verdict === "string" ? raw.verdict.trim() : "";
  const verdict = VERDICTS.find((v) => v === label) ?? VERDICT_BY_LABEL[label.toLowerCase()];
  // A half-filled analysis is not handed back; the item stays for the next run.
  if (!summary || !keyFact || !verdict) throw new Error("The model left out the summary, the key fact or the verdict.");
  const hint = oneLine(raw.related_hint, LIMITS.analysisRelatedHint);
  return {
    kind: "analysis",
    item_id: itemId,
    summary,
    key_fact: keyFact,
    points: lines(raw.points, LIMITS.analysisPoints, LIMITS.analysisPoint),
    verdict,
    ...(hint ? { related_hint: hint } : {}),
  };
}

/**
 * "Worth a deep dive" holds the items judged so that the user has not dealt with yet.
 * Which items those are is decided here from the context, not by the model; the model writes the lines.
 */
export function worthCandidates(context: DigestContext): DigestContext["analyses"] {
  return context.analyses.filter((a) => a.verdict === "worth_deep_dive" && !a.unavailable && !a.signal && !a.in_queue);
}

export function toDigest(day: string, raw: Record<string, unknown>, context: DigestContext): DigestResult {
  const summary = passage(raw.summary, LIMITS.digestSummary);
  const question = oneLine(raw.question, LIMITS.digestQuestion);
  if (!summary || !question) throw new Error("The model left out the summary or the question.");
  const written = new Map<string, string>();
  for (const entry of Array.isArray(raw.worth) ? raw.worth : []) {
    const { item_id, line } = (entry ?? {}) as { item_id?: unknown; line?: unknown };
    if (typeof item_id === "string") written.set(item_id, oneLine(line, LIMITS.digestWorthLine));
  }
  const worth = worthCandidates(context)
    .slice(0, LIMITS.digestWorth)
    .map((a) => ({ item_id: a.item_id, line: written.get(a.item_id) || oneLine(a.summary ?? a.title, LIMITS.digestWorthLine) }));
  return { kind: "digest", day, summary, worth, question };
}

export function toDeepRead(itemId: string, raw: Record<string, unknown>, entry?: string): DeepReadResult {
  const read = passage(raw.read, LIMITS.deepReadText);
  const found = passage(raw.found, LIMITS.deepReadText);
  if (!read || !found) throw new Error("The model left out what it read or what it found.");
  const link = oneLine(entry, LIMITS.deepReadEntry);
  return {
    kind: "deep_read",
    item_id: itemId,
    read,
    found,
    questions: lines(raw.questions, LIMITS.deepReadQuestions, LIMITS.deepReadQuestion),
    ...(link ? { entry: link } : {}),
  };
}
