// The scheduled agent, end to end, against the fake of the contract. No real model is called.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { loadConfig } from "../examples/scheduled-agent/src/config.ts";
import { stubModel, type Model } from "../examples/scheduled-agent/src/model.ts";
import { connect, NotConnectedError } from "../examples/scheduled-agent/src/oauth.ts";
import { Agent } from "../examples/scheduled-agent/src/run.ts";
import { bench, connected, length, pressAllow, runCli } from "./helpers.ts";

const quiet = { log: () => undefined };
const refreshCredential = (file: string): string => JSON.parse(readFileSync(file, "utf8")).tokens.refresh_token;

test("connect: discovery, dynamic registration, PKCE, and a credential file only its owner can read", async (t) => {
  const b = await bench();
  t.after(() => b.fake.stop());
  let allowPage: URL | undefined;
  const { scope } = await connect(b.config, { show: (url) => ((allowPage = url), pressAllow(url)), say: () => undefined });

  assert.equal(scope, "analysis digest deep_read");
  assert.equal(allowPage!.origin, b.fake.origin, "the authorization server came from the protected-resource metadata");
  assert.equal(allowPage!.searchParams.get("code_challenge_method"), "S256");
  assert.equal(allowPage!.searchParams.get("resource"), `${b.fake.origin}/mcp`);
  assert.match(allowPage!.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(b.fake.eventsOf("register").length, 1);
  assert.deepEqual(b.fake.eventsOf("authorize")[0]!.steps, ["analysis", "digest", "deep_read"]);

  assert.equal(statSync(b.config.credentialFile).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(b.config.credentialFile, "utf8"));
  assert.ok(stored.tokens.refresh_token);
  assert.equal(stored.client.client_secret, undefined, "a public client holds no fixed secret");
});

test("connecting again replaces the credential and revokes the old one", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  const first = refreshCredential(b.config.credentialFile);
  await connect(b.config, { show: pressAllow, say: () => undefined });
  assert.notEqual(refreshCredential(b.config.credentialFile), first);
  assert.deepEqual(b.fake.eventsOf("revoke").map((e) => e.known), [true]);
});

test("no work: one plain request, no session, no model (rule D3)", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  const model: Model = { name: "never", complete: () => assert.fail("the model was called") };
  const report = await new Agent(b.config, { model, ...quiet }).runOnce();
  assert.deepEqual(report, { waiting: [], accepted: 0, notAccepted: 0, failed: 0 });
  assert.equal(b.fake.eventsOf("work").length, 1);
  assert.equal(b.fake.eventsOf("rpc").length, 0, "the assistant endpoint was not opened");

  const cli = await runCli({ ...b.env, MODEL: "anthropic" }, ["run-once"]); // no model configured: it must not matter
  assert.deepEqual(cli, { code: 0, stdout: "", stderr: "" });
});

test("a run after three days away: analyses, three digests and a deep read arrive, within the limits", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  const { fake } = b;
  fake.seedSample(); // three items to analyse (one without content), 2026-11-23 to summarise, one queued item
  for (const day of ["2026-11-21", "2026-11-22"]) {
    fake.state.digestDue.add(day);
    fake.addItem({ id: `it_${day}`, title: `${day} 的一篇`, day, body: "编的。", analysis: { unavailable: false, summary: "编的概述", key_fact: "约 3 字", points: [], verdict: "worth_deep_dive", assistant: { id: "seed", name: "seed" } } });
  }

  const report = await new Agent(b.config, { model: stubModel(), ...quiet }).runOnce();
  assert.deepEqual({ accepted: report.accepted, notAccepted: report.notAccepted, failed: report.failed }, { accepted: 3 + 3 + 1, notAccepted: 0, failed: 0 });

  const article = fake.state.items.get("it_article")!.analysis!;
  assert.ok(length(article.summary as string) <= 60);
  assert.ok((article.summary as string).startsWith("这一条讲的是"), "written in the user's language");
  assert.equal(article.key_fact, "例子博客 · 约 312 字");
  assert.equal((article.points as string[]).length, 3);
  assert.equal(article.verdict, "worth_deep_dive");
  assert.ok(article.related_hint);
  assert.equal(article.assistant.name, "Scheduled agent", "signed by the assistant");
  assert.equal(fake.state.items.get("it_text")!.analysis!.key_fact, "30 字", "the key fact follows the kind of content");

  const missing = fake.state.items.get("it_missing")!.analysis!;
  assert.deepEqual(Object.keys(missing).sort(), ["assistant", "by_claim", "created_at", "unavailable"], "unavailable and nothing else");
  assert.equal(missing.unavailable, true);

  assert.deepEqual([...fake.state.digests.keys()].sort(), ["2026-11-21", "2026-11-22", "2026-11-23"]);
  const digest = fake.state.digests.get("2026-11-23")!;
  assert.ok(digest.summary && digest.question);
  assert.ok(digest.worth.length > 0);
  for (const line of digest.worth) assert.equal(fake.state.items.get(line.item_id)!.analysis!.verdict, "worth_deep_dive");

  const queued = fake.state.queue.get("it_article")!;
  assert.equal(queued.state, "ready");
  assert.ok(queued.report!.read && queued.report!.found);
  assert.ok(queued.report!.questions.length <= 8);

  assert.equal(fake.state.usage.length, 3, "usage is reported with each claim");
  assert.ok(fake.state.usage.every((u) => u.model === "stub" && u.calls > 0 && u.input_tokens > 0 && u.output_tokens > 0));

  // Coming again right away finds nothing and changes nothing.
  const claims = fake.eventsOf("claim").length;
  const again = await new Agent(b.config, { model: stubModel(), ...quiet }).runOnce();
  assert.deepEqual(again.waiting, []);
  assert.equal(fake.eventsOf("claim").length, claims);
});

test("it writes in the user's language, taken from the rules", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  b.fake.state.settings.lang = "en";
  b.fake.addItem({ id: "it_en", kind: "text", title: "A note", body: "A made-up note about nothing in particular." });
  await new Agent(b.config, { model: stubModel(), ...quiet }).runOnce();
  const analysis = b.fake.state.items.get("it_en")!.analysis!;
  assert.match(analysis.summary as string, /^This item is about/);
  assert.equal(analysis.key_fact, "43 characters");
});

test("the deep-dive entry is handed back with a deep read when configured", async (t) => {
  const b = await connected({}, { KEEPESSENCE_DEEP_DIVE_ENTRY: "https://agent.example/chat?item={item_id}" });
  t.after(() => b.fake.stop());
  b.fake.addItem({ id: "it_q", title: "排队的一篇", body: "编的。", analysis: { unavailable: false, summary: "编的", key_fact: "约 3 字", verdict: "good_to_know", assistant: { id: "seed", name: "seed" } } });
  b.fake.addToQueue("it_q");
  await new Agent(b.config, { model: stubModel(), ...quiet }).runOnce();
  assert.equal(b.fake.state.queue.get("it_q")!.entry, "https://agent.example/chat?item=it_q");
});

test("the access credential is refreshed without anyone, and the refresh credential rotates", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  const before = refreshCredential(b.config.credentialFile);
  b.fake.expireAccess(); // an hour later
  b.fake.addItem({ kind: "text", title: "一条", body: "编出来的一句话，够长才不会被略过。" });
  const report = await new Agent(b.config, { model: stubModel(), ...quiet }).runOnce();
  assert.equal(report.accepted, 1);
  assert.notEqual(refreshCredential(b.config.credentialFile), before);
  assert.equal(statSync(b.config.credentialFile).mode & 0o777, 0o600);
  assert.equal(b.fake.eventsOf("token").filter((e) => e.grant === "refresh_token").length, 1);
});

test("a credential close to running out is refreshed before it is used", async (t) => {
  const b = await connected({ accessSeconds: 1 });
  t.after(() => b.fake.stop());
  b.fake.addItem({ kind: "text", title: "一条", body: "编出来的一句话。" });
  await new Promise((resolve) => setTimeout(resolve, 600)); // past half of its one second
  await new Agent(b.config, { model: stubModel(), ...quiet }).runOnce();
  assert.ok(b.fake.eventsOf("token").filter((e) => e.grant === "refresh_token").length >= 1);
});

test("two copies at once: every piece is done exactly once and the credential survives", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  const { fake } = b;
  for (let n = 0; n < 25; n++) fake.addItem({ id: `it_${n}`, kind: "text", title: `第 ${n} 条`, body: `编出来的第 ${n} 段话，长度够用。` });
  fake.addItem({ id: "it_old", title: "前一天的", day: "2026-11-23", analysis: { unavailable: false, summary: "编的", key_fact: "约 3 字", verdict: "worth_deep_dive", assistant: { id: "seed", name: "seed" } } });
  fake.state.digestDue.add("2026-11-23");
  fake.addToQueue("it_old");
  fake.expireAccess(); // both copies find the access credential expired at the same moment

  const env = { ...b.env, STUB_DELAY_MS: "15" };
  const [one, two] = await Promise.all([runCli(env, ["run-once"]), runCli(env, ["run-once"])]);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(two.code, 0, two.stderr);

  assert.equal(fake.eventsOf("refresh_reuse").length, 0, "the rotating credential was never used twice");
  assert.equal(fake.eventsOf("token").filter((e) => e.grant === "refresh_token").length, 1);

  const claimed = fake.eventsOf("claim").flatMap((e) => (e.refs as string[]).map((ref) => `${e.kind}:${ref}`));
  assert.equal(new Set(claimed).size, claimed.length, "no piece was claimed twice");
  assert.equal(claimed.length, 25 + 1 + 1);
  const outcomes = fake.eventsOf("submit").flatMap((e) => e.outcomes as { accepted: boolean }[]);
  assert.equal(outcomes.length, 27);
  assert.ok(outcomes.every((o) => o.accepted));
  for (let n = 0; n < 25; n++) assert.ok(fake.state.items.get(`it_${n}`)!.analysis);
  assert.equal(fake.state.digests.size, 1);
  assert.equal(fake.state.queue.get("it_old")!.state, "ready");
  assert.ok(fake.eventsOf("claim").some((e) => (e.refs as string[]).length === 10), "a claim takes at most 10");
  assert.ok(fake.eventsOf("claim").every((e) => (e.refs as string[]).length <= 10));
});

test("a claim is renewed when the work runs long", async (t) => {
  const b = await connected({ claimSeconds: 2 });
  t.after(() => b.fake.stop());
  for (let n = 0; n < 4; n++) b.fake.addItem({ kind: "text", title: `慢的第 ${n} 条`, body: "编出来的一段话，长度够用。" });
  const report = await new Agent(b.config, { model: stubModel(700), ...quiet }).runOnce(); // 2.8 s of work on a 2 s claim
  assert.ok(b.fake.eventsOf("renew").length >= 1);
  assert.deepEqual({ accepted: report.accepted, notAccepted: report.notAccepted }, { accepted: 4, notAccepted: 0 });
});

test("what it will not finish is released at once, and a later run picks it up", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  for (const id of ["it_a", "it_bad", "it_c"]) b.fake.addItem({ id, kind: "text", title: id, body: "编出来的一段话，长度够用。" });
  const stub = stubModel();
  const flaky: Model = {
    name: "flaky",
    complete: (request) => (request.task === "analysis" && request.input.item.id === "it_bad" ? Promise.reject(new Error("the model is down")) : stub.complete(request)),
  };
  const report = await new Agent(b.config, { model: flaky, ...quiet }).runOnce();
  assert.deepEqual({ accepted: report.accepted, failed: report.failed }, { accepted: 2, failed: 1 });
  assert.deepEqual(b.fake.eventsOf("release").map((e) => e.refs), [["it_bad"]]);
  assert.equal(b.fake.state.items.get("it_bad")!.analysis, null);

  const later = await new Agent(b.config, { model: stub, ...quiet }).runOnce();
  assert.deepEqual(later.waiting.map((w) => [w.kind, w.count]), [["analysis", 1]]);
  assert.equal(later.accepted, 1);
});

test("a malformed answer from the model gets one more try, then the piece is left", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  b.fake.addItem({ id: "it_x", kind: "text", title: "x", body: "编出来的一段话，长度够用。" });
  let calls = 0;
  const stub = stubModel();
  const stutter: Model = { name: "stutter", complete: async (request) => (++calls === 1 ? { text: "抱歉，我不会 JSON。", inputTokens: 5, outputTokens: 5 } : stub.complete(request)) };
  const report = await new Agent(b.config, { model: stutter, ...quiet }).runOnce();
  assert.equal(report.accepted, 1);
  assert.equal(b.fake.state.usage[0]!.calls, 2, "both calls are reported");
});

test("a claim that expired and was done by another assistant: the late hand-back changes nothing", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  const { fake } = b;
  for (let n = 0; n < 3; n++) fake.addItem({ id: `it_${n}`, kind: "text", title: `第 ${n} 条`, body: "编出来的一段话，长度够用。" });
  // a second assistant of the same user, with its own credential
  const otherConfig = loadConfig({ ...b.env, KEEPESSENCE_CONFIG_DIR: `${b.env.KEEPESSENCE_CONFIG_DIR}/other`, KEEPESSENCE_AGENT_NAME: "Other agent" });
  await connect(otherConfig, { show: pressAllow, say: () => undefined });

  const stub = stubModel();
  let overtaken = false;
  const slow: Model = {
    name: "slow",
    async complete(request) {
      if (!overtaken) {
        overtaken = true;
        fake.expireClaims(); // thirty minutes pass while this model call hangs
        await new Agent(otherConfig, { model: stub, ...quiet }).runOnce();
      }
      return stub.complete(request);
    },
  };
  const report = await new Agent(b.config, { model: slow, ...quiet }).runOnce();
  assert.deepEqual({ accepted: report.accepted, notAccepted: report.notAccepted }, { accepted: 0, notAccepted: 3 });
  for (let n = 0; n < 3; n++) assert.equal(fake.state.items.get(`it_${n}`)!.analysis!.assistant.name, "Other agent");
});

test("revoked in the product: the run stops and says to connect again", async (t) => {
  const b = await connected();
  t.after(() => b.fake.stop());
  b.fake.addItem({ kind: "text", title: "一条", body: "编的。" });
  b.fake.revokeAssistants();
  await assert.rejects(new Agent(b.config, { model: stubModel(), ...quiet }).runOnce(), NotConnectedError);
  const cli = await runCli(b.env, ["run-once"]);
  assert.equal(cli.code, 2);
  assert.match(cli.stderr, /Run "connect"/);
});

test("never connected: run-once says so", async (t) => {
  const b = await bench();
  t.after(() => b.fake.stop());
  const cli = await runCli(b.env, ["run-once"]);
  assert.equal(cli.code, 2);
  assert.match(cli.stderr, /has not been connected/);
});
