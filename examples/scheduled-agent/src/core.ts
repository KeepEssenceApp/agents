// Talking to the core: one plain HTTP question ("is there work?") and the tools on the assistant endpoint.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config } from "./config.ts";
import type { WorkCount } from "./contract.ts";
import { NotConnectedError, type AgentOAuthProvider } from "./oauth.ts";

/** A tool said no. `code` is one of the contract's error codes when the core gave one. */
export class ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
  ) {
    super(`${tool}: ${code}: ${message}`);
    this.name = "ToolError";
  }
}

export class Core {
  private client?: Client;

  constructor(
    private readonly config: Config,
    private readonly provider: AgentOAuthProvider,
  ) {}

  /**
   * Is there work for this assistant? A plain GET: no tool call, no model (rule D3).
   * When the answer is "nothing", this is the only request a run makes.
   */
  async getWork(): Promise<WorkCount[]> {
    const url = new URL("/v1/assistant/work", this.config.serverUrl);
    let tokens = await this.provider.tokens();
    if (!tokens) throw new NotConnectedError("This agent has not been connected yet.");
    let response = await fetch(url, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (response.status === 401) {
      // Refused before it was due to run out: get a new one and ask once more.
      tokens = await this.provider.refresh(tokens.access_token);
      if (!tokens) throw new NotConnectedError("The credential is gone.");
      response = await fetch(url, { headers: { authorization: `Bearer ${tokens.access_token}` } });
      if (response.status === 401) throw new NotConnectedError("The core does not accept this agent's credential.");
    }
    if (!response.ok) throw new Error(`GET /v1/assistant/work answered ${response.status}`);
    return ((await response.json()) as { work: WorkCount[] }).work;
  }

  /** Open the assistant endpoint (MCP over Streamable HTTP). Returns what the server says about itself. */
  async open(clientName = "keepessence-scheduled-agent"): Promise<{ instructions?: string }> {
    const client = new Client({ name: clientName, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.config.serverUrl), { authProvider: this.provider }));
    this.client = client;
    return { instructions: client.getInstructions() };
  }

  async listTools() {
    return (await this.mcp().listTools()).tools;
  }

  /** Call a tool. Its output is the same object the matching REST operation returns. */
  async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    let result;
    try {
      result = await this.mcp().callTool({ name: tool, arguments: args });
    } catch (error) {
      if (error instanceof NotConnectedError) throw error;
      throw new ToolError(tool, "protocol", error instanceof Error ? error.message : String(error));
    }
    const text = ((result.content ?? []) as { type: string; text?: string }[]).find((part) => part.type === "text")?.text;
    if (result.isError) {
      const parsed = parseJson(text) as { error?: { code?: string; message?: string } } | undefined;
      throw new ToolError(tool, parsed?.error?.code ?? "error", parsed?.error?.message ?? text ?? "the tool failed");
    }
    return (result.structuredContent ?? parseJson(text) ?? null) as T;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }

  private mcp(): Client {
    if (!this.client) throw new Error("The assistant endpoint is not open.");
    return this.client;
  }
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
