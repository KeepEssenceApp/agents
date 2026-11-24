#!/usr/bin/env node
// A small fake of the assistant side of the KeepEssence contract (contract/openapi.yaml).
// For developing and testing assistants without a running core. It keeps everything in memory.
//
//   node dev/fake-core.mjs            # port 8796, empty
//   node dev/fake-core.mjs --seed     # with a few made-up items, one digest day and one queued item
//
// What it implements: the OAuth metadata documents, dynamic registration, /oauth/authorize
// (it approves at once; the real core shows the allow page), /oauth/token with PKCE and
// refresh rotation, /oauth/revoke, /mcp (Streamable HTTP, JSON responses) with every
// `x-mcp-tool` operation, and GET /v1/assistant/work. Nothing else of the contract.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const STEPS = ["triage", "analysis", "digest", "deep_read", "deep_dive"];
const WORK_KINDS = ["triage", "analysis", "digest", "deep_read"];
const VERDICTS = ["worth_deep_dive", "good_to_know", "skippable"];

const INSTRUCTIONS = [
  "KeepEssence holds what the user saved, the analyses and daily digests made from it, and the notes the user kept.",
  "A deep dive is a conversation with the user about one item: do not write the whole thing yourself.",
  "Find the item with list_deep_dive_candidates, fetch it with get_context (for: deep_dive), and call register_deep_dive only when the user asked to dig into it.",
  "Save a note with save_note only after the user said so. Write complete conclusions and give sources as the original address and title.",
].join(" ");

class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const id = (prefix) => `${prefix}_${randomBytes(9).toString("base64url")}`;
const chars = (s) => Array.from(s).length;

// ---- result validation, following components.schemas.*Result exactly
function checkFields(obj, spec, where) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw invalid(`${where} must be an object`);
  for (const key of Object.keys(obj)) if (!(key in spec)) throw invalid(`${where}.${key} is not allowed`);
  for (const [key, rule] of Object.entries(spec)) {
    const value = obj[key];
    if (value === undefined) {
      if (rule.required) throw invalid(`${where}.${key} is required`);
      continue;
    }
    if (rule.type === "string") {
      if (typeof value !== "string") throw invalid(`${where}.${key} must be a string`);
      if (rule.max && chars(value) > rule.max) throw invalid(`${where}.${key} is longer than ${rule.max}`);
      if (rule.enum && !rule.enum.includes(value)) throw invalid(`${where}.${key} is not one of ${rule.enum.join(", ")}`);
      if (rule.pattern && !rule.pattern.test(value)) throw invalid(`${where}.${key} has the wrong form`);
    } else if (rule.type === "boolean") {
      if (typeof value !== "boolean") throw invalid(`${where}.${key} must be a boolean`);
    } else if (rule.type === "integer") {
      if (!Number.isInteger(value)) throw invalid(`${where}.${key} must be an integer`);
    } else if (rule.type === "array") {
      if (!Array.isArray(value)) throw invalid(`${where}.${key} must be an array`);
      if (rule.maxItems !== undefined && value.length > rule.maxItems) throw invalid(`${where}.${key} has more than ${rule.maxItems} entries`);
      value.forEach((entry, i) => {
        if (rule.items.type === "object") checkFields(entry, rule.items.fields, `${where}.${key}[${i}]`);
        else checkFields({ v: entry }, { v: rule.items }, `${where}.${key}[${i}]`);
      });
    }
  }
}
const invalid = (message) => new ApiError(400, "invalid_result", message);

const RESULT_SPECS = {
  triage: {
    kind: { type: "string", required: true },
    item_id: { type: "string", required: true },
    assistant: { type: "string" },
    expiry_days: { type: "integer" },
  },
  analysis: {
    kind: { type: "string", required: true },
    item_id: { type: "string", required: true },
    unavailable: { type: "boolean" },
    summary: { type: "string", max: 60 },
    key_fact: { type: "string", max: 120 },
    points: { type: "array", maxItems: 3, items: { type: "string", max: 120 } },
    verdict: { type: "string", enum: VERDICTS },
    related_hint: { type: "string", max: 120 },
  },
  digest: {
    kind: { type: "string", required: true },
    day: { type: "string", required: true, pattern: /^\d{4}-\d{2}-\d{2}$/ },
    summary: { type: "string", required: true, max: 600 },
    worth: {
      type: "array",
      maxItems: 50,
      items: { type: "object", fields: { item_id: { type: "string", required: true }, line: { type: "string", required: true, max: 160 } } },
    },
    question: { type: "string", required: true, max: 160 },
  },
  deep_read: {
    kind: { type: "string", required: true },
    item_id: { type: "string", required: true },
    read: { type: "string", required: true, max: 20000 },
    found: { type: "string", required: true, max: 20000 },
    questions: { type: "array", required: true, maxItems: 8, items: { type: "string", max: 200 } },
    entry: { type: "string", max: 500 },
  },
};

function validateResult(result) {
  const spec = RESULT_SPECS[result?.kind];
  if (!spec) throw invalid("result.kind is not a kind of work");
  checkFields(result, spec, "result");
  if (result.kind === "analysis") {
    if (result.unavailable === true) {
      // "Then no points and no verdict." The fake holds assistants to the stricter reading: nothing else.
      const extra = Object.keys(result).filter((k) => !["kind", "item_id", "unavailable"].includes(k));
      if (extra.length) throw invalid(`an unavailable analysis carries nothing else, got ${extra.join(", ")}`);
    } else {
      for (const key of ["summary", "key_fact", "verdict"]) {
        if (!result[key]) throw invalid(`result.${key} is required for an analysis`);
      }
    }
  }
}

// ---- tools: name, step check, input schema; the handler is the same code a REST call would run
const str = { type: "string" };
const TOOLS = [
  { name: "claim_work", description: "Claim up to 10 pieces of work of one kind. A claim lasts 30 minutes.", properties: { kind: { type: "string", enum: WORK_KINDS }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["kind"] },
  { name: "renew_claim", description: "Extend a claim by another 30 minutes. Only its holder may.", properties: { id: str }, required: ["id"] },
  { name: "release_claim", description: "Put the work back.", properties: { id: str }, required: ["id"] },
  { name: "submit_result", description: "Hand back results for a claim, with usage.", properties: { id: str, results: { type: "array", minItems: 1, maxItems: 10, items: { type: "object" } }, usage: { type: "object" }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } }, required: ["id", "results", "idempotency_key"] },
  { name: "get_rules", readonly: true, description: "The user's rules and the settings that matter for one kind of work.", properties: { kind: { type: "string", enum: WORK_KINDS } }, required: ["kind"] },
  { name: "get_context", readonly: true, description: "What an assistant needs to work on one item.", properties: { id: str, for: { type: "string", enum: ["triage", "analysis", "deep_read", "deep_dive"] } }, required: ["id", "for"] },
  { name: "get_digest_context", readonly: true, description: "The analyses to summarise for a day, including earlier days that were missed.", properties: { day: str }, required: ["day"] },
  { name: "search_digests_and_notes", readonly: true, description: "Find text in the user's daily digests and notes, as context for work.", properties: { q: { type: "string", minLength: 1, maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["q"] },
  { name: "list_deep_dive_candidates", readonly: true, description: "What the user could dig into now. Optionally narrowed by words.", properties: { q: { type: "string", maxLength: 100 } }, required: [] },
  { name: "register_deep_dive", description: "Record that a deep dive on one item started in this assistant, only when the user asked for it.", properties: { item_id: str }, required: ["item_id"] },
  { name: "save_note", description: "Save what came out of a deep dive as a note, only after the user said so.", properties: { title: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string", minLength: 1, maxLength: 200000 }, item_id: str, sources: { type: "array", maxItems: 20, items: { type: "object" } }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } }, required: ["title", "body", "idempotency_key"] },
];

export function createFakeCore(options = {}) {
  const opts = { claimSeconds: 1800, accessSeconds: 3600, log: false, ...options };
  let origin = "";
  const state = {
    settings: { rules: "", lang: "zh", timezone: "Asia/Shanghai", expiry_options: [7, 30, 90, 365], preference: null },
    clients: new Map(),
    codes: new Map(),
    assistants: new Map(),
    access: new Map(),
    refresh: new Map(),
    items: new Map(),
    queue: new Map(),
    digestDue: new Set(),
    digests: new Map(),
    claims: new Map(),
    notes: [],
    deepDives: [],
    usage: [],
    idempotency: new Map(),
    events: [],
  };
  const now = () => Date.now();
  const event = (type, detail = {}) => {
    state.events.push({ at: now(), type, ...detail });
    if (opts.log) console.error(`[fake-core] ${type} ${JSON.stringify(detail)}`);
  };

  // ---- seeding (tests and --seed)
  function addItem(item) {
    const full = {
      id: item.id ?? id("it"),
      kind: "link",
      title: "Untitled",
      site: null,
      url: null,
      body: null,
      content_unavailable: false,
      saved_at: new Date(now()).toISOString(),
      day: "2026-11-24",
      assistant: null, // the name in the `assistant` tag; null means whoever has the analysis step
      analysis: null,
      signal: null,
      ...item,
    };
    state.items.set(full.id, full);
    return full;
  }
  function addToQueue(itemId) {
    state.queue.set(itemId, { added_at: new Date(now()).toISOString(), state: "waiting", report: null, entry: null, fetched_at: null });
  }
  function seedSample() {
    Object.assign(state.settings, { rules: "和我工作有关的（软件、产品）优先；八卦可以略过。" });
    const a = addItem({ id: "it_article", kind: "link", title: "为什么小团队应该先写契约", site: "例子博客", url: "https://example.com/contract-first", body: "这是一篇编出来的文章。它讲的是：先把接口写成一份契约，各个模块再照着做，返工会少很多。作者举了三个例子。".repeat(6) });
    addItem({ id: "it_text", kind: "text", title: "周末想法", body: "把阳台改成一个小书房：一张窄桌、一盏灯、一个书架。先量尺寸。" });
    addItem({ id: "it_missing", kind: "link", title: "一个打不开的链接", site: "example.org", url: "https://example.org/gone", content_unavailable: true });
    addItem({ id: "it_done", kind: "link", title: "昨天存的一篇", site: "例子周刊", url: "https://example.com/weekly", day: "2026-11-23", body: "编出来的周刊内容。", analysis: { unavailable: false, summary: "一份编出来的周刊，讲了三件小事。", key_fact: "例子周刊 · 约 800 字", points: ["第一件事", "第二件事"], verdict: "worth_deep_dive", related_hint: null, assistant: { id: "seed", name: "seed" }, created_at: new Date(now()).toISOString() } });
    state.digestDue.add("2026-11-23");
    addToQueue(a.id);
  }

  // ---- who is asking
  function assistantFor(req) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const grant = state.access.get(token);
    if (!grant || grant.expires_at <= now()) throw new ApiError(401, "unauthorized", "No credential, or it is unknown, revoked or expired.");
    const assistant = state.assistants.get(grant.assistant_id);
    if (!assistant || assistant.revoked) throw new ApiError(401, "unauthorized", "This assistant was revoked.");
    assistant.last_seen_at = new Date(now()).toISOString();
    return assistant;
  }
  function needStep(assistant, step) {
    if (!assistant.steps.includes(step)) throw new ApiError(403, "forbidden", `This assistant is not allowed the step ${step}.`);
  }
  const signature = (assistant) => ({ id: assistant.id, name: assistant.name });

  // ---- work
  function liveClaimOf(kind, ref) {
    for (const claim of state.claims.values()) {
      if (claim.kind === kind && claim.open.has(ref) && claim.expires_at > now()) return claim;
    }
    return null;
  }
  function available(assistant, kind) {
    if (!assistant.steps.includes(kind)) return [];
    let refs = [];
    if (kind === "analysis") {
      refs = [...state.items.values()]
        .filter((it) => !it.analysis && (it.assistant === null || it.assistant === assistant.name))
        .map((it) => ({ ref: it.id, title: it.title, due: it.saved_at }));
    } else if (kind === "digest") {
      refs = [...state.digestDue].filter((day) => !state.digests.has(day)).sort().map((day) => ({ ref: day, title: day, due: null }));
    } else if (kind === "deep_read") {
      refs = [...state.queue.entries()]
        .filter(([, entry]) => !entry.report)
        .map(([itemId, entry]) => ({ ref: itemId, title: state.items.get(itemId)?.title ?? "", due: entry.added_at }));
    }
    return refs.filter((piece) => !liveClaimOf(kind, piece.ref));
  }
  function getWork(assistant) {
    const work = [];
    for (const kind of WORK_KINDS) {
      const pieces = available(assistant, kind);
      if (pieces.length) work.push({ kind, count: pieces.length, oldest_due_at: pieces.map((p) => p.due).filter(Boolean).sort()[0] ?? null });
    }
    event("work", { assistant: assistant.name, work });
    return { work };
  }
  const claimView = (claim) => ({
    claim_id: claim.id,
    kind: claim.kind,
    expires_at: new Date(claim.expires_at).toISOString(),
    work: claim.work,
  });

  const handlers = {
    claim_work(assistant, { kind, limit = 10 }) {
      if (!WORK_KINDS.includes(kind)) throw new ApiError(400, "bad_request", "kind is not a kind of work");
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new ApiError(400, "bad_request", "limit must be 1 to 10");
      needStep(assistant, kind);
      const pieces = available(assistant, kind).slice(0, limit);
      if (!pieces.length) return { claim_id: null, kind, expires_at: null, work: [] };
      const claim = {
        id: id("cl"),
        assistant_id: assistant.id,
        kind,
        expires_at: now() + opts.claimSeconds * 1000,
        work: pieces.map(({ ref, title }) => ({ ref, title })),
        open: new Set(pieces.map((p) => p.ref)),
      };
      state.claims.set(claim.id, claim);
      event("claim", { assistant: assistant.name, claim: claim.id, kind, refs: [...claim.open] });
      return claimView(claim);
    },
    renew_claim(assistant, { id: claimId }) {
      const claim = state.claims.get(claimId);
      if (!claim || claim.assistant_id !== assistant.id) throw new ApiError(404, "not_found", "No such claim.");
      if (claim.expires_at <= now()) throw new ApiError(409, "claim_lost", "The claim expired.");
      claim.expires_at = now() + opts.claimSeconds * 1000;
      event("renew", { claim: claim.id });
      return claimView(claim);
    },
    release_claim(assistant, { id: claimId }) {
      const claim = state.claims.get(claimId);
      if (claim && claim.assistant_id === assistant.id) {
        event("release", { claim: claim.id, refs: [...claim.open] });
        claim.open.clear();
      }
      return null; // 204
    },
    submit_result(assistant, { id: claimId, results, usage, idempotency_key }) {
      if (!idempotency_key) throw new ApiError(400, "idempotency_key_required", "The Idempotency-Key is missing.");
      const seen = state.idempotency.get(`${assistant.id}:${idempotency_key}`);
      if (seen) return seen;
      const claim = state.claims.get(claimId);
      if (!claim || claim.assistant_id !== assistant.id) throw new ApiError(404, "not_found", "No such claim.");
      if (!Array.isArray(results) || results.length < 1 || results.length > 10) throw new ApiError(400, "bad_request", "results must hold 1 to 10 results");
      for (const result of results) {
        validateResult(result);
        if (result.kind !== claim.kind) throw new ApiError(400, "invalid_result", `This claim is for ${claim.kind}.`);
      }
      needStep(assistant, claim.kind);
      const outcomes = results.map((result) => {
        const ref = result.kind === "digest" ? result.day : result.item_id;
        if (!claim.work.some((piece) => piece.ref === ref)) return { ref, accepted: false, reason: "not part of this claim" };
        const other = liveClaimOf(claim.kind, ref);
        if (other && other !== claim) return { ref, accepted: false, reason: "claim_lost" };
        const sign = signature(assistant);
        if (result.kind === "analysis") {
          const item = state.items.get(ref);
          if (!item) return { ref, accepted: false, reason: "gone" };
          if (item.analysis && item.analysis.by_claim !== claim.id) return { ref, accepted: false, reason: "already submitted by another claim" };
          const { kind: _k, item_id: _i, ...fields } = result;
          item.analysis = { unavailable: false, ...fields, assistant: sign, created_at: new Date(now()).toISOString(), by_claim: claim.id };
        } else if (result.kind === "digest") {
          const known = new Set([...state.items.values()].filter((it) => it.analysis).map((it) => it.id));
          const stranger = (result.worth ?? []).find((line) => !known.has(line.item_id));
          if (stranger) return { ref, accepted: false, reason: `worth names an item without an analysis: ${stranger.item_id}` };
          const existing = state.digests.get(ref);
          if (existing && existing.by_claim !== claim.id) return { ref, accepted: false, reason: "already submitted by another claim" };
          state.digests.set(ref, { day: ref, summary: result.summary, worth: result.worth ?? [], question: result.question, assistant: sign, by_claim: claim.id });
        } else if (result.kind === "deep_read") {
          const entry = state.queue.get(ref);
          if (!entry) return { ref, accepted: false, reason: "no longer in the queue" };
          if (entry.report && entry.by_claim !== claim.id) return { ref, accepted: false, reason: "already submitted by another claim" };
          entry.report = { read: result.read, found: result.found, questions: result.questions, assistant: sign };
          entry.entry = result.entry ?? null;
          entry.state = "ready";
          entry.by_claim = claim.id;
        } else {
          return { ref, accepted: false, reason: "the fake does not take triage" };
        }
        claim.open.delete(ref);
        return { ref, accepted: true };
      });
      if (usage) state.usage.push({ assistant: assistant.name, claim: claim.id, ...usage });
      const response = { outcomes };
      state.idempotency.set(`${assistant.id}:${idempotency_key}`, response);
      event("submit", { assistant: assistant.name, claim: claim.id, kind: claim.kind, outcomes, usage: usage ?? null });
      return response;
    },
    get_rules(assistant, { kind }) {
      if (!WORK_KINDS.includes(kind)) throw new ApiError(400, "bad_request", "kind is not a kind of work");
      needStep(assistant, kind);
      return {
        rules: state.settings.rules,
        preference: state.settings.preference,
        assistants: [...state.assistants.values()].filter((a) => !a.revoked).map((a) => ({ name: a.name, steps: a.steps })),
        default_analysis_assistant: null,
        expiry_options: state.settings.expiry_options,
        lang: state.settings.lang,
        timezone: state.settings.timezone,
      };
    },
    get_context(assistant, { id: itemId, for: purpose }) {
      if (!["triage", "analysis", "deep_read", "deep_dive"].includes(purpose)) throw new ApiError(400, "bad_request", "for is not a step");
      needStep(assistant, purpose);
      const item = state.items.get(itemId);
      if (!item) throw new ApiError(404, "not_found", "No such item.");
      const entry = state.queue.get(itemId);
      if (entry && (purpose === "deep_dive" || purpose === "deep_read")) entry.fetched_at = new Date(now()).toISOString();
      const related = [];
      if (purpose !== "triage") {
        for (const other of state.items.values()) {
          if (other.id !== item.id && other.analysis && !other.analysis.unavailable) related.push({ kind: "item", ref: other.id, title: other.title, excerpt: other.analysis.summary });
        }
        for (const digest of state.digests.values()) related.push({ kind: "digest", ref: digest.day, title: digest.day, excerpt: digest.summary.slice(0, 120) });
        for (const note of state.notes) related.push({ kind: "note", ref: note.id, title: note.title, excerpt: note.body.slice(0, 120) });
      }
      const publicAnalysis = item.analysis ? (({ by_claim: _b, ...rest }) => rest)(item.analysis) : null;
      return {
        item: {
          id: item.id,
          kind: item.kind,
          title: item.title,
          site: item.site,
          url: item.url,
          opening: (item.body ?? "").slice(0, 300),
          body: purpose === "triage" ? null : item.body,
          content_unavailable: item.content_unavailable,
          asset_url: null,
          saved_at: item.saved_at,
        },
        analysis: purpose === "triage" ? null : publicAnalysis,
        deep_read: purpose === "deep_dive" ? (entry?.report ?? null) : null,
        related,
      };
    },
    get_digest_context(assistant, { day }) {
      needStep(assistant, "digest");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) throw new ApiError(400, "bad_request", "day must be YYYY-MM-DD");
      const digested = (d) => state.digests.has(d);
      const covered = [...state.items.values()].filter((it) => it.analysis && it.day <= day && !digested(it.day));
      return {
        day,
        covers: [...new Set(covered.map((it) => it.day))].sort(),
        analyses: covered.map((it) => ({
          item_id: it.id,
          title: it.title,
          site: it.site,
          url: it.url,
          summary: it.analysis.summary,
          key_fact: it.analysis.key_fact,
          points: it.analysis.points ?? [],
          verdict: it.analysis.verdict,
          unavailable: it.analysis.unavailable === true,
          signal: it.signal,
          in_queue: state.queue.has(it.id),
        })),
      };
    },
    search_digests_and_notes(assistant, { q, limit = 20 }) {
      if (!assistant.steps.some((s) => ["analysis", "digest", "deep_read", "deep_dive"].includes(s))) needStep(assistant, "analysis");
      if (typeof q !== "string" || !q || chars(q) > 100) throw new ApiError(400, "bad_request", "q must be 1 to 100 characters");
      const matches = [];
      for (const digest of state.digests.values()) {
        const text = [digest.summary, ...digest.worth.map((w) => w.line), digest.question].join("\n");
        if (text.includes(q)) matches.push({ kind: "digest", ref: digest.day, title: digest.day, excerpt: text.slice(0, 160) });
      }
      for (const note of state.notes) {
        if (note.title.includes(q) || note.body.includes(q)) matches.push({ kind: "note", ref: note.id, title: note.title, excerpt: note.body.slice(0, 160) });
      }
      return { matches: matches.slice(0, limit) };
    },
    list_deep_dive_candidates(assistant, { q } = {}) {
      needStep(assistant, "deep_dive");
      const candidates = [];
      for (const [itemId, entry] of state.queue) {
        const item = state.items.get(itemId);
        if (item) candidates.push({ item_id: itemId, title: item.title, summary: item.analysis?.summary, from: "queue", deep_read_ready: Boolean(entry.report) });
      }
      for (const digest of state.digests.values()) {
        for (const line of digest.worth) {
          const item = state.items.get(line.item_id);
          if (item && !state.queue.has(item.id)) candidates.push({ item_id: item.id, title: item.title, summary: line.line, from: "digest", deep_read_ready: false });
        }
      }
      for (const item of state.items.values()) {
        if (item.analysis && !item.analysis.unavailable && !candidates.some((c) => c.item_id === item.id)) {
          candidates.push({ item_id: item.id, title: item.title, summary: item.analysis.summary, from: "today", deep_read_ready: false });
        }
      }
      const narrowed = q ? candidates.filter((c) => c.title.includes(q) || (c.summary ?? "").includes(q)) : candidates;
      return { candidates: narrowed };
    },
    register_deep_dive(assistant, { item_id }) {
      needStep(assistant, "deep_dive");
      if (!state.items.has(item_id)) throw new ApiError(404, "not_found", "No such item.");
      state.deepDives.push({ item_id, assistant: signature(assistant), at: new Date(now()).toISOString() });
      event("deep_dive", { assistant: assistant.name, item_id });
      return { item_id };
    },
    save_note(assistant, { title, body, item_id, sources, idempotency_key }) {
      needStep(assistant, "deep_dive");
      if (!idempotency_key) throw new ApiError(400, "idempotency_key_required", "The Idempotency-Key is missing.");
      const seen = state.idempotency.get(`${assistant.id}:${idempotency_key}`);
      if (seen) return seen;
      if (typeof title !== "string" || !title || chars(title) > 200) throw new ApiError(400, "bad_request", "title must be 1 to 200 characters");
      if (typeof body !== "string" || !body || chars(body) > 200000) throw new ApiError(400, "bad_request", "body must be 1 to 200000 characters");
      if (sources !== undefined && (!Array.isArray(sources) || sources.length > 20)) throw new ApiError(400, "bad_request", "sources holds at most 20");
      const item = item_id ? state.items.get(item_id) : null;
      if (item_id && !item) throw new ApiError(404, "not_found", "No such item.");
      const note = {
        id: id("nt"),
        title,
        body,
        created_at: new Date(now()).toISOString(),
        assistant: signature(assistant),
        origin: item ? { item_id: item.id, item_title: item.title, item_url: item.url, digest_day: null } : null,
        sources: (sources ?? []).map((s) => ({ title: s.title, url: s.url ?? null })),
        asset_ids: [],
      };
      state.notes.push(note);
      if (item) state.queue.delete(item.id); // a note handed back takes the item out of the queue
      state.idempotency.set(`${assistant.id}:${idempotency_key}`, note);
      event("note", { assistant: assistant.name, note: note.id, item_id: item?.id ?? null });
      return note;
    },
  };

  // ---- /mcp: Streamable HTTP with plain JSON responses
  function rpc(assistant, message) {
    const { id: rpcId, method, params } = message;
    const reply = (result) => ({ jsonrpc: "2.0", id: rpcId, result });
    event("rpc", { assistant: assistant.name, method });
    if (method === "initialize") {
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "keepessence-fake-core", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") {
      return reply({
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: "object", properties: tool.properties, required: tool.required },
          annotations: { readOnlyHint: tool.readonly === true },
        })),
      });
    }
    if (method === "tools/call") {
      const handler = handlers[params?.name];
      if (!handler) return { jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
      try {
        const out = handler(assistant, params.arguments ?? {});
        event("tool", { assistant: assistant.name, tool: params.name });
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], ...(out ? { structuredContent: out } : {}) });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        event("tool_refused", { assistant: assistant.name, tool: params.name, code: error.code });
        return reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: error.code, message: error.message } }) }] });
      }
    }
    return { jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  // ---- authorization server
  function issue(assistantId, clientId, scope, family) {
    const access = id("ac");
    const refresh = id("rf");
    state.access.set(access, { assistant_id: assistantId, expires_at: now() + opts.accessSeconds * 1000, family });
    state.refresh.set(refresh, { assistant_id: assistantId, client_id: clientId, scope, family, used: false });
    return { access_token: access, token_type: "Bearer", expires_in: opts.accessSeconds, refresh_token: refresh, scope };
  }
  function revokeFamily(family) {
    for (const [token, grant] of state.access) if (grant.family === family) state.access.delete(token);
    for (const [token, grant] of state.refresh) if (grant.family === family) state.refresh.delete(token);
  }
  const oauthError = (res, error, description) => send(res, 400, { error, error_description: description });

  function authorize(url, res) {
    const q = url.searchParams;
    const client = state.clients.get(q.get("client_id") ?? "");
    const redirect = q.get("redirect_uri") ?? "";
    if (!client || !client.redirect_uris.includes(redirect)) return sendError(res, new ApiError(400, "bad_request", "Unknown client or redirect address."));
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
      return sendError(res, new ApiError(400, "bad_request", "The authorization-code flow with PKCE (S256) is required."));
    }
    const asked = (q.get("scope") ?? "").split(" ").filter((s) => STEPS.includes(s) && s !== "triage");
    // The real core shows the allow page here: the user names the assistant and unticks steps. The fake allows at once.
    const kind = asked.length && asked.every((s) => s === "deep_dive") ? "chat" : "scheduled";
    let name = client.client_name || "assistant";
    for (let n = 2; [...state.assistants.values()].some((a) => a.name === name); n++) name = `${client.client_name} ${n}`;
    const assistant = { id: id("as"), name, kind, steps: asked, revoked: false, runs_at: new URL(redirect).host, connected_at: new Date(now()).toISOString(), last_seen_at: null };
    state.assistants.set(assistant.id, assistant);
    const code = id("code");
    state.codes.set(code, { client_id: q.get("client_id"), redirect_uri: redirect, challenge: q.get("code_challenge"), assistant_id: assistant.id, scope: asked.join(" "), expires_at: now() + 600_000 });
    event("authorize", { assistant: assistant.name, kind, steps: asked });
    const target = new URL(redirect);
    target.searchParams.set("code", code);
    if (q.get("state")) target.searchParams.set("state", q.get("state"));
    res.writeHead(302, { location: target.href }).end();
  }

  function token(form, res) {
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const grant = state.codes.get(form.get("code") ?? "");
      state.codes.delete(form.get("code") ?? "");
      if (!grant || grant.expires_at <= now()) return oauthError(res, "invalid_grant", "Unknown or expired code.");
      if (grant.client_id !== form.get("client_id") || grant.redirect_uri !== form.get("redirect_uri")) return oauthError(res, "invalid_grant", "Client or redirect address does not match.");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== grant.challenge) return oauthError(res, "invalid_grant", "PKCE verification failed.");
      event("token", { grant: "authorization_code" });
      return send(res, 200, issue(grant.assistant_id, grant.client_id, grant.scope, id("fam")), { "cache-control": "no-store" });
    }
    if (grantType === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const grant = state.refresh.get(presented);
      if (!grant) return oauthError(res, "invalid_grant", "Unknown or revoked refresh credential.");
      if (grant.used) {
        // A rotated credential came back: someone has a copy. Everything from that approval is revoked.
        revokeFamily(grant.family);
        event("refresh_reuse", { family: grant.family });
        return oauthError(res, "invalid_grant", "This refresh credential was already used.");
      }
      if (state.assistants.get(grant.assistant_id)?.revoked) return oauthError(res, "invalid_grant", "This assistant was revoked.");
      grant.used = true;
      event("token", { grant: "refresh_token" });
      return send(res, 200, issue(grant.assistant_id, grant.client_id, grant.scope, grant.family), { "cache-control": "no-store" });
    }
    return oauthError(res, "unsupported_grant_type", "Only authorization_code and refresh_token.");
  }

  // ---- http plumbing
  function send(res, status, body, headers = {}) {
    if (body === null || body === undefined) return res.writeHead(status, headers).end();
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  }
  function sendError(res, error, headers = {}) {
    send(res, error.status, { error: { code: error.code, message: error.message } }, headers);
  }
  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") {
      return send(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: STEPS.filter((s) => s !== "triage"), bearer_methods_supported: ["header"] });
    }
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return send(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: STEPS.filter((s) => s !== "triage"),
      });
    }
    if (req.method === "POST" && path === "/oauth/register") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) return sendError(res, new ApiError(400, "bad_request", "redirect_uris must hold 1 to 5 addresses"));
      const client = { client_id: id("client"), client_name: String(body.client_name ?? "").slice(0, 80), client_uri: body.client_uri, redirect_uris: uris };
      state.clients.set(client.client_id, client);
      event("register", { client_name: client.client_name });
      return send(res, 201, { ...client, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_id_issued_at: Math.floor(now() / 1000) });
    }
    if (req.method === "GET" && path === "/oauth/authorize") return authorize(url, res);
    if (req.method === "POST" && path === "/oauth/token") return token(new URLSearchParams(await readBody(req)), res);
    if (req.method === "POST" && path === "/oauth/revoke") {
      const grant = state.refresh.get(new URLSearchParams(await readBody(req)).get("token") ?? "");
      if (grant) revokeFamily(grant.family);
      event("revoke", { known: Boolean(grant) });
      return send(res, 200, {});
    }

    if (path === "/mcp" || path === "/v1/assistant/work") {
      let assistant;
      try {
        assistant = assistantFor(req);
      } catch (error) {
        return sendError(res, error, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      }
      if (path === "/v1/assistant/work") {
        if (req.method !== "GET") return send(res, 405, null, { allow: "GET" });
        return send(res, 200, getWork(assistant));
      }
      if (req.method !== "POST") return send(res, 405, null, { allow: "POST" }); // no server-sent stream, no sessions
      const message = JSON.parse(await readBody(req));
      if (Array.isArray(message)) return send(res, 200, message.filter((m) => m.id !== undefined).map((m) => rpc(assistant, m)));
      if (message.id === undefined) return send(res, 202, null); // a notification
      return send(res, 200, rpc(assistant, message));
    }

    // dev-only helpers; not part of the contract
    if (req.method === "GET" && path === "/__dev/state") {
      return send(res, 200, {
        items: [...state.items.values()],
        digests: [...state.digests.values()],
        queue: Object.fromEntries(state.queue),
        notes: state.notes,
        assistants: [...state.assistants.values()],
        usage: state.usage,
        events: state.events,
      });
    }
    return sendError(res, new ApiError(404, "not_found", "Not part of the fake."));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof ApiError) return sendError(res, error);
      console.error("[fake-core]", error);
      sendError(res, new ApiError(500, "server_error", String(error?.message ?? error)));
    });
  });

  return {
    state,
    addItem,
    addToQueue,
    seedSample,
    /** Make every access credential expire now; refresh credentials stay. */
    expireAccess() {
      for (const grant of state.access.values()) grant.expires_at = 0;
    },
    /** Make every live claim expire now, as if 30 minutes passed. */
    expireClaims() {
      for (const claim of state.claims.values()) claim.expires_at = 0;
    },
    revokeAssistants() {
      for (const assistant of state.assistants.values()) assistant.revoked = true;
    },
    eventsOf: (type) => state.events.filter((e) => e.type === type),
    async start(port = 8796) {
      await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
    get origin() {
      return origin;
    },
    stop: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const core = createFakeCore({
    log: true,
    claimSeconds: Number(process.env.FAKE_CLAIM_SECONDS ?? 1800),
    accessSeconds: Number(process.env.FAKE_ACCESS_SECONDS ?? 3600),
  });
  if (process.argv.includes("--seed")) core.seedSample();
  const origin = await core.start(Number(process.env.PORT ?? 8796));
  console.error(`[fake-core] listening. Connect address: ${origin}/mcp`);
}
