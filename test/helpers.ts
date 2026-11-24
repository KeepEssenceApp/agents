import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeCore, type FakeCore } from "../dev/fake-core.mjs";
import { loadConfig, type Config } from "../examples/scheduled-agent/src/config.ts";
import { connect } from "../examples/scheduled-agent/src/oauth.ts";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CLI = join(ROOT, "examples/scheduled-agent/src/cli.ts");

export interface Bench {
  fake: FakeCore;
  env: Record<string, string>;
  config: Config;
}

/** A fake core on a free port and a fresh config directory. */
export async function bench(options?: Parameters<typeof createFakeCore>[0], extraEnv: Record<string, string> = {}): Promise<Bench> {
  const fake = createFakeCore(options);
  const origin = await fake.start(0);
  const env = {
    KEEPESSENCE_MCP_URL: `${origin}/mcp`,
    KEEPESSENCE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "keepessence-agent-test-")),
    KEEPESSENCE_NO_BROWSER: "1",
    MODEL: "stub",
    ...extraEnv,
  };
  return { fake, env, config: loadConfig(env) };
}

/** Plays the user's browser: opens the allow-page address and follows it back to the loopback redirect. */
export const pressAllow = async (url: URL): Promise<void> => {
  // not awaited by the caller's flow: the loopback server answers once the code arrives
  void fetch(url).then((response) => response.text());
};

export async function connected(options?: Parameters<typeof createFakeCore>[0], extraEnv: Record<string, string> = {}): Promise<Bench> {
  const b = await bench(options, extraEnv);
  await connect(b.config, { show: pressAllow, say: () => undefined });
  return b;
}

/** Runs the agent's command line as its own process, the way cron would. */
export function runCli(env: Record<string, string>, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export const length = (text: string): number => Array.from(text).length;
