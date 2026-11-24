// The same end-to-end run as the tests, against a real core started locally (../core, `npm run dev`, port 8791).
//
//   CORE_ADMIN_SECRET=<the core's ADMIN_SECRET> npm run e2e:core
//
// What it does, all with made-up content and MODEL=stub (no real model is called):
//   1. creates an invite and a sign-in code through the core's admin endpoints, signs in as that user
//   2. saves a few items
//   3. connects the scheduled agent; plays the user on the allow page through
//      /v1/oauth/requests/{id}/decision
//   4. makes the agent the analysis, digest and deep-read assistant, queues one item
//   5. runs the agent until analyses, a deep read and a digest arrived (or the time is up)
//   6. runs the chat-assistant check (acceptance X6)
// Everything it finds that differs from the contract is listed at the end. The contract decides who is wrong.
//
// Other settings: CORE_URL (default http://127.0.0.1:8791), CORE_ADMIN_INVITES_PATH, CORE_ADMIN_LOGIN_CODE_PATH
// (the admin endpoints are not part of the contract), E2E_TIMEOUT_SECONDS (default 180; without the
// dispatch assistant running, the core triages an item by default only after 10 minutes: use 720).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chatConfig, runCheck } from "../examples/chat-assistant-check/check.ts";
import { loadConfig } from "../examples/scheduled-agent/src/config.ts";
import { stubModel } from "../examples/scheduled-agent/src/model.ts";
import { connect } from "../examples/scheduled-agent/src/oauth.ts";
import { Agent } from "../examples/scheduled-agent/src/run.ts";

const CORE = (process.env.CORE_URL ?? "http://127.0.0.1:8791").replace(/\/$/, "");
const ADMIN_SECRET = process.env.CORE_ADMIN_SECRET ?? "";
const INVITES = process.env.CORE_ADMIN_INVITES_PATH ?? "/admin/invites";
const LOGIN_CODES = process.env.CORE_ADMIN_LOGIN_CODE_PATH ?? "/admin/login-codes";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_SECONDS ?? 180) * 1000;

const differences: string[] = [];
const failures: string[] = [];
const say = (line: string) => console.log(line);
const differs = (line: string) => (differences.push(line), say(`DIFFERS  ${line}`));
const fails = (line: string) => (failures.push(line), say(`FAIL  ${line}`));

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

async function http<T = any>(method: string, path: string, options: { bearer?: string; json?: unknown; key?: string } = {}): Promise<Reply<T>> {
  const response = await fetch(path.startsWith("http") ? path : `${CORE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.key ? { "idempotency-key": options.key } : {}),
    },
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

function expectStatus(what: string, reply: Reply<unknown>, ...wanted: number[]): void {
  if (!wanted.includes(reply.status)) throw new Error(`${what}: expected ${wanted.join(" or ")}, got ${reply.status} ${JSON.stringify(reply.body).slice(0, 300)}`);
}

/** A time zone where it is now between 22:00 and 23:00, so today's digest is due (it is made after 21:00). */
function eveningZone(): string {
  const offset = (22 - new Date().getUTCHours() + 24) % 24; // hours east of UTC, 0..23
  const signed = offset > 12 ? offset - 24 : offset;
  return signed === 0 ? "Etc/UTC" : `Etc/GMT${signed > 0 ? "-" : "+"}${Math.abs(signed)}`; // Etc/GMT signs are inverted
}

/** Plays the user on the allow page: reads the request, then allows it through the contract's decision endpoint. */
function allowAs(user: string, decision: { name: string; kind: "scheduled" | "chat"; steps: string[] }) {
  return async (url: URL): Promise<void> => {
    const start = await http("GET", url.href);
    if (start.status !== 302) differs(`GET /oauth/authorize answered ${start.status}; the contract says 302 to the allow page`);
    const allowPage = new URL(start.headers.get("location") ?? "", CORE);
    const requestId = allowPage.searchParams.get("request_id") ?? allowPage.searchParams.get("request") ?? allowPage.pathname.split("/").filter(Boolean).pop() ?? "";
    say(`  allow page: ${allowPage.pathname}${allowPage.search} -> request ${requestId}`);
    const shown = await http("GET", `/v1/oauth/requests/${encodeURIComponent(requestId)}`, { bearer: user });
    expectStatus("GET /v1/oauth/requests/{id}", shown, 200);
    for (const field of ["client_name", "redirect_host", "steps_requested"]) {
      if (shown.body[field] === undefined) differs(`the authorization request has no ${field}`);
    }
    say(`  the allow page would show: ${shown.body.client_name}, sends content to ${shown.body.redirect_host}, asks for ${JSON.stringify(shown.body.steps_requested)}`);
    const decided = await http("POST", `/v1/oauth/requests/${encodeURIComponent(requestId)}/decision`, { bearer: user, json: { allow: true, ...decision } });
    expectStatus("POST /v1/oauth/requests/{id}/decision", decided, 200);
    void fetch(decided.body.redirect_to).then((response) => response.text()); // the browser going back to the loopback address
  };
}

async function main(): Promise<void> {
  if (!ADMIN_SECRET) throw new Error("Set CORE_ADMIN_SECRET to the local core's ADMIN_SECRET.");
  const meta = await http("GET", "/v1/meta").catch(() => null);
  if (!meta || meta.status !== 200) throw new Error(`No core at ${CORE} (GET /v1/meta answered ${meta?.status ?? "nothing"}). Start it: cd ../core && npm run dev`);
  say(`core at ${CORE}, contract ${meta.body.contract_version}`);

  // 1. a user
  const email = `e2e-${Date.now()}@example.com`;
  expectStatus("admin: invite", await http("POST", INVITES, { bearer: ADMIN_SECRET, json: { email } }), 200, 201);
  const minted = await http("POST", LOGIN_CODES, { bearer: ADMIN_SECRET, json: { email } });
  expectStatus("admin: sign-in code", minted, 200, 201);
  const timezone = eveningZone();
  const session = await http("POST", "/v1/auth/sessions", { json: { email, code: minted.body.code, device_name: "agents e2e", client: "web", timezone } });
  expectStatus("POST /v1/auth/sessions", session, 201);
  const user: string = session.body.credential;
  say(`signed in as ${email} (${timezone})`);

  // 2. a few made-up items
  const saved: string[] = [];
  const samples = [
    { kind: "text", title: "周末想法", text: "把阳台改成一个小书房：一张窄桌、一盏灯、一个书架。先量尺寸，再看预算。这是编出来的内容。" },
    { kind: "text", text: "读书笔记（编的）：一个系统先把接口写成契约，各个模块再照着做，返工会少很多。作者举了三个例子，第三个最有说服力。" },
    { kind: "link", url: `https://example.com/contract-first-${Date.now()}`, title: "为什么小团队应该先写契约", text: "这是一篇编出来的文章。它讲的是：先把接口写成一份契约，各个模块再照着做。".repeat(8) },
  ];
  for (const [index, sample] of samples.entries()) {
    const reply = await http("POST", "/v1/items", { bearer: user, json: sample, key: `e2e-${Date.now()}-${index}` });
    expectStatus("POST /v1/items", reply, 201);
    saved.push(reply.body.item_id);
  }
  say(`saved ${saved.length} items`);

  // 3. connect the scheduled agent
  const env = { KEEPESSENCE_MCP_URL: `${CORE}/mcp`, KEEPESSENCE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "keepessence-e2e-")), KEEPESSENCE_AGENT_NAME: "E2E agent" };
  const config = loadConfig(env);
  const steps = ["analysis", "digest", "deep_read"];
  const { scope } = await connect(config, { show: allowAs(user, { name: "E2E agent", kind: "scheduled", steps }), say: () => undefined, timeoutMs: 30_000 });
  say(`agent connected, allowed: ${scope ?? "(the core did not say)"}`);

  // 4. give it the three roles
  const listed = await http("GET", "/v1/assistants", { bearer: user });
  expectStatus("GET /v1/assistants", listed, 200);
  const assistants: { id: string; name: string; kind: string; steps: string[]; runs_at?: string }[] = listed.body.assistants ?? listed.body;
  const mine = assistants.find((a) => a.name === "E2E agent");
  if (!mine) throw new Error(`the agent is not in the assistant list: ${JSON.stringify(listed.body).slice(0, 300)}`);
  if (mine.kind !== "scheduled") differs(`the assistant's kind is ${mine.kind}, allowed as scheduled`);
  let roles = await http("PATCH", "/v1/settings", { bearer: user, json: { roles: { analysis: mine.id, digest: mine.id, deep_read: mine.id } } });
  if (roles.status >= 400) {
    roles = await http("PATCH", "/v1/settings", { bearer: user, json: { roles: { analysis: mine.name, digest: mine.name, deep_read: mine.name } } });
    if (roles.status < 400) say("  note: settings.roles takes the assistant's name, not its id (the contract does not say which)");
  }
  expectStatus("PATCH /v1/settings roles", roles, 200);

  // 5. run until everything arrived
  const agent = () => new Agent(config, { model: stubModel(), log: (line) => say(`  agent: ${line}`) });
  const today = async () => ((await http("GET", "/v1/items?state=today&limit=100", { bearer: user })).body.items ?? []) as { id: string; stage: string; analysis: any }[];
  const until = async (what: string, done: () => Promise<boolean>): Promise<boolean> => {
    const giveUp = Date.now() + TIMEOUT_MS;
    for (;;) {
      await agent().runOnce();
      if (await done()) return say(`PASS  ${what}`), true;
      if (Date.now() > giveUp) return fails(`${what}: not within ${TIMEOUT_MS / 1000}s`), false;
      await sleep(5000);
    }
  };

  const analysed = await until("analyses arrived for every saved item", async () => {
    const items = await today();
    return saved.every((id) => items.find((item) => item.id === id)?.analysis);
  });
  if (analysed) {
    for (const item of (await today()).filter((i) => saved.includes(i.id))) {
      const a = item.analysis;
      if (a.assistant?.name !== "E2E agent") differs(`analysis of ${item.id} is signed ${JSON.stringify(a.assistant)}`);
      if (!a.unavailable && (Array.from(a.summary ?? "").length > 60 || !a.key_fact || !a.verdict)) differs(`analysis of ${item.id} is not in form: ${JSON.stringify(a)}`);
    }
    const queued = await http("PUT", `/v1/deep-read-queue/${saved[2]}`, { bearer: user });
    expectStatus("PUT /v1/deep-read-queue/{item_id}", queued, 200);
    await until("a deep read arrived", async () => {
      const entries = (await http("GET", "/v1/deep-read-queue", { bearer: user })).body.entries ?? [];
      const entry = entries.find((e: { item_id: string }) => e.item_id === saved[2]);
      return entry?.deep_read === "ready" && Boolean(entry.report?.read);
    });
    await until("a daily digest arrived", async () => {
      const digest = await http("GET", "/v1/digests/latest", { bearer: user });
      return digest.status === 200 && Boolean(digest.body.summary) && digest.body.assistant?.name === "E2E agent";
    });
  }
  const quietRun = await agent().runOnce();
  if (quietRun.waiting.length) differs(`after everything was handed back the core still offers ${JSON.stringify(quietRun.waiting)}`);

  // 6. the chat assistant
  const chat = chatConfig({ ...env, KEEPESSENCE_AGENT_NAME: "E2E chat" });
  const check = await runCheck(chat, {
    connectOptions: { show: allowAs(user, { name: "E2E chat", kind: "chat", steps: ["deep_dive"] }), say: () => undefined, timeoutMs: 30_000 },
    log: (line) => say(`  chat: ${line}`),
  });
  if (check.failed.length) fails(`chat-assistant check: ${check.failed.join("; ")}`);
  else say(`PASS  chat-assistant check (${check.passed.length} steps)`);
  const notes = await http("GET", "/v1/notes", { bearer: user });
  if (notes.status === 200 && !(notes.body.notes ?? []).length && !check.failed.length) differs("the saved note is not in GET /v1/notes");
}

main()
  .catch((error: unknown) => fails(error instanceof Error ? error.message : String(error)))
  .finally(() => {
    say("");
    say(differences.length ? `Differences from the contract:\n${differences.map((d) => `  - ${d}`).join("\n")}` : "No differences from the contract found.");
    say(failures.length ? `${failures.length} failed.` : "All passed.");
    process.exit(failures.length ? 1 : 0);
  });
