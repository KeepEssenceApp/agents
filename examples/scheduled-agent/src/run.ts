// One visit to the core: ask, claim, work, hand back.
//
// It has to be right however often it comes and however many copies come at once. What makes it so:
// - nothing is remembered between runs; every run starts from what the core says is waiting;
// - a piece of work is only touched after claiming it, and the core gives a piece to one claim at a time;
// - a claim that runs long is renewed, and what will not be finished is released at once
//   instead of sitting out its 30 minutes;
// - handing back the same result twice is harmless: the idempotency key is derived from the claim.
import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import { LIMITS, type Claim, type Result, type Rules, type SubmitOutcome, type Usage, type WorkCount, type WorkKind } from "./contract.ts";
import { Core, ToolError } from "./core.ts";
import { modelFromEnv, type Model } from "./model.ts";
import { NotConnectedError, storedProvider } from "./oauth.ts";
import { oneLine } from "./results.ts";
import { analyse, deepRead, digest, NothingToDo, type Desk } from "./work.ts";

type Handler = (desk: Desk, rules: Rules, ref: string) => Promise<Result>;

/** The kinds this agent does, in the order it does them. Triage belongs to the built-in dispatch assistant. */
const HANDLERS: [WorkKind, Handler][] = [
  ["analysis", analyse],
  ["digest", digest],
  ["deep_read", deepRead],
];

/** A claim holds at most 10 pieces; a run keeps claiming until the kind is empty, up to this many claims. */
const MAX_CLAIMS_PER_KIND = 20;

export interface RunReport {
  /** What the core said was waiting. Empty means the run ended there. */
  waiting: WorkCount[];
  accepted: number;
  /** Handed back and not taken (someone else got there first, or the piece is gone). */
  notAccepted: number;
  /** Not handed back: the model or a tool failed. Released for a later run. */
  failed: number;
}

export interface AgentOptions {
  model?: Model;
  log?: (line: string) => void;
}

export class Agent {
  private readonly core: Core;
  private readonly held = new Set<string>();
  private stopping = false;
  private readonly log: (line: string) => void;

  constructor(
    private readonly config: Config,
    private readonly options: AgentOptions = {},
  ) {
    this.core = new Core(config, storedProvider(config));
    this.log = options.log ?? ((line) => console.log(line));
  }

  async runOnce(): Promise<RunReport> {
    const report: RunReport = { waiting: [], accepted: 0, notAccepted: 0, failed: 0 };
    // Step 1 is a plain HTTP request. No work: stop here, without a session and without a model.
    report.waiting = (await this.core.getWork()).filter((w) => w.count > 0 && HANDLERS.some(([kind]) => kind === w.kind));
    if (!report.waiting.length) return report;

    const model = this.options.model ?? modelFromEnv();
    await this.core.open();
    try {
      for (const [kind, handler] of HANDLERS) {
        if (this.stopping || !report.waiting.some((w) => w.kind === kind)) continue;
        await this.drain(kind, handler, model, report);
      }
    } finally {
      await this.releaseHeld();
      await this.core.close();
    }
    this.log(`handed back ${report.accepted}, not accepted ${report.notAccepted}, left for later ${report.failed}`);
    return report;
  }

  /** Stop after the piece in hand and put back whatever is still claimed. For SIGINT and SIGTERM. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.releaseHeld();
  }

  private async drain(kind: WorkKind, handler: Handler, model: Model, report: RunReport): Promise<void> {
    let rules: Rules | undefined;
    for (let round = 0; round < MAX_CLAIMS_PER_KIND && !this.stopping; round++) {
      let claim: Claim;
      try {
        claim = await this.core.call<Claim>("claim_work", { kind, limit: LIMITS.claimMaxItems });
      } catch (error) {
        if (error instanceof ToolError && error.code === "forbidden") return; // the user did not allow this step
        throw error;
      }
      if (!claim.claim_id || !claim.work.length) return; // another copy took it, or it is all done
      this.held.add(claim.claim_id);
      rules ??= await this.core.call<Rules>("get_rules", { kind });
      const clean = await this.work(claim, handler, rules, model, report);
      // A piece that failed goes back and would be claimed again at once. Leave the kind for the next run.
      if (!clean) return;
    }
  }

  /** Do one claim. Returns false when something was left undone. */
  private async work(claim: Claim, handler: Handler, rules: Rules, model: Model, report: RunReport): Promise<boolean> {
    const claimId = claim.claim_id!;
    const usage: Usage = { model: oneLine(model.name, LIMITS.usageModel), input_tokens: 0, output_tokens: 0, calls: 0 };
    const desk: Desk = { config: this.config, core: this.core, model, usage };
    const keeper = new ClaimKeeper(this.core, claim, this.config.renewMarginMs, this.log);
    const results: Result[] = [];
    let undone = 0;
    try {
      for (const piece of claim.work) {
        if (this.stopping || keeper.lost) {
          undone += 1;
          continue;
        }
        try {
          results.push(await handler(desk, rules, piece.ref));
        } catch (error) {
          if (error instanceof NotConnectedError) throw error;
          undone += 1;
          if (!(error instanceof NothingToDo)) report.failed += 1;
          this.log(`${claim.kind} ${piece.ref}: left for later: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      keeper.stop();
    }

    if (results.length) {
      const outcomes = await this.submit(claimId, results, usage);
      for (const outcome of outcomes) {
        if (outcome.accepted) report.accepted += 1;
        else {
          report.notAccepted += 1;
          this.log(`${claim.kind} ${outcome.ref}: not accepted: ${outcome.reason ?? "no reason given"}`);
        }
      }
    }
    // Whatever was not handed back goes back now, so another run or another copy can take it.
    if (undone) await this.release(claimId);
    this.held.delete(claimId);
    return undone === 0;
  }

  private async submit(claimId: string, results: Result[], usage: Usage): Promise<SubmitOutcome["outcomes"]> {
    const send = (batch: Result[], batchUsage?: Usage) => {
      const refs = batch.map((r) => (r.kind === "digest" ? r.day : r.item_id)).join(",");
      // The same claim and the same pieces always give the same key: a retry cannot make a second copy.
      const idempotency_key = createHash("sha256").update(`${claimId}:${refs}`).digest("hex").slice(0, 48);
      return this.core.call<SubmitOutcome>("submit_result", { id: claimId, results: batch, usage: batchUsage, idempotency_key });
    };
    try {
      return (await send(results, usage)).outcomes;
    } catch (error) {
      if (!(error instanceof ToolError && error.code === "invalid_result") || results.length === 1) throw error;
      // One result the core will not take must not sink the other nine: hand them back one at a time.
      this.log(`the core refused the batch (${error.message}); handing back one at a time`);
      const outcomes: SubmitOutcome["outcomes"] = [];
      for (const [index, result] of results.entries()) {
        const ref = result.kind === "digest" ? result.day : result.item_id;
        try {
          outcomes.push(...(await send([result], index === 0 ? usage : undefined)).outcomes);
        } catch (single) {
          outcomes.push({ ref, accepted: false, reason: single instanceof Error ? single.message : String(single) });
        }
      }
      return outcomes;
    }
  }

  private async release(claimId: string): Promise<void> {
    await this.core.call("release_claim", { id: claimId }).catch((error: unknown) => {
      this.log(`could not release ${claimId}; it frees itself when the claim runs out: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async releaseHeld(): Promise<void> {
    const held = [...this.held];
    this.held.clear();
    await Promise.all(held.map((claimId) => this.release(claimId)));
  }
}

/** Keeps a claim alive while its work is in progress: renews it shortly before it would run out. */
class ClaimKeeper {
  lost = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly core: Core,
    private readonly claim: Claim,
    private readonly marginMs: number,
    private readonly log: (line: string) => void,
  ) {
    this.arm(claim.expires_at);
  }

  private arm(expiresAt: string | null): void {
    if (!expiresAt || this.stopped) return;
    const left = Date.parse(expiresAt) - Date.now();
    // Renew when `margin` is left; for a short claim, when half of it is left.
    const wait = Math.max(0, left - Math.min(this.marginMs, left / 2));
    this.timer = setTimeout(() => void this.renew(), wait);
    this.timer.unref();
  }

  private async renew(): Promise<void> {
    try {
      const renewed = await this.core.call<Claim>("renew_claim", { id: this.claim.claim_id });
      this.arm(renewed.expires_at);
    } catch (error) {
      if (this.stopped) return;
      // Too late: the work may already be with someone else. Stop starting new pieces; what is
      // finished is still handed back, and the core takes it unless another claim got there first.
      this.lost = true;
      this.log(`${this.claim.kind} claim ${this.claim.claim_id} could not be renewed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
