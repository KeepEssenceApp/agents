// The credential file: what the one-time approval left behind. Mode 0600.
// Two copies of the agent may run at once, so every change happens under a lock file
// and the file is replaced in one step.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface Stored {
  /** The connect address these belong to. */
  server?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When `tokens` were issued, in milliseconds. */
  obtained_at?: number;
  discovery?: OAuthDiscoveryState;
}

export interface CredentialStore {
  read(): Stored;
  /** Read, change and write back as one step that no other copy can interleave with. */
  update<T>(change: (stored: Stored) => Promise<{ stored?: Stored; value: T }>): Promise<T>;
}

export class MemoryStore implements CredentialStore {
  constructor(private stored: Stored = {}) {}
  read(): Stored {
    return this.stored;
  }
  async update<T>(change: (stored: Stored) => Promise<{ stored?: Stored; value: T }>): Promise<T> {
    const { stored, value } = await change(this.stored);
    if (stored) this.stored = stored;
    return value;
  }
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 45_000;

export class FileStore implements CredentialStore {
  constructor(readonly path: string) {}

  read(): Stored {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  write(stored: Stored): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600); // the mode option is cut down by the umask; this is not
    renameSync(temporary, this.path);
  }

  async update<T>(change: (stored: Stored) => Promise<{ stored?: Stored; value: T }>): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const giveUpAt = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          // A copy that died while holding the lock must not block the others for ever.
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
        } catch {
          // the holder just let go
        }
        if (Date.now() > giveUpAt) throw new Error(`Could not lock ${this.path}. Remove ${lock} if no agent is running.`);
        await sleep(40 + Math.random() * 80);
      }
    }
    try {
      const { stored, value } = await change(this.read());
      if (stored) this.write(stored);
      return value;
    } finally {
      rmSync(lock, { force: true });
    }
  }
}
