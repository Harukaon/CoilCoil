/**
 * Where an MCP server's OAuth credentials live.
 *
 * pi-mcp-adapter put them in the operating system's credential store, which on
 * macOS means the login keychain. That is the more careful place to keep a
 * token, but it is also why pressing 检查状态 raised a system dialog asking for
 * permission to read `pi-mcp-adapter.oauth`: CoilCoil is signed ad-hoc, so every
 * rebuild is a different application as far as macOS is concerned and the old
 * keychain grant no longer matches. The prompt came back after every build, for
 * a token the app itself had written.
 *
 * So credentials go in a file CoilCoil owns, next to the rest of its agent
 * state, with the same protection the file system gives an SSH private key:
 * readable only by this user. It is written whole and moved into place, so a
 * crash halfway through leaves the previous file intact rather than a truncated
 * one that would log every server out at once.
 *
 * Records are keyed by the server's canonical address rather than by its name.
 * An OAuth grant belongs to the resource, not to whatever the entry happens to
 * be called here, so renaming a server keeps its login and pointing two entries
 * at one address correctly shares it.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Owner read/write only. These are bearer tokens; nobody else on the box needs them. */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const STORE_VERSION = 1;

export interface McpCredentialRecord {
  /** The address the record was filed under, kept legible for debugging. */
  url?: string;
  /** Whatever the SDK handed back from the token endpoint. */
  tokens?: Record<string, unknown>;
  /** Dynamic (or pre-registered) client information for this authorization server. */
  clientInformation?: Record<string, unknown>;
  /** PKCE verifier, alive only between opening the browser and redeeming the code. */
  codeVerifier?: string;
  /** The `state` this attempt was issued under, so a stray redirect is refused. */
  state?: string;
  /** When the record last changed, for the settings panel to show. */
  updatedAt?: number;
}

interface StoreFile {
  version: number;
  servers: Record<string, McpCredentialRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The key one address files its credentials under.
 *
 * Only the parts that identify the resource survive: scheme, host, port and
 * path. A query string or fragment is routinely where a per-user token or a
 * cache-buster is carried, and letting either into the key would strand the
 * grant the moment it changed.
 */
export function credentialKey(url: string): string {
  const trimmed = url.trim();
  let canonical = trimmed.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    canonical = `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
  } catch {
    // Not a URL — a stdio server, or something malformed. Hashing the raw text
    // still gives a stable key, which is all this has to be.
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function defaultCredentialFile(agentDir: string): string {
  return join(agentDir, "mcp-credentials.json");
}

export class McpCredentialStore {
  constructor(private readonly file: string) {}

  private read(): StoreFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!isRecord(parsed) || !isRecord(parsed.servers)) return { version: STORE_VERSION, servers: {} };
      const servers: Record<string, McpCredentialRecord> = {};
      for (const [key, value] of Object.entries(parsed.servers)) {
        if (isRecord(value)) servers[key] = value as McpCredentialRecord;
      }
      return { version: STORE_VERSION, servers };
    } catch {
      // Missing is the ordinary case on first run. Corrupt is not recoverable
      // and must not take the process down: the worst it costs is one more
      // authorization, which is exactly what an empty store asks for.
      return { version: STORE_VERSION, servers: {} };
    }
  }

  private write(store: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: DIRECTORY_MODE });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
      renameSync(temporary, this.file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  get(key: string): McpCredentialRecord | undefined {
    return this.read().servers[key];
  }

  /** Merge fields into one record. Passing `undefined` for a field removes it. */
  update(key: string, patch: McpCredentialRecord): McpCredentialRecord {
    const store = this.read();
    const next: McpCredentialRecord = { ...store.servers[key], ...patch, updatedAt: Date.now() };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete next[field as keyof McpCredentialRecord];
    }
    store.servers[key] = next;
    this.write(store);
    return next;
  }

  /**
   * Forget one server entirely — the 登出 button.
   *
   * Everything goes, not just the access token: leaving the dynamically
   * registered client behind means the next authorization silently reuses a
   * registration the user believes they threw away.
   */
  clear(key: string): void {
    const store = this.read();
    if (!(key in store.servers)) return;
    delete store.servers[key];
    this.write(store);
  }

  /** Which servers currently hold a usable token, for the panel to report. */
  authenticatedKeys(): string[] {
    return Object.entries(this.read().servers)
      .filter(([, record]) => isRecord(record.tokens) && typeof record.tokens.access_token === "string")
      .map(([key]) => key);
  }
}
