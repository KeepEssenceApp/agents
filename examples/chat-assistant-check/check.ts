#!/usr/bin/env -S npx tsx
// Plays a chat assistant against the assistant endpoint, to prove it works with a real MCP client
// (acceptance X6): connect with only the deep-dive step, list what could be dug into, fetch one
// item's context, register a deep dive, save a note, and confirm that a tool outside its steps
// is refused.
//
//   npx tsx check.ts [--connect] [--query <words>] [--item <item id>] [--no-note]
//
// The note it saves is a made-up one that says so in its title. Use --no-note to leave nothing behind.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "../scheduled-agent/src/config.ts";
import { Core, ToolError } from "../scheduled-agent/src/core.ts";
import { connect, storedProvider, type ConnectOptions } from "../scheduled-agent/src/oauth.ts";

interface Candidate {
  item_id: string;
  title: string;
  summary?: string;
  from: "queue" | "digest" | "today";
  deep_read_ready?: boolean;
}

export interface CheckOptions {
  forceConnect?: boolean;
  query?: string;
  itemId?: string;
  saveNote?: boolean;
  connectOptions?: ConnectOptions;
  log?: (line: string) => void;
}

export interface CheckReport {
  passed: string[];
  failed: string[];
}

/** A chat assistant gets its own credential file and asks for the deep-dive step only. */
export function chatConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig({ KEEPESSENCE_AGENT_NAME: "Chat assistant check", ...env, KEEPESSENCE_STEPS: "deep_dive" }, "chat-check");
}

const READ_ONLY = ["list_deep_dive_candidates", "get_context", "search_digests_and_notes"];
const WRITES = ["register_deep_dive", "save_note"];

export async function runCheck(config: Config, options: CheckOptions = {}): Promise<CheckReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  const report: CheckReport = { passed: [], failed: [] };
  const step = async (name: string, body: () => Promise<string | void>): Promise<boolean> => {
    try {
      const detail = await body();
      report.passed.push(name);
      log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
      return true;
    } catch (error) {
      report.failed.push(name);
      log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const refused = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    try {
      await core.call(tool, args);
    } catch (error) {
      if (error instanceof ToolError && error.code === "forbidden") return "refused with forbidden";
      throw new Error(`expected forbidden, got ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error("the call was allowed");
  };

  const core = new Core(config, storedProvider(config));
  const ready = await step("connect with only the deep_dive step", async () => {
    if (options.forceConnect || !existsSync(config.credentialFile)) {
      const { scope } = await connect(config, options.connectOptions);
      if (scope && scope.trim() !== "deep_dive") throw new Error(`the core granted "${scope}", expected only deep_dive`);
    }
    const { instructions } = await core.open("keepessence-chat-assistant-check");
    return instructions ? `server instructions: ${Array.from(instructions).slice(0, 80).join("")}…` : "connected (the server sent no instructions)";
  });
  if (!ready) return report;

  try {
    await step("the deep-dive tools are offered, read-only ones marked", async () => {
      const tools = await core.listTools();
      for (const name of [...READ_ONLY, ...WRITES]) {
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw new Error(`${name} is not in the tool list`);
        const readOnly = tool.annotations?.readOnlyHint === true;
        if (READ_ONLY.includes(name) !== readOnly) throw new Error(`${name} should ${READ_ONLY.includes(name) ? "" : "not "}be marked read-only`);
      }
      return `${tools.length} tools`;
    });

    let candidate: Candidate | undefined;
    await step("list deep-dive candidates", async () => {
      const { candidates } = await core.call<{ candidates: Candidate[] }>("list_deep_dive_candidates", options.query ? { q: options.query } : {});
      candidate = options.itemId ? candidates.find((c) => c.item_id === options.itemId) : candidates[0];
      if (!candidate) throw new Error(candidates.length ? `item ${options.itemId} is not among the ${candidates.length} candidates` : "there are no candidates; save and analyse something first");
      return `${candidates.length} candidates; taking “${candidate.title}” (from ${candidate.from})`;
    });

    if (candidate) {
      const item = candidate;
      await step("fetch one item's context", async () => {
        const context = await core.call<{ item: { id: string; title: string }; deep_read?: unknown; related?: unknown[] }>("get_context", { id: item.item_id, for: "deep_dive" });
        if (context.item.id !== item.item_id) throw new Error("the context is for another item");
        return `“${context.item.title}”, deep read ${context.deep_read ? "attached" : "not there"}, ${context.related?.length ?? 0} related`;
      });

      await step("register a deep dive", async () => {
        const registered = await core.call<{ item_id: string }>("register_deep_dive", { item_id: item.item_id });
        if (registered.item_id !== item.item_id) throw new Error("the core registered another item");
      });

      if (options.saveNote !== false) {
        await step("save a note, twice with the same key", async () => {
          const note = {
            title: `连接检查：${item.title}`.slice(0, 200),
            body: `这是一份检查用的笔记，内容是编的，可以删除。\n\n它证明一只对话型助手能经 MCP 列出可深挖的、取上下文、登记深挖、存回笔记。\n\n出处：${item.title}`,
            item_id: item.item_id,
            sources: [{ title: item.title }],
            idempotency_key: `chat-check-${item.item_id}-${Date.now()}`,
          };
          const first = await core.call<{ id: string; assistant?: { name?: string } }>("save_note", note);
          const second = await core.call<{ id: string }>("save_note", note);
          if (!first.id) throw new Error("the note came back without an id");
          if (second.id !== first.id) throw new Error("saving again with the same key made a second note");
          return `note ${first.id}, signed ${first.assistant?.name ?? "(no signature)"}`;
        });
      }
    }

    await step("claiming analysis work is refused", () => refused("claim_work", { kind: "analysis" }));
    await step("claiming digest work is refused", () => refused("claim_work", { kind: "digest" }));
    await step("the rules for analysis are refused", () => refused("get_rules", { kind: "analysis" }));
    if (candidate) {
      const item = candidate;
      await step("an item's context for analysis is refused", () => refused("get_context", { id: item.item_id, for: "analysis" }));
    }
    await step("there is no scheduled work for a chat assistant", async () => {
      const work = await core.getWork();
      if (work.some((w) => w.count > 0)) throw new Error(`the core offers it ${JSON.stringify(work)}`);
    });
  } finally {
    await core.close();
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const config = chatConfig();
  console.log(`Connect address: ${config.serverUrl}`);
  runCheck(config, { forceConnect: args.includes("--connect"), query: value("--query"), itemId: value("--item"), saveNote: !args.includes("--no-note") }).then(
    (report) => {
      console.log(`${report.passed.length} passed, ${report.failed.length} failed`);
      process.exit(report.failed.length ? 1 : 0);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
