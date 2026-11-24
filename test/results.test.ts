import assert from "node:assert/strict";
import { test } from "node:test";
import type { DigestContext } from "../examples/scheduled-agent/src/contract.ts";
import { oneLine, parseObject, toAnalysis, toDeepRead, toDigest, unavailableAnalysis } from "../examples/scheduled-agent/src/results.ts";

const length = (text: string) => Array.from(text).length;

test("a line is cut by characters, not by UTF-16 units, and stays one line", () => {
  assert.equal(oneLine("  两行\n合成  一行 ", 60), "两行 合成 一行");
  const emoji = "😀".repeat(70); // 140 UTF-16 units, 70 characters
  assert.equal(length(oneLine(emoji, 60)), 60);
  assert.equal(oneLine("字".repeat(60), 60), "字".repeat(60));
  assert.ok(oneLine("字".repeat(61), 60).endsWith("…"));
});

test("an analysis is held to the contract's limits", () => {
  const result = toAnalysis("it_1", {
    summary: "概".repeat(200),
    key_fact: "事实\n第二行".padEnd(300, "长"),
    points: ["一", "", "二".repeat(500), "三", "四"],
    verdict: "值得深挖",
    related_hint: "   ",
    extra: "dropped",
  });
  assert.deepEqual(Object.keys(result).sort(), ["item_id", "key_fact", "kind", "points", "summary", "verdict"]);
  assert.equal(length(result.summary!), 60);
  assert.equal(length(result.key_fact!), 120);
  assert.ok(!result.key_fact!.includes("\n"));
  assert.equal(result.points!.length, 3);
  assert.ok(result.points!.every((point) => length(point) <= 120));
  assert.equal(result.verdict, "worth_deep_dive");
});

test("an analysis without a summary, a key fact or a known verdict is not handed back", () => {
  assert.throws(() => toAnalysis("it_1", { summary: "有", key_fact: "有", verdict: "maybe" }));
  assert.throws(() => toAnalysis("it_1", { summary: "", key_fact: "有", verdict: "skippable" }));
  assert.throws(() => toAnalysis("it_1", { summary: "有", verdict: "skippable" }));
});

test("content that could not be fetched: unavailable and nothing else", () => {
  assert.deepEqual(unavailableAnalysis("it_9"), { kind: "analysis", item_id: "it_9", unavailable: true });
});

test("a digest lists only what is worth a deep dive and not dealt with, whatever the model wrote", () => {
  const context: DigestContext = {
    day: "2026-11-24",
    analyses: [
      { item_id: "a", title: "A", summary: "A 的概述", verdict: "worth_deep_dive" },
      { item_id: "b", title: "B", summary: "B", verdict: "good_to_know" },
      { item_id: "c", title: "C", summary: "C", verdict: "worth_deep_dive", signal: "seen" },
      { item_id: "d", title: "D", summary: "D", verdict: "worth_deep_dive", in_queue: true },
      { item_id: "e", title: "E", summary: "E 的概述", verdict: "worth_deep_dive" },
    ],
  };
  const raw = {
    summary: "总".repeat(700),
    worth: [
      { item_id: "a", line: "结".repeat(300) },
      { item_id: "b", line: "不该在" },
      { item_id: "zzz", line: "不存在" },
    ],
    question: "问？",
  };
  const result = toDigest("2026-11-24", raw, context);
  assert.equal(length(result.summary), 600);
  assert.deepEqual(
    result.worth!.map((w) => w.item_id),
    ["a", "e"],
  );
  assert.equal(length(result.worth![0]!.line), 160);
  assert.equal(result.worth![1]!.line, "E 的概述"); // the model forgot it: the analysis's own summary stands in
  assert.throws(() => toDigest("2026-11-24", { summary: "有", question: "" }, context));
});

test("a deep read is held to the contract's limits", () => {
  const questions = Array.from({ length: 12 }, (_, i) => `问题 ${i}`.padEnd(400, "？"));
  const result = toDeepRead("it_1", { read: "读".repeat(30000), found: "查到\n两行", questions }, "https://agent.example/chat");
  assert.equal(length(result.read), 20000);
  assert.equal(result.found, "查到\n两行");
  assert.equal(result.questions.length, 8);
  assert.ok(result.questions.every((q) => length(q) <= 200));
  assert.equal(result.entry, "https://agent.example/chat");
  assert.equal("entry" in toDeepRead("it_1", { read: "a", found: "b", questions: [] }), false);
});

test("the model's JSON is found inside a code fence or a sentence", () => {
  assert.deepEqual(parseObject('好的：\n```json\n{"summary": "一句"}\n```'), { summary: "一句" });
  assert.throws(() => parseObject("no json here"));
});
