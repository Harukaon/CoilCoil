/**
 * Every MCP server CoilCoil knows about, and the one place that answers for
 * them.
 *
 * This is what makes the settings panel honest. Under pi-mcp-adapter the whole
 * MCP world lived inside a Pi session, so "is this server working" could not be
 * asked until a conversation existed — which is how a greyed-out 认证 button and
 * 请先打开项目并创建会话 ended up in front of someone who just wanted to check a
 * server. A manager belongs to the runtime instead: it is up whenever the app
 * is, and both the panel and the Agent ask the same object.
 *
 * Connections stay lazy, because that is genuinely the right default — a server
 * nobody has used should not be running. What changes is that "not connected"
 * is now a fact this layer keeps to itself rather than a word shown to the
 * user; the panel asks a question, this connects for real, and the answer is
 * whatever came back.
 */
import type {
  McpRuntimeStatus,
  McpServerConfiguration,
  McpServerRuntimeStatus,
} from "@coilcoil/runtime-protocol";
import { McpAuthCallbackServer, type McpAuthCallback } from "./auth-callback.js";
import { McpConnection, type McpConnectionStatus, type McpToolSummary } from "./connection.js";
import { credentialKey, type McpCredentialStore } from "./credential-store.js";
import { launchFor, type EnvironmentSource } from "./definition.js";

export interface McpManagerOptions {
  /** Re-read on every status call: the panel edits this file while we run. */
  loadServers: () => Promise<McpServerConfiguration[]> | McpServerConfiguration[];
  store: McpCredentialStore;
  callback?: McpAuthCallbackServer;
  /** Put the authorization page in front of the user. */
  openAuthorization: (url: URL) => void | Promise<void>;
  environment?: EnvironmentSource;
  clientVersion?: string;
}

export interface McpAuthStart {
  authorizationUrl?: string;
  /** Whether the loopback listener is holding the redirect for this attempt. */
  awaitingCallback: boolean;
  /** Already had a working token; nothing to do. */
  authenticated?: boolean;
  error?: string;
}

/** pi's listener gave five minutes; a person logging in deserves at least that. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

interface AuthFlow {
  /** Open the browser rather than only recording where it would have gone. */
  interactive: boolean;
  authorizationUrl?: URL;
  state?: string;
  waiting?: Promise<McpAuthCallback>;
}

/**
 * The `state` an authorization URL was minted with.
 *
 * It is the key the loopback listener files the redirect under, and the URL is
 * the only place this side can read it from — the SDK keeps it to itself
 * otherwise.
 */
export function authorizationState(authorizationUrl: string | URL | undefined): string | undefined {
  if (!authorizationUrl) return undefined;
  try {
    const value = new URL(String(authorizationUrl)).searchParams.get("state")?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull an authorization code out of whatever the user pasted.
 *
 * The fallback path asks people to copy their browser's address bar, and what
 * actually arrives is anything from the full redirect to the bare code. All of
 * it is accepted: refusing a paste on a technicality is how someone gets stuck
 * one step from a finished login.
 */
export function authorizationCode(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const query = trimmed.startsWith("?") ? trimmed : trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?")) : undefined;
  if (query) {
    const code = new URLSearchParams(query.slice(1)).get("code")?.trim();
    if (code) return code;
  }
  return /^[\w.~-]+$/.test(trimmed) ? trimmed : undefined;
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly definitions = new Map<string, McpServerConfiguration>();
  private readonly failedAt = new Map<string, number>();
  private readonly flows = new Map<string, AuthFlow>();
  /** Servers switched off for the current conversation only. */
  private readonly sessionDisabled = new Set<string>();
  private readonly callback: McpAuthCallbackServer;

  constructor(private readonly options: McpManagerOptions) {
    this.callback = options.callback ?? new McpAuthCallbackServer();
  }

  /**
   * Reconcile the live connections with what is on disk.
   *
   * A server whose definition changed is dropped rather than reused: the old
   * connection is still pointed at the old address with the old headers, and
   * keeping it is how an edit appears to do nothing.
   */
  private async reload(): Promise<McpServerConfiguration[]> {
    const servers = await this.options.loadServers();
    const seen = new Set<string>();
    for (const server of servers) {
      seen.add(server.name);
      const previous = this.definitions.get(server.name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(server)) {
        await this.drop(server.name);
      }
      this.definitions.set(server.name, server);
    }
    for (const name of [...this.definitions.keys()]) {
      if (seen.has(name)) continue;
      await this.drop(name);
      this.definitions.delete(name);
    }
    return servers;
  }

  private async drop(name: string): Promise<void> {
    const connection = this.connections.get(name);
    this.connections.delete(name);
    this.failedAt.delete(name);
    await connection?.close();
  }

  private connectionFor(name: string): McpConnection {
    const existing = this.connections.get(name);
    if (existing) return existing;
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`没有找到 MCP Server「${name}」。`);
    const connection = new McpConnection({
      definition,
      store: this.options.store,
      // Resolved lazily: the listener is only started when a login needs it, so
      // an app that never touches OAuth never opens a port.
      redirectUrl: () => this.callback.redirectUrl,
      openAuthorization: (url) => this.recordAuthorization(name, url),
      environment: this.options.environment,
      clientVersion: this.options.clientVersion,
    });
    this.connections.set(name, connection);
    return connection;
  }

  /**
   * The SDK reached the point of needing a browser.
   *
   * Checking a server's status must not fling a browser window at the user, so
   * the page is only opened when they asked for authorization; otherwise the
   * address is filed away and the attempt simply reports `needs-auth`.
   */
  private async recordAuthorization(name: string, url: URL): Promise<void> {
    const flow = this.flows.get(name) ?? { interactive: false };
    flow.authorizationUrl = url;
    flow.state = authorizationState(url);
    this.flows.set(name, flow);
    if (!flow.interactive) return;
    if (flow.state) flow.waiting = this.callback.expect(flow.state, AUTH_TIMEOUT_MS);
    await this.options.openAuthorization(url);
  }

  private async ensureCallbackServer(): Promise<void> {
    await this.callback.listen();
  }

  /** Whether a definition could ever need the browser flow. */
  private supportsOAuth(definition: McpServerConfiguration): boolean {
    if (definition.transport !== "http") return false;
    try {
      const launch = launchFor(definition, this.options.environment ?? process.env);
      return launch.kind === "http" && launch.oauth;
    } catch {
      return false;
    }
  }

  private statusFor(definition: McpServerConfiguration): McpServerRuntimeStatus {
    const connection = this.connections.get(definition.name);
    const live = connection?.status ?? "not connected";
    const status: McpServerRuntimeStatus["status"] = definition.disabled
      ? "disabled"
      : live === "connecting"
        ? "not connected"
        : live;
    const failedAt = this.failedAt.get(definition.name);
    return {
      name: definition.name,
      status,
      toolCount: connection?.tools.length ?? 0,
      resourceCount: connection?.resources.length ?? 0,
      failedAgo: failedAt ? Math.round((Date.now() - failedAt) / 1000) : null,
      disabled: definition.disabled,
      sessionDisabled: this.sessionDisabled.has(definition.name),
    };
  }

  async status(): Promise<McpRuntimeStatus> {
    const servers = (await this.reload()).map((definition) => this.statusFor(definition));
    const visible = servers.filter((server) => !server.disabled && !server.sessionDisabled);
    return {
      servers,
      totalTools: visible.reduce((sum, server) => sum + server.toolCount, 0),
      totalResources: visible.reduce((sum, server) => sum + server.resourceCount, 0),
      connectedCount: visible.filter((server) => server.status === "connected").length,
      disabledCount: servers.filter((server) => server.disabled).length,
      sessionDisabledCount: servers.filter((server) => server.sessionDisabled).length,
      state: "ready",
    };
  }

  /**
   * Go and find out whether one server works.
   *
   * This is what 检查状态 runs. It connects for real rather than reporting a
   * cached guess, and a disabled server is refused outright — connecting to
   * something the user switched off would be a surprising side effect of asking
   * a question.
   */
  async connect(name: string): Promise<McpServerRuntimeStatus> {
    await this.reload();
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`没有找到 MCP Server「${name}」。`);
    if (definition.disabled) return this.statusFor(definition);
    if (this.supportsOAuth(definition)) await this.ensureCallbackServer();
    const outcome = await this.connectionFor(name).connect();
    if (outcome === "failed") this.failedAt.set(name, Date.now());
    else this.failedAt.delete(name);
    return this.statusFor(definition);
  }

  /** What a failed connection said, verbatim. */
  failure(name: string): string | undefined {
    return this.connections.get(name)?.failure;
  }

  /**
   * Begin a browser authorization.
   *
   * The loopback listener is armed before the browser is opened — an approval
   * can come back faster than this function returns, and arming afterwards is
   * exactly how a redirect gets dropped.
   */
  async startAuth(name: string): Promise<McpAuthStart> {
    await this.reload();
    const definition = this.definitions.get(name);
    if (!definition) return { awaitingCallback: false, error: `没有找到 MCP Server「${name}」。` };
    if (!this.supportsOAuth(definition)) {
      return { awaitingCallback: false, error: `MCP Server「${name}」不走浏览器认证。` };
    }
    await this.ensureCallbackServer();
    this.cancelAuth(name);
    this.flows.set(name, { interactive: true });
    // A stale connection object still holds the transport that failed; the
    // authorization has to start from a clean one or the SDK will not re-run it.
    await this.drop(name);
    const outcome = await this.connectionFor(name).connect();
    const flow = this.flows.get(name);
    if (outcome === "connected") {
      this.flows.delete(name);
      return { awaitingCallback: false, authenticated: true };
    }
    if (!flow?.authorizationUrl) {
      return {
        awaitingCallback: false,
        error: this.failure(name) ?? `MCP Server「${name}」没有给出授权地址。`,
      };
    }
    return {
      authorizationUrl: flow.authorizationUrl.href,
      awaitingCallback: Boolean(flow.state && flow.waiting),
    };
  }

  /** Park until the browser comes back, then finish and reconnect. */
  async awaitAuth(name: string): Promise<McpServerRuntimeStatus> {
    const flow = this.flows.get(name);
    if (!flow?.waiting) throw new Error(`MCP Server「${name}」当前没有等待中的授权。`);
    const callback = await flow.waiting;
    return this.finishAuth(name, callback.code);
  }

  /** The paste-the-address fallback, for redirects that never reach the listener. */
  async completeAuth(name: string, input: string): Promise<McpServerRuntimeStatus> {
    const code = authorizationCode(input);
    if (!code) throw new Error("没能从粘贴的内容里认出授权码。");
    return this.finishAuth(name, code);
  }

  private async finishAuth(name: string, code: string): Promise<McpServerRuntimeStatus> {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`没有找到 MCP Server「${name}」。`);
    const connection = this.connectionFor(name);
    try {
      const outcome = await connection.finishAuth(code);
      if (outcome === "failed") this.failedAt.set(name, Date.now());
      else this.failedAt.delete(name);
    } finally {
      this.flows.delete(name);
    }
    return this.statusFor(definition);
  }

  /** The user closed the dialog; stop holding the redirect open for them. */
  cancelAuth(name: string): void {
    const flow = this.flows.get(name);
    if (!flow) return;
    if (flow.state) this.callback.cancel(flow.state);
    this.flows.delete(name);
  }

  /** Forget one server's credentials and drop its connection. */
  async logout(name: string): Promise<McpServerRuntimeStatus> {
    await this.reload();
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`没有找到 MCP Server「${name}」。`);
    this.cancelAuth(name);
    if (definition.url) this.options.store.clear(credentialKey(definition.url));
    await this.drop(name);
    return this.statusFor(definition);
  }

  /**
   * Hide a server from the Agent for this conversation only.
   *
   * Distinct from `disabled`, which is written to the configuration and outlives
   * the session. The connection is left alone: turning a server back on midway
   * through a conversation should not cost a reconnect.
   */
  setSessionEnabled(name: string, enabled: boolean): void {
    if (enabled) this.sessionDisabled.delete(name);
    else this.sessionDisabled.add(name);
  }

  sessionDisabledServers(): string[] {
    return [...this.sessionDisabled];
  }

  /** Which servers the Agent is allowed to see right now. */
  private availableDefinitions(): McpServerConfiguration[] {
    return [...this.definitions.values()]
      .filter((definition) => !definition.disabled && !this.sessionDisabled.has(definition.name));
  }

  /**
   * Everything the Agent can call.
   *
   * Servers are connected on demand here rather than up front: a workspace with
   * six configured servers should not pay six process spawns to answer one
   * question. `eager` is the opt-in for the servers that want it.
   */
  async listTools(): Promise<Array<{ server: string; tool: McpToolSummary }>> {
    await this.reload();
    const listed: Array<{ server: string; tool: McpToolSummary }> = [];
    await Promise.all(this.availableDefinitions().map(async (definition) => {
      const connection = this.connectionFor(definition.name);
      if (connection.status !== "connected" && definition.lifecycle !== "eager") return;
      if (connection.status !== "connected") await connection.connect();
      for (const tool of connection.tools) listed.push({ server: definition.name, tool });
    }));
    return listed;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.reload();
    const definition = this.definitions.get(server);
    if (!definition) throw new Error(`没有找到 MCP Server「${server}」。`);
    if (definition.disabled) throw new Error(`MCP Server「${server}」已停用。`);
    if (this.sessionDisabled.has(server)) throw new Error(`MCP Server「${server}」已在当前会话停用。`);
    return this.connectionFor(server).callTool(tool, args);
  }

  /** Connect everything marked `eager`, without letting one failure stop the rest. */
  async startEagerServers(): Promise<void> {
    await this.reload();
    await Promise.allSettled(
      this.availableDefinitions()
        .filter((definition) => definition.lifecycle === "eager")
        .map((definition) => this.connect(definition.name)),
    );
  }

  async close(): Promise<void> {
    for (const name of [...this.flows.keys()]) this.cancelAuth(name);
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.close()));
    this.connections.clear();
    await this.callback.close();
  }
}
