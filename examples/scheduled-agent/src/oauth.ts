// Standard OAuth for the assistant endpoint, done with the MCP SDK:
// protected-resource metadata -> authorization server metadata -> dynamic registration ->
// authorization code with PKCE over a loopback redirect -> a rotating refresh credential in a file.
// After the one approval nobody has to touch it again (rule D9). There is no fixed credential.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  type OAuthClientProvider,
  type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config } from "./config.ts";
import { FileStore, MemoryStore, type CredentialStore, type Stored } from "./credentials.ts";

/** The stored approval no longer works (revoked, or never given). Only `connect` fixes it. */
export class NotConnectedError extends Error {
  constructor(reason: string) {
    super(`${reason} Run "connect" and allow the agent again.`);
    this.name = "NotConnectedError";
  }
}

/** Refresh this long before the access credential runs out. */
const REFRESH_EARLY_MS = 120_000;
const fetchWithTimeout: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });

export class AgentOAuthProvider implements OAuthClientProvider {
  private verifier = "";
  private serverInfo?: OAuthServerInfo;

  constructor(
    private readonly config: Config,
    private readonly store: CredentialStore,
    /** Set only while connecting: the loopback address and what to do with the allow-page address. */
    private readonly interactive?: { redirectUrl: string; state: string; show: (url: URL) => void | Promise<void> },
  ) {}

  get redirectUrl(): string {
    // Outside `connect` nothing listens here; it only keeps the SDK on the authorization-code path.
    return this.interactive?.redirectUrl ?? "http://127.0.0.1/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // a public client: there is no secret to keep
      scope: this.config.steps.join(" "),
    };
  }

  state(): string {
    return this.interactive?.state ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.read().client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.store.update(async (stored) => ({ stored: { ...stored, client }, value: undefined }));
  }

  /** The current credentials, refreshed first when the access credential is about to run out. */
  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = this.store.read();
    if (!stored.tokens || !expiresSoon(stored)) return stored.tokens;
    return this.refresh();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.update(async (stored) => ({
      stored: { ...stored, server: this.config.serverUrl, tokens, obtained_at: Date.now() },
      value: undefined,
    }));
  }

  /**
   * Trade the refresh credential for a new pair. The refresh credential rotates: each one works
   * once. So this runs under the file lock and looks again once it has the lock; when another
   * copy of the agent got there first, its result is used and nothing is sent.
   * `rejected` is an access credential the core just refused, to force a refresh before it is due.
   */
  async refresh(rejected?: string): Promise<OAuthTokens | undefined> {
    return this.store.update(async (stored) => {
      const current = stored.tokens;
      if (!current) return { value: undefined };
      const stillNeeded = rejected ? current.access_token === rejected : expiresSoon(stored);
      if (!stillNeeded) return { value: current };
      if (!current.refresh_token || !stored.client) throw new NotConnectedError("There is no refresh credential.");
      const server = await this.discover();
      let fresh: OAuthTokens;
      try {
        fresh = await refreshAuthorization(server.authorizationServerUrl, {
          metadata: server.authorizationServerMetadata,
          clientInformation: stored.client,
          refreshToken: current.refresh_token,
          resource: server.resourceMetadata?.resource,
          fetchFn: fetchWithTimeout,
        });
      } catch (error) {
        // The authorization server said no: revoked in the product, or the credential was lost.
        // Anything else (network, a 5xx) is passed on and the next run tries again.
        if (error instanceof OAuthError && error.errorCode !== "server_error" && error.errorCode !== "temporarily_unavailable") {
          throw new NotConnectedError(`The core refused the refresh credential (${error.errorCode}).`);
        }
        throw error;
      }
      const tokens = { ...current, ...fresh }; // keeps what the SDK stamped on the first pair
      return { stored: { ...stored, tokens, obtained_at: Date.now() }, value: tokens };
    });
  }

  private async discover(): Promise<OAuthServerInfo> {
    this.serverInfo ??= await discoverOAuthServerInfo(this.config.serverUrl, { fetchFn: fetchWithTimeout });
    return this.serverInfo;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) throw new NotConnectedError("The core asks for a new approval.");
    await this.interactive.show(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

function expiresSoon(stored: Stored): boolean {
  const lifetime = stored.tokens?.expires_in;
  if (!lifetime || !stored.obtained_at) return false; // unknown: use it until the core refuses it
  return Date.now() >= stored.obtained_at + lifetime * 1000 - Math.min(REFRESH_EARLY_MS, lifetime * 500);
}

/** The provider for unattended runs: it reads and rotates the stored credential and never asks anyone. */
export function storedProvider(config: Config): AgentOAuthProvider {
  return new AgentOAuthProvider(config, new FileStore(config.credentialFile));
}

export interface ConnectOptions {
  /** Called with the allow-page address. Default: print it and try to open the browser. */
  show?: (url: URL) => void | Promise<void>;
  say?: (line: string) => void;
  timeoutMs?: number;
}

/** The one-time approval. Resolves with the steps the user allowed, as far as the core says. */
export async function connect(config: Config, options: ConnectOptions = {}): Promise<{ scope?: string }> {
  const say = options.say ?? ((line: string) => console.log(line));
  const state = randomBytes(16).toString("hex");

  // 1. Listen on a loopback port for the browser coming back with the code.
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const failure = url.searchParams.get("error");
    const ok = !failure && url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(
      ok
        ? "<p>已接入。可以关掉这个页面了。</p><p>Connected. You can close this page.</p>"
        : "<p>没有接入。回到终端看原因。</p><p>Not connected. See the terminal.</p>",
    );
    if (ok) settle.resolve(ok);
    else settle.reject(new Error(failure ? `The approval was refused: ${failure}` : "The browser came back without a valid code."));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const redirectUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  try {
    // 2. Everything is staged in memory and written to the file only once it all worked,
    //    so a failed attempt never damages a working credential.
    const staging = new MemoryStore();
    const show =
      options.show ??
      ((url: URL) => {
        say("Open this address and press Allow / 打开这个地址，点「允许」:");
        say(`  ${url.href}`);
        openBrowser(url.href);
      });
    const provider = new AgentOAuthProvider(config, staging, { redirectUrl, state, show });
    const scope = config.steps.join(" ");

    // 3. Discover, register, and send the user to the allow page.
    const first = await auth(provider, { serverUrl: config.serverUrl, scope });
    if (first !== "AUTHORIZED") {
      const timeout = options.timeoutMs ?? 10 * 60_000;
      const timer = setTimeout(() => settle.reject(new Error("Nobody pressed Allow in time.")), timeout);
      try {
        // 4. Exchange the code (with the PKCE verifier) for the credentials.
        await auth(provider, { serverUrl: config.serverUrl, scope, authorizationCode: await code });
      } finally {
        clearTimeout(timer);
      }
    }

    // 5. Keep the new credential; let go of the one it replaces.
    const file = new FileStore(config.credentialFile);
    const previous = await file.update(async (stored) => ({ stored: staging.read(), value: stored }));
    await revoke(config, previous).catch(() => undefined);
    return { scope: staging.read().tokens?.scope };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** Tell the core that a replaced refresh credential is no longer wanted (RFC 7009). */
async function revoke(config: Config, previous: Stored): Promise<void> {
  const token = previous.tokens?.refresh_token;
  if (!token || !previous.client) return;
  const { authorizationServerMetadata } = await discoverOAuthServerInfo(config.serverUrl, { fetchFn: fetchWithTimeout });
  const endpoint = (authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  if (!endpoint) return;
  await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: previous.client.client_id }),
  });
}

function openBrowser(url: string): void {
  if (process.env.KEEPESSENCE_NO_BROWSER) return;
  const [command, ...args] =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    spawn(command!, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // no browser here (a server): the address was printed, open it anywhere that can reach this machine
  }
}
