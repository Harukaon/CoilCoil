/**
 * One MCP server, and everything CoilCoil needs to know about it.
 *
 * The protocol itself comes from the official SDK; what lives here is the part
 * CoilCoil kept getting wrong through pi-mcp-adapter — an honest answer to
 * "does this server work right now", produced without a Pi session anywhere in
 * the picture. That is the whole point of owning this layer: a connection is a
 * property of the runtime, not of whichever conversation happens to be open, so
 * the settings panel can ask at any time.
 *
 * A connection never throws at its caller for the ordinary failures. Wrong
 * address, refused credentials, a command that is not installed — those are
 * answers, not exceptions, and they land in `status` and `failure` where the
 * panel can show them verbatim. The server's own words are kept rather than
 * summarised: "Invalid API key" is worth ten of "failed to connect".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { launchFor, type EnvironmentSource } from "./definition.js";
import type { McpCredentialStore } from "./credential-store.js";
import { McpOAuthProvider } from "./oauth-provider.js";

/**
 * Deliberately the same words the runtime protocol already speaks, so nothing
 * has to translate between this layer and the panel.
 */
export type McpConnectionStatus =
  | "not connected"
  | "connecting"
  | "connected"
  | "needs-auth"
  | "failed";

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResourceSummary {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface McpConnectionOptions {
  definition: McpServerConfiguration;
  store: McpCredentialStore;
  /**
   * Where an authorization server sends the browser back to.
   *
   * Accepts a getter so the loopback listener is only started when a login
   * actually needs it: a workspace of stdio servers should never open a port.
   */
  redirectUrl: string | (() => string);
  openAuthorization: (url: URL) => void | Promise<void>;
  environment?: EnvironmentSource;
  clientName?: string;
  clientVersion?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Enough of a failing server's stderr to name the problem, not enough to fill the panel. */
const STDERR_TAIL_LIMIT = 600;

/**
 * Everything an error actually says, including what it is wrapping.
 *
 * `fetch failed` is undici's message for every network problem there is; the
 * reason — refused, DNS, certificate, proxy — is only ever in `cause`. Reporting
 * the top-level message alone put a sentence in front of the user that could not
 * be acted on, and left the same sentence in the log for us.
 */
function errorText(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const own = error.message || error.name;
  const code = (error as { code?: string }).code;
  const line = code && !own.includes(code) ? `${own} (${code})` : own;
  const cause = depth < 4 ? (error as { cause?: unknown }).cause : undefined;
  if (!cause) return line;
  const nested = errorText(cause, depth + 1);
  return nested && !line.includes(nested) ? `${line}：${nested}` : line;
}

export class McpConnection {
  private client?: Client;
  private transport?: Transport;
  private state: McpConnectionStatus = "not connected";
  private lastFailure?: string;
  private discoveredTools: McpToolSummary[] = [];
  private discoveredResources: McpResourceSummary[] = [];
  private oauth?: McpOAuthProvider;
  /** The last thing a stdio server wrote to stderr, for the failure message. */
  private stderrTail = "";
  /** One connect at a time; a second press must join the first, not race it. */
  private inFlight?: Promise<McpConnectionStatus>;

  constructor(private readonly options: McpConnectionOptions) {}

  get name(): string {
    return this.options.definition.name;
  }

  get status(): McpConnectionStatus {
    return this.state;
  }

  get failure(): string | undefined {
    return this.lastFailure;
  }

  get tools(): McpToolSummary[] {
    return this.discoveredTools;
  }

  get resources(): McpResourceSummary[] {
    return this.discoveredResources;
  }

  /** The page the browser was sent to, so 认证 can be retried or reopened. */
  get authorizationUrl(): URL | undefined {
    return this.oauth?.authorizationUrl;
  }

  private buildTransport(): Transport {
    const environment = this.options.environment ?? process.env;
    const launch = launchFor(this.options.definition, environment);
    if (launch.kind === "stdio") {
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: launch.env,
        cwd: launch.cwd,
        // Piped rather than inherited so a server that refuses to start can be
        // quoted back to the user. "Cannot find module 'x'" is the answer; a
        // bare "the connection failed" is what sent people to the logs.
        // `debug` additionally mirrors it to the runtime log, live.
        stderr: "pipe",
      });
      this.stderrTail = "";
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        if (this.options.definition.debug) process.stderr.write(text);
        // Only the tail is kept: a chatty server must not be able to grow this
        // without bound, and the last thing it said is the useful part.
        this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_TAIL_LIMIT);
      });
      return transport;
    }
    const redirectUrl = this.options.redirectUrl;
    this.oauth = launch.oauth
      ? new McpOAuthProvider({
        serverUrl: launch.url,
        store: this.options.store,
        redirectUrl: typeof redirectUrl === "function" ? redirectUrl() : redirectUrl,
        openAuthorization: this.options.openAuthorization,
        clientName: this.options.clientName,
      })
      : undefined;
    return new StreamableHTTPClientTransport(new URL(launch.url), {
      authProvider: this.oauth,
      requestInit: { headers: launch.headers },
    });
  }

  /**
   * Connect, discover what the server offers, and report where that got to.
   *
   * `needs-auth` is separated from `failed` on purpose: it is the one outcome
   * the user can act on, and the panel turns it straight into the authorization
   * dialog instead of showing an error they cannot do anything about.
   */
  async connect(): Promise<McpConnectionStatus> {
    if (this.inFlight) return this.inFlight;
    if (this.state === "connected") return this.state;
    this.inFlight = this.runConnect().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async runConnect(): Promise<McpConnectionStatus> {
    this.state = "connecting";
    this.lastFailure = undefined;
    try {
      const client = new Client(
        { name: this.options.clientName ?? "CoilCoil", version: this.options.clientVersion ?? "0.1.0" },
        { capabilities: {} },
      );
      const transport = this.buildTransport();
      await this.withTimeout(
        client.connect(transport),
        `连接 ${this.name} 超时（${Math.round(this.timeoutMs / 1000)} 秒）。`,
      );
      this.client = client;
      this.transport = transport;
      await this.discover(client);
      this.state = "connected";
      return this.state;
    } catch (error) {
      await this.dispose();
      if (error instanceof UnauthorizedError) {
        this.state = "needs-auth";
        this.lastFailure = undefined;
        return this.state;
      }
      this.state = "failed";
      this.lastFailure = this.failureText(error);
      return this.state;
    }
  }

  private get timeoutMs(): number {
    return this.options.definition.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Put a ceiling on the handshake.
   *
   * The SDK times out its own requests but not `connect`, so a server that
   * accepts a socket and then says nothing hangs forever — and because the
   * Agent lists servers in parallel, one such server used to take every other
   * server's answer down with it.
   */
  private async withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), this.timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * What to tell the user when a connection did not happen.
   *
   * A stdio server that dies on startup usually says why on stderr and then the
   * transport reports something generic like "closed"; joining the two is the
   * difference between an actionable message and a shrug.
   */
  private failureText(error: unknown): string {
    const reason = errorText(error);
    const stderr = this.stderrTail.trim();
    if (!stderr) return reason;
    return reason.includes(stderr) ? reason : `${reason}\n${stderr}`;
  }

  /**
   * Ask what is on offer.
   *
   * Resources are optional in the protocol and plenty of servers answer with a
   * "method not found" error rather than an empty list, so a refusal there is
   * not allowed to fail the whole connection — the tools are what matter.
   */
  private async discover(client: Client): Promise<void> {
    const timeout = this.timeoutMs;
    const tools = await client.listTools(undefined, { timeout });
    const excluded = new Set(this.options.definition.excludeTools);
    this.discoveredTools = tools.tools
      .filter((tool) => !excluded.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    if (!this.options.definition.exposeResources) {
      this.discoveredResources = [];
      return;
    }
    try {
      const resources = await client.listResources(undefined, { timeout });
      this.discoveredResources = resources.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        mimeType: resource.mimeType,
      }));
    } catch {
      this.discoveredResources = [];
    }
  }

  /** Redeem an authorization code the browser handed back, then reconnect. */
  async finishAuth(code: string): Promise<McpConnectionStatus> {
    const transport = this.transport;
    if (transport instanceof StreamableHTTPClientTransport) {
      await transport.finishAuth(code);
    } else {
      // The failed attempt tore its transport down, so build a fresh one purely
      // to carry the code exchange; the reconnect below is what actually runs.
      const rebuilt = this.buildTransport();
      if (rebuilt instanceof StreamableHTTPClientTransport) await rebuilt.finishAuth(code);
      await rebuilt.close().catch(() => undefined);
    }
    this.state = "not connected";
    return this.connect();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.state !== "connected") {
      const status = await this.connect();
      if (status !== "connected") {
        throw new Error(this.lastFailure ?? `MCP Server「${this.name}」当前${status === "needs-auth" ? "需要认证" : "连不上"}。`);
      }
    }
    const client = this.client;
    if (!client) throw new Error(`MCP Server「${this.name}」还没有连接。`);
    return client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.options.definition.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    );
  }

  private async dispose(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.dispose();
    this.state = "not connected";
    this.discoveredTools = [];
    this.discoveredResources = [];
  }
}
