// The chat-assistant check (acceptance X6) against the fake of the contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatConfig, runCheck } from "../examples/chat-assistant-check/check.ts";
import { stubModel } from "../examples/scheduled-agent/src/model.ts";
import { Agent } from "../examples/scheduled-agent/src/run.ts";
import { bench, connected, pressAllow } from "./helpers.ts";

const silent = { show: pressAllow, say: () => undefined };

test("a chat assistant lists candidates, fetches context, registers a deep dive and saves a note; other tools are refused", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  b.fake.seedSample();
  await new Agent(b.config, { model: stubModel(), log: () => undefined }).runOnce(); // so there is something to dig into

  const lines: string[] = [];
  const report = await runCheck(chatConfig(b.env), { connectOptions: silent, log: (line) => lines.push(line) });
  assert.deepEqual(report.failed, [], lines.join("\n"));
  assert.equal(report.passed.length, 11);

  const chat = [...b.fake.state.assistants.values()].find((a) => a.kind === "chat")!;
  assert.deepEqual(chat.steps, ["deep_dive"]);
  assert.equal(b.fake.state.deepDives.length, 1);
  assert.equal(b.fake.state.notes.length, 1, "saving twice with the same key made one note");
  assert.equal(b.fake.state.notes[0]!.assistant.name, chat.name);
  assert.equal(b.fake.state.notes[0]!.origin!.item_id, b.fake.state.deepDives[0]!.item_id);
  assert.deepEqual(
    b.fake.eventsOf("tool_refused").map((e) => [e.tool, e.code]),
    [
      ["claim_work", "forbidden"],
      ["claim_work", "forbidden"],
      ["get_rules", "forbidden"],
      ["get_context", "forbidden"],
    ],
  );
});

test("the check fails, and says where, when there is nothing to dig into", async (t) => {
  const b = await bench();
  t.after(() => b.fake.stop());
  const report = await runCheck(chatConfig(b.env), { connectOptions: silent, log: () => undefined });
  assert.deepEqual(report.failed, ["list deep-dive candidates"]);
});

test("a scheduled assistant without the deep-dive step cannot use the chat tools", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  b.fake.seedSample();
  await new Agent(b.config, { model: stubModel(), log: () => undefined }).runOnce();
  const refusedBefore = b.fake.eventsOf("tool_refused").length;
  // same credential as the scheduled agent, used through the check: every deep-dive tool must be refused
  const report = await runCheck({ ...b.config }, { connectOptions: silent, log: () => undefined });
  assert.ok(report.failed.includes("list deep-dive candidates"));
  assert.ok(b.fake.eventsOf("tool_refused").length > refusedBefore);
  assert.equal(b.fake.state.notes.length, 0);
});
