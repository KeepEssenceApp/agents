#!/usr/bin/env -S npx tsx
// keepessence-agent connect | run-once | run --every <minutes>
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.ts";
import { connect, NotConnectedError } from "./oauth.ts";
import { Agent } from "./run.ts";

const USAGE = `Usage:
  connect                 one-time: open the allow page, press Allow, keep the credential
  run-once                ask for work; if there is any, do it and hand it back
  run --every <minutes>   the same, again and again

Environment:
  KEEPESSENCE_MCP_URL     the connect address (default https://keepessence.app/mcp)
  MODEL                   anthropic (default) | openai | stub
  MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME
See the README for the rest.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const config = loadConfig();

  if (command === "connect") {
    // Rule D10: say where the content goes before the user allows it.
    console.log("接入之后，你存入的内容会被送到这只助手运行的地方：这台机器，以及它调用的模型服务。");
    console.log("Once connected, what you save is sent to where this assistant runs: this machine and the model service it calls.");
    console.log(`Connect address / 接入地址: ${config.serverUrl}`);
    const { scope } = await connect(config);
    console.log(`Connected${scope ? `, allowed steps: ${scope}` : ""}. Credential: ${config.credentialFile}`);
    return 0;
  }

  if (command === "run-once" || command === "run") {
    const every = command === "run" ? Number(rest[rest.indexOf("--every") + 1]) : 0;
    if (command === "run" && !(rest.includes("--every") && every > 0)) {
      console.error(USAGE);
      return 64;
    }
    const agent = new Agent(config);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => void agent.stop().finally(() => process.exit(130)));
    }
    for (;;) {
      try {
        await agent.runOnce(); // says nothing when there is no work
      } catch (error) {
        if (error instanceof NotConnectedError || !every) throw error;
        // A failed visit is not the end: the next one starts from what the core says is waiting.
        console.error(`${new Date().toISOString()} this run failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!every) return 0;
      await sleep(every * 60_000);
    }
  }

  console.error(USAGE);
  return command === "help" || command === "--help" ? 0 : 64;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof NotConnectedError ? 2 : 1);
  },
);
