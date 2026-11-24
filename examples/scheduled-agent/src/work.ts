// One piece of work of each kind: fetch the context through the tools, ask the model, shape the result.
import type { Config } from "./config.ts";
import { LIMITS, type DigestContext, type ItemContext, type Lang, type Related, type Result, type Rules, type SearchMatches, type Usage } from "./contract.ts";
import type { Core } from "./core.ts";
import type { Attachment, Model, ModelRequest } from "./model.ts";
import { analysisPrompt, deepReadPrompt, digestPrompt } from "./prompts.ts";
import { oneLine, parseObject, toAnalysis, toDeepRead, toDigest, unavailableAnalysis } from "./results.ts";

export interface Desk {
  config: Config;
  core: Core;
  model: Model;
  /** Tokens and calls spent on the current claim; reported when it is handed back. */
  usage: Usage;
}

/** A piece that should not be handed back and is not a failure: the work goes back as it is. */
export class NothingToDo extends Error {}

const UNAVAILABLE: Record<Lang, string> = { zh: "没取到内容", en: "Content could not be fetched" };
const NOTHING_FOUND: Record<Lang, string> = { zh: "没有查到相关的内容。", en: "Nothing related was found." };

/** Ask the model and shape its answer; a malformed answer gets one more try. */
async function ask<T>(desk: Desk, request: ModelRequest, shape: (raw: Record<string, unknown>) => T): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await desk.model.complete(request);
    desk.usage.calls += 1;
    desk.usage.input_tokens += reply.inputTokens;
    desk.usage.output_tokens += reply.outputTokens;
    try {
      return shape(parseObject(reply.text));
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

function hasNoContent({ item }: ItemContext): boolean {
  return item.content_unavailable === true || (!item.body && !item.opening && !item.asset_url);
}

/** An image, a PDF or a text file that came with the item. Text is read into the body; the rest is shown to the model. */
async function loadAsset(desk: Desk, context: ItemContext): Promise<Attachment[]> {
  const address = context.item.asset_url;
  if (!address) return [];
  const response = await fetch(new URL(address, desk.config.serverUrl));
  if (!response.ok) throw new Error(`The item's file could not be downloaded (${response.status}).`);
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (mediaType.startsWith("text/")) {
    context.item.body = [context.item.body, await response.text()].filter(Boolean).join("\n\n");
    return [];
  }
  if (!mediaType.startsWith("image/") && mediaType !== "application/pdf") return [];
  return [{ mediaType, base64: Buffer.from(await response.arrayBuffer()).toString("base64") }];
}

export async function analyse(desk: Desk, rules: Rules, itemId: string): Promise<Result> {
  const context = await desk.core.call<ItemContext>("get_context", { id: itemId, for: "analysis" });
  if (hasNoContent(context)) return unavailableAnalysis(itemId);
  const lang = rules.lang ?? "zh";
  const attachments = await loadAsset(desk, context);
  return ask(desk, { task: "analysis", input: context, lang, attachments, ...analysisPrompt(lang, rules, context) }, (raw) => toAnalysis(itemId, raw));
}

export async function digest(desk: Desk, rules: Rules, day: string): Promise<Result> {
  const context = await desk.core.call<DigestContext>("get_digest_context", { day });
  // A day without analyses gets no digest.
  if (!context.analyses.length) throw new NothingToDo(`no analyses to summarise for ${day}`);
  const lang = rules.lang ?? "zh";
  return ask(desk, { task: "digest", input: context, lang, ...digestPrompt(lang, rules, context) }, (raw) => toDigest(day, raw, context));
}

export async function deepRead(desk: Desk, rules: Rules, itemId: string): Promise<Result> {
  const context = await desk.core.call<ItemContext>("get_context", { id: itemId, for: "deep_read" });
  const lang = rules.lang ?? "zh";
  const found = await lookUp(desk, context);
  const entry = desk.config.deepDiveEntry?.replaceAll("{item_id}", itemId);
  if (hasNoContent(context)) {
    // Nothing to read in depth. Say so; what is related is still worth listing.
    const listed = found.map((r) => `${r.title}${r.excerpt ? `: ${r.excerpt}` : ""}`).join("\n");
    return toDeepRead(itemId, { read: UNAVAILABLE[lang], found: listed || NOTHING_FOUND[lang], questions: [] }, entry);
  }
  const attachments = await loadAsset(desk, context);
  return ask(desk, { task: "deep_read", input: { context, found }, lang, attachments, ...deepReadPrompt(lang, rules, context, found) }, (raw) =>
    toDeepRead(itemId, raw, entry),
  );
}

/**
 * "Look up what is related": what the core already lists, plus a text search of the user's
 * daily digests and notes. A fuller agent would also search the web here.
 */
async function lookUp(desk: Desk, context: ItemContext): Promise<Related[]> {
  const found = [...(context.related ?? [])];
  const q = oneLine(context.item.title, LIMITS.searchQuery);
  if (q) {
    const { matches } = await desk.core.call<SearchMatches>("search_digests_and_notes", { q, limit: 10 }).catch(() => ({ matches: [] }));
    for (const match of matches) {
      if (!found.some((r) => r.kind === match.kind && r.ref === match.ref)) found.push(match);
    }
  }
  return found.slice(0, 30);
}
