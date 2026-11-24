import { homedir } from "node:os";
import { join } from "node:path";
import type { Step } from "./contract.ts";

export const CONNECT_ADDRESS = "https://keepessence.app/mcp";

export interface Config {
  /** The connect address: the assistant endpoint. The same for every user; not a credential. */
  serverUrl: string;
  /** Where the refresh credential is kept, mode 0600. */
  credentialFile: string;
  /** The name shown on the allow page. The user can rename the assistant there. */
  clientName: string;
  /** The steps asked for on the allow page. The user can untick any of them. */
  steps: Step[];
  /** Renew a claim when it has less than this left. */
  renewMarginMs: number;
  /** Optional text handed back with a deep read: how the user starts a deep dive with this agent. */
  deepDiveEntry?: string;
}

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  if (env.KEEPESSENCE_CONFIG_DIR) return env.KEEPESSENCE_CONFIG_DIR;
  const base =
    env.XDG_CONFIG_HOME ?? (process.platform === "win32" && env.APPDATA ? env.APPDATA : join(homedir(), ".config"));
  return join(base, "keepessence-agent");
}

export function loadConfig(env: Env = process.env, credentialName = "credentials"): Config {
  const serverUrl = env.KEEPESSENCE_MCP_URL ?? CONNECT_ADDRESS;
  // One file per core, so a local test core never overwrites the real one's credential.
  const host = new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const steps = (env.KEEPESSENCE_STEPS ?? "analysis digest deep_read").split(/[\s,]+/).filter(Boolean) as Step[];
  return {
    serverUrl,
    credentialFile: join(configDir(env), `${credentialName}-${host}.json`),
    clientName: env.KEEPESSENCE_AGENT_NAME ?? "Scheduled agent",
    steps,
    renewMarginMs: Number(env.KEEPESSENCE_RENEW_MARGIN_SECONDS ?? 600) * 1000,
    deepDiveEntry: env.KEEPESSENCE_DEEP_DIVE_ENTRY || undefined,
  };
}
