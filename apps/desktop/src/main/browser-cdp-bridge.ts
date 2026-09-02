import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { Event, WebContents } from "electron";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isDirectPageTargetInfoRequest, isTabActivationCommand, routePageCommand } from "./browser-cdp-commands";
import { detachDebuggerListener } from "./browser-cdp-teardown";
import { normalizeBrowserUrl } from "./browser-navigation";
import {
  BROWSER_TARGET_ID,
  DEFAULT_BROWSER_SCOPE_ID,
  DEFAULT_BROWSER_URL,
  browserContextId,
  browserTargetInfo,
  isReusableBlankTab,
  type BrowserTab,
} from "./browser-runtime-types";

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface ClientTabSessions {
  tabSessionId: string;
  pageSessionId: string;
  pageAttached: boolean;
}

interface CdpClient {
  id: string;
  scopeId: string;
  socket: WebSocket;
  discover: boolean;
  autoAttach: boolean;
  sessions: Map<string, ClientTabSessions>;
  directSessions: Map<string, string>;
  childSessions: Map<string, string>;
  debuggerListeners: Map<string, (...args: unknown[]) => void>;
}

export interface BrowserCdpHost {
  onAgentActivated(scopeId: string): void;
  ensureActiveTab(scopeId: string): Promise<BrowserTab>;
  createTab(rawUrl: string | undefined, activate: boolean, scopeId: string): Promise<BrowserTab>;
  selectTab(id: string, scopeId: string): void;
  closeTab(id: string, scopeId: string): void;
  cdpTabs(scopeId: string): BrowserTab[];
  tabById(id: string): BrowserTab | undefined;
  guestOf(tab: BrowserTab): WebContents;
  attachDebugger(tab: BrowserTab): void;
  applyViewportOverride(tab: BrowserTab): Promise<void>;
  windowBounds(tab: BrowserTab): Record<string, unknown>;
  windowForTab(tab: BrowserTab): Record<string, unknown>;
  setContentsSize(tab: BrowserTab, params: Record<string, unknown>): Promise<Record<string, never>>;
}

function responseError(error: unknown): { code: number; message: string } {
  return { code: -32000, message: error instanceof Error ? error.message : String(error) };
}

/**
 * Browser-level CDP facade used by Chrome DevTools MCP.
 *
 * Electron exposes a debugger per WebContents, while Puppeteer expects the
 * browser -> tab -> page target hierarchy. This class owns only that protocol
 * adaptation; BrowserRuntimeManager remains responsible for tab/UI lifecycle.
 */
/** Enough to cover a single agent action and the commands framing it. */
const RECENT_COMMAND_LIMIT = 24;

export class BrowserCdpBridge {
  readonly token = randomBytes(32).toString("base64url");
  private readonly pathToken = randomBytes(24).toString("hex");
  private readonly clients = new Map<string, CdpClient>();
  /**
   * The last handful of commands an agent sent, kept for one question only.
   *
   * Something raises the app window while an agent drives the browser in the
   * background, and nothing in main calls focus, show, or restore — so Chromium
   * is promoting a guest in response to a command. A stack trace cannot say
   * which: the window's `focus` event is native and carries no JS caller, which
   * is why the previous instrumentation never settled it. What identifies the
   * culprit is the command that immediately preceded the activation, so keep
   * enough of them to name it and attach the list when the window comes up.
   */
  private readonly recent: Array<{ ts: number; method: string }> = [];
  private readonly server: HttpServer;
  private readonly socketServer: WebSocketServer;
  private port?: number;

  constructor(private readonly host: BrowserCdpHost) {
    this.server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    this.socketServer = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const expected = Buffer.from(`Bearer ${this.token}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const authorizedPath = requestUrl.pathname === `/devtools/browser/${this.pathToken}`;
      const authorized = authorizedPath
        && actual.length === expected.length
        && timingSafeEqual(actual, expected);
      if (!authorized) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const scopeId = requestUrl.searchParams.get("scope")?.trim() || DEFAULT_BROWSER_SCOPE_ID;
      this.socketServer.handleUpgrade(request, socket, head, (webSocket) => this.acceptClient(webSocket, scopeId));
    });
  }

  async start(): Promise<void> {
    if (this.port) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") return reject(new Error("无法启动内置浏览器 CDP 桥。"));
        this.port = address.port;
        resolve();
      });
    });
  }

  endpoint(): string {
    if (!this.port) throw new Error("内置浏览器 CDP 桥尚未启动。");
    return `ws://127.0.0.1:${this.port}/devtools/browser/${this.pathToken}`;
  }

  releaseScope(scopeId: string): void {
    for (const client of [...this.clients.values()]) {
      if (client.scopeId === scopeId) client.socket.close(1008, "浏览器会话已释放");
    }
  }

  async dispose(): Promise<void> {
    for (const client of this.clients.values()) client.socket.close(1001, "CoilCoil 正在关闭");
    this.clients.clear();
    await new Promise<void>((resolve) => this.socketServer.close(() => resolve()));
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  announceCreated(tab: BrowserTab): void {
    if (!tab.announced) return;
    for (const client of this.clients.values()) {
      if (client.scopeId !== tab.scopeId) continue;
      this.installDebuggerRelay(client, tab);
      if (client.discover) {
        this.send(client, { method: "Target.targetCreated", params: { targetInfo: browserTargetInfo(tab, "tab") } });
        this.send(client, { method: "Target.targetCreated", params: { targetInfo: browserTargetInfo(tab, "page") } });
      }
      if (client.autoAttach) this.attachTab(client, tab);
    }
  }

  announceChanged(tab: BrowserTab): void {
    for (const client of this.clients.values()) {
      if (client.scopeId !== tab.scopeId || !client.discover) continue;
      this.send(client, { method: "Target.targetInfoChanged", params: { targetInfo: browserTargetInfo(tab, "tab") } });
      this.send(client, { method: "Target.targetInfoChanged", params: { targetInfo: browserTargetInfo(tab, "page") } });
    }
  }

  announceDestroyed(tab: BrowserTab): void {
    for (const client of this.clients.values()) {
      if (client.scopeId !== tab.scopeId) continue;
      const sessions = client.sessions.get(tab.id);
      if (sessions?.pageAttached) {
        this.send(client, { method: "Target.detachedFromTarget", sessionId: sessions.tabSessionId, params: { sessionId: sessions.pageSessionId, targetId: tab.pageTargetId } });
      }
      if (sessions) this.send(client, { method: "Target.detachedFromTarget", params: { sessionId: sessions.tabSessionId, targetId: tab.tabTargetId } });
      if (client.discover) {
        this.send(client, { method: "Target.targetDestroyed", params: { targetId: tab.pageTargetId } });
        this.send(client, { method: "Target.targetDestroyed", params: { targetId: tab.tabTargetId } });
      }
      client.sessions.delete(tab.id);
      this.deleteTabSessions(client.directSessions, tab.id);
      this.deleteTabSessions(client.childSessions, tab.id);
      this.removeDebuggerRelay(client, tab.id, tab);
    }
  }

  private deleteTabSessions(sessions: Map<string, string>, tabId: string): void {
    for (const [sessionId, ownerTabId] of sessions) {
      if (ownerTabId === tabId) sessions.delete(sessionId);
    }
  }

  /**
   * Relay teardown is best-effort: Electron may emit `destroyed` before this
   * lifecycle record is cleaned up, and accessing `.debugger` on that stale
   * WebContents throws "Object has been destroyed". A guest can also disappear
   * between `isDestroyed()` and `off()`, so the final access stays guarded.
   */
  private removeDebuggerRelay(client: CdpClient, tabId: string, tab = this.host.tabById(tabId)): void {
    const listener = client.debuggerListeners.get(tabId);
    client.debuggerListeners.delete(tabId);
    const guest = tab?.guest;
    if (!listener || !guest) return;
    detachDebuggerListener(guest, listener);
  }

  private acceptClient(socket: WebSocket, scopeId: string): void {
    const client: CdpClient = {
      id: randomUUID(), scopeId, socket, discover: false, autoAttach: false,
      sessions: new Map(), directSessions: new Map(), childSessions: new Map(), debuggerListeners: new Map(),
    };
    this.clients.set(client.id, client);
    this.host.onAgentActivated(scopeId);
    for (const tab of this.host.cdpTabs(scopeId)) this.installDebuggerRelay(client, tab);
    socket.on("message", (data) => { void this.handleClientMessage(client, data); });
    socket.once("close", () => this.removeClient(client));
    socket.once("error", () => this.removeClient(client));
  }

  private remember(method: string): void {
    this.recent.push({ ts: Date.now(), method });
    if (this.recent.length > RECENT_COMMAND_LIMIT) this.recent.splice(0, this.recent.length - RECENT_COMMAND_LIMIT);
  }

  /** Recent agent commands, newest last, each with how long ago it was sent. */
  recentCommands(): Array<{ method: string; msAgo: number }> {
    const now = Date.now();
    return this.recent.map((entry) => ({ method: entry.method, msAgo: now - entry.ts }));
  }

  private removeClient(client: CdpClient): void {
    if (!this.clients.delete(client.id)) return;
    for (const tabId of [...client.debuggerListeners.keys()]) this.removeDebuggerRelay(client, tabId);
    client.directSessions.clear();
    client.childSessions.clear();
  }

  private installDebuggerRelay(client: CdpClient, tab: BrowserTab): void {
    if (client.scopeId !== tab.scopeId || client.debuggerListeners.has(tab.id)) return;
    const listener = (_event: Event, method: string, params: unknown, sessionId?: string): void => {
      const sessions = client.sessions.get(tab.id);
      const directSessionIds = [...client.directSessions]
        .filter(([, tabId]) => tabId === tab.id)
        .map(([directSessionId]) => directSessionId);
      const hasChildSession = sessionId ? client.childSessions.get(sessionId) === tab.id : false;
      if (!sessions?.pageAttached && directSessionIds.length === 0 && !hasChildSession) return;
      const payload = params && typeof params === "object" ? params as Record<string, unknown> : {};
      const childSessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
      if (method === "Target.attachedToTarget" && childSessionId) client.childSessions.set(childSessionId, tab.id);
      if (sessionId && client.childSessions.get(sessionId) === tab.id) {
        this.send(client, { method, params: payload, sessionId });
      } else {
        if (sessions?.pageAttached) this.send(client, { method, params: payload, sessionId: sessions.pageSessionId });
        for (const directSessionId of directSessionIds) this.send(client, { method, params: payload, sessionId: directSessionId });
      }
      if (method === "Target.detachedFromTarget" && childSessionId) client.childSessions.delete(childSessionId);
    };
    this.host.guestOf(tab).debugger.on("message", listener);
    client.debuggerListeners.set(tab.id, listener as (...args: unknown[]) => void);
  }

  private async handleClientMessage(client: CdpClient, data: RawData): Promise<void> {
    let request: CdpRequest | undefined;
    try {
      request = JSON.parse(data.toString()) as CdpRequest;
      this.log("←", request.method, request.sessionId ?? "root");
      if (typeof request.method === "string") this.remember(request.method);
      if (!Number.isInteger(request.id) || typeof request.method !== "string") throw new Error("无效的 CDP 请求。");
      const result = await this.executeCdp(client, request);
      this.send(client, { id: request.id, result: result ?? {}, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
    } catch (error) {
      if (request?.id !== undefined) {
        this.send(client, { id: request.id, error: responseError(error), ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
      }
    }
  }

  private async executeCdp(client: CdpClient, request: CdpRequest): Promise<unknown> {
    const params = request.params ?? {};
    if (!request.sessionId) return this.executeRootCommand(client, request.method, params);
    const located = this.tabForSession(client, request.sessionId);
    if (!located) throw new Error(`未知的内置浏览器 CDP session：${request.sessionId}`);
    const { tab, sessions, kind } = located;
    if (kind === "tab") {
      if (request.method === "Target.setAutoAttach") {
        this.attachPage(client, tab, sessions);
        return {};
      }
      if (request.method === "Runtime.runIfWaitingForDebugger" || request.method === "Target.detachFromTarget") return {};
    }
    if (kind === "direct") {
      if (request.method === "Target.detachFromTarget") {
        client.directSessions.delete(request.sessionId);
        return {};
      }
      // Electron reports a webview here. Lighthouse only registers page/iframe/
      // worker targets, so expose the same synthetic page identity used when the
      // direct session was attached.
      if (isDirectPageTargetInfoRequest(request.method, params, tab.pageTargetId)) {
        return { targetInfo: browserTargetInfo(tab, "page") };
      }
    }
    if (isTabActivationCommand(request.method)) {
      this.host.selectTab(tab.id, tab.scopeId);
      return {};
    }
    if (request.method === "Browser.close") return {};
    if (request.method === "Browser.getWindowForTarget") return this.host.windowForTab(tab);
    if (request.method === "Browser.setContentsSize") return this.host.setContentsSize(tab, params);
    if (request.method === "Emulation.clearDeviceMetricsOverride") {
      delete tab.emulatedSize;
      await this.host.applyViewportOverride(tab);
      return {};
    }
    if (request.method === "WebMCP.enable" || request.method === "WebMCP.disable") return {};
    if (request.method === "WebMCP.invokeTool" || request.method === "WebMCP.cancelInvocation") {
      throw new Error("内置浏览器暂不支持网页注册的 WebMCP 工具。");
    }
    return this.executePageCommand(tab, kind, request.method, params, request.sessionId);
  }

  private async executePageCommand(
    tab: BrowserTab,
    kind: "tab" | "page" | "direct" | "child",
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    const guest = this.host.guestOf(tab);
    const childSession = kind === "child" ? sessionId : undefined;
    const normalizedParams = method === "Page.navigate" && typeof params.url === "string"
      ? { ...params, url: normalizeBrowserUrl(params.url) }
      : params;
    // Electron can replace the webview's main frame during Page.reload. A same-
    // URL Page.navigate has reload semantics without destroying the target.
    const routed = routePageCommand(
      method,
      normalizedParams,
      normalizeBrowserUrl(guest.getURL() || DEFAULT_BROWSER_URL),
    );
    const { method: command, params: commandParams, resetCache } = routed;
    this.host.attachDebugger(tab);
    try {
      if (resetCache) await guest.debugger.sendCommand("Network.setCacheDisabled", { cacheDisabled: true }, childSession);
      const result = await guest.debugger.sendCommand(command, commandParams, childSession);
      this.log("✓", `${method}${command === method ? "" : ` → ${command}`}`, sessionId);
      return result;
    } catch (error) {
      this.log("✗", method, error);
      throw error;
    } finally {
      if (resetCache) {
        void guest.debugger.sendCommand("Network.setCacheDisabled", { cacheDisabled: false }, childSession)
          .catch((error) => this.log("✗", "Network.setCacheDisabled(reset)", error));
      }
    }
  }

  /**
   * 开新标签页之前，先用掉这个桥自己垫出来的那张空白页。
   *
   * 一个客户端刚连上来就会问浏览器版本、要目标列表，这两条都得有一个页面才答得
   * 出来，`ensureActiveTab` 于是先垫一张空白页。agent 紧接着 new_page，结果每个
   * 会话都从「一张没人要的空白页 + 一张真正在用的页」开始——用户看到的就是「默认
   * 两个标签页起步」。那张空白页只要还停在 about:blank 上，就没有任何理由不给
   * agent 用。
   *
   * 只有这条 CDP 路径会复用。用户自己按「+」开的空白页不算（implicit 是 false）：
   * 那是他刚开的，替他导航走会很奇怪。
   */
  private async adoptBlankTab(url: string | undefined, activate: boolean, scopeId: string): Promise<BrowserTab | undefined> {
    const blank = this.host.cdpTabs(scopeId).find((tab) =>
      tab.guest && !tab.guest.isDestroyed() && isReusableBlankTab(tab, tab.guest.getURL()));
    if (!blank) return undefined;
    blank.implicit = false;
    if (activate) this.host.selectTab(blank.id, scopeId);
    await this.host.guestOf(blank).loadURL(normalizeBrowserUrl(url));
    this.announceChanged(blank);
    return blank;
  }

  private async executeRootCommand(client: CdpClient, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "Target.getBrowserContexts") return { browserContextIds: [browserContextId(client.scopeId)] };
    if (method === "Browser.getVersion") {
      const tab = await this.host.ensureActiveTab(client.scopeId);
      this.installDebuggerRelay(client, tab);
      return this.host.guestOf(tab).debugger.sendCommand(method, params);
    }
    if (method === "Target.setDiscoverTargets") {
      client.discover = params.discover === true;
      if (client.discover) {
        await this.host.ensureActiveTab(client.scopeId);
        this.announceAllTargets(client);
      }
      return {};
    }
    if (method === "Target.setAutoAttach") {
      client.autoAttach = params.autoAttach === true;
      if (client.autoAttach) for (const tab of this.host.cdpTabs(client.scopeId)) this.attachTab(client, tab);
      return {};
    }
    if (method === "Target.getTargets") return { targetInfos: this.allTargetInfos(client.scopeId) };
    if (method === "Target.getTargetInfo") {
      const requestedId = typeof params.targetId === "string" ? params.targetId : BROWSER_TARGET_ID;
      return { targetInfo: this.findTargetInfo(requestedId, client.scopeId) };
    }
    if (method === "Target.createTarget") {
      const url = typeof params.url === "string" ? params.url : undefined;
      const activate = params.background !== true;
      const tab = await this.adoptBlankTab(url, activate, client.scopeId)
        ?? await this.host.createTab(url, activate, client.scopeId);
      return { targetId: tab.pageTargetId };
    }
    if (method === "Target.activateTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""), client.scopeId);
      if (tab) this.host.selectTab(tab.id, client.scopeId);
      return {};
    }
    if (method === "Target.closeTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""), client.scopeId);
      if (tab) this.host.closeTab(tab.id, client.scopeId);
      return { success: Boolean(tab) };
    }
    if (method === "Target.attachToTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""), client.scopeId);
      if (!tab) throw new Error("目标标签页不存在。");
      if (params.targetId === tab.pageTargetId) {
        this.ensureClientSessions(client, tab);
        const sessionId = `direct-session-${client.id.slice(0, 8)}-${randomUUID()}`;
        client.directSessions.set(sessionId, tab.id);
        this.send(client, {
          method: "Target.attachedToTarget",
          params: { sessionId, targetInfo: browserTargetInfo(tab, "page"), waitingForDebugger: false },
        });
        return { sessionId };
      }
      const sessions = this.ensureClientSessions(client, tab);
      this.attachTab(client, tab);
      return { sessionId: sessions.tabSessionId };
    }
    if (method === "Target.detachFromTarget" && typeof params.sessionId === "string") {
      client.directSessions.delete(params.sessionId);
      return {};
    }
    if (method === "Browser.close") return {};
    if (method === "Browser.getWindowBounds") {
      const tab = this.findTabByWindowId(params.windowId, client.scopeId) ?? await this.host.ensureActiveTab(client.scopeId);
      return { bounds: this.host.windowBounds(tab) };
    }
    if (method === "Browser.setWindowBounds") {
      const tab = this.findTabByWindowId(params.windowId, client.scopeId) ?? await this.host.ensureActiveTab(client.scopeId);
      const bounds = params.bounds && typeof params.bounds === "object" ? params.bounds as Record<string, unknown> : {};
      if (typeof bounds.width === "number" && typeof bounds.height === "number") await this.host.setContentsSize(tab, bounds);
      return {};
    }
    if (method === "Browser.getWindowForTarget") {
      const requested = typeof params.targetId === "string" ? this.findTabByTarget(params.targetId, client.scopeId) : undefined;
      return this.host.windowForTab(requested ?? await this.host.ensureActiveTab(client.scopeId));
    }
    if (method === "Browser.setContentsSize") {
      const tab = this.findTabByWindowId(params.windowId, client.scopeId) ?? await this.host.ensureActiveTab(client.scopeId);
      return this.host.setContentsSize(tab, params);
    }
    const tab = await this.host.ensureActiveTab(client.scopeId);
    this.installDebuggerRelay(client, tab);
    this.host.attachDebugger(tab);
    return this.host.guestOf(tab).debugger.sendCommand(method, params);
  }

  private ensureClientSessions(client: CdpClient, tab: BrowserTab): ClientTabSessions {
    let sessions = client.sessions.get(tab.id);
    if (!sessions) {
      const suffix = `${client.id.slice(0, 8)}-${tab.id.slice(0, 8)}`;
      sessions = { tabSessionId: `tab-session-${suffix}`, pageSessionId: `page-session-${suffix}`, pageAttached: false };
      client.sessions.set(tab.id, sessions);
    }
    return sessions;
  }

  private attachTab(client: CdpClient, tab: BrowserTab): void {
    const sessions = this.ensureClientSessions(client, tab);
    this.send(client, {
      method: "Target.attachedToTarget",
      params: { sessionId: sessions.tabSessionId, targetInfo: browserTargetInfo(tab, "tab"), waitingForDebugger: false },
    });
  }

  private attachPage(client: CdpClient, tab: BrowserTab, sessions = this.ensureClientSessions(client, tab)): void {
    if (sessions.pageAttached) return;
    sessions.pageAttached = true;
    this.send(client, {
      method: "Target.attachedToTarget",
      sessionId: sessions.tabSessionId,
      params: { sessionId: sessions.pageSessionId, targetInfo: browserTargetInfo(tab, "page"), waitingForDebugger: false },
    });
  }

  private announceAllTargets(client: CdpClient): void {
    this.send(client, { method: "Target.targetCreated", params: { targetInfo: this.browserTargetInfo() } });
    for (const tab of this.host.cdpTabs(client.scopeId)) {
      this.send(client, { method: "Target.targetCreated", params: { targetInfo: browserTargetInfo(tab, "tab") } });
      this.send(client, { method: "Target.targetCreated", params: { targetInfo: browserTargetInfo(tab, "page") } });
    }
  }

  private browserTargetInfo(): Record<string, unknown> {
    return { targetId: BROWSER_TARGET_ID, type: "browser", title: "CoilCoil", url: "", attached: true, canAccessOpener: false };
  }

  private allTargetInfos(scopeId: string): Array<Record<string, unknown>> {
    return [
      this.browserTargetInfo(),
      ...this.host.cdpTabs(scopeId).flatMap((tab) => [browserTargetInfo(tab, "tab"), browserTargetInfo(tab, "page")]),
    ];
  }

  private findTargetInfo(id: string, scopeId: string): Record<string, unknown> {
    if (id === BROWSER_TARGET_ID) return this.browserTargetInfo();
    const tab = this.findTabByTarget(id, scopeId);
    if (!tab) throw new Error("目标不存在。");
    return browserTargetInfo(tab, id === tab.tabTargetId ? "tab" : "page");
  }

  private findTabByTarget(id: string, scopeId: string): BrowserTab | undefined {
    return this.host.cdpTabs(scopeId).find((tab) => tab.tabTargetId === id || tab.pageTargetId === id);
  }

  private findTabByWindowId(value: unknown, scopeId: string): BrowserTab | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return this.host.cdpTabs(scopeId).find((tab) => tab.guest?.id === value);
  }

  private tabForSession(client: CdpClient, sessionId: string): {
    tab: BrowserTab;
    sessions: ClientTabSessions;
    kind: "tab" | "page" | "direct" | "child";
  } | undefined {
    for (const [tabId, sessions] of client.sessions) {
      const tab = this.host.tabById(tabId);
      if (!tab || tab.scopeId !== client.scopeId) continue;
      if (sessions.tabSessionId === sessionId) return { tab, sessions, kind: "tab" };
      if (sessions.pageSessionId === sessionId) return { tab, sessions, kind: "page" };
    }
    const directTabId = client.directSessions.get(sessionId);
    const directTab = directTabId ? this.host.tabById(directTabId) : undefined;
    const directSessions = directTabId ? client.sessions.get(directTabId) : undefined;
    if (directTab?.scopeId === client.scopeId && directSessions) return { tab: directTab, sessions: directSessions, kind: "direct" };
    const childTabId = client.childSessions.get(sessionId);
    const childTab = childTabId ? this.host.tabById(childTabId) : undefined;
    const childSessions = childTabId ? client.sessions.get(childTabId) : undefined;
    return childTab?.scopeId === client.scopeId && childSessions ? { tab: childTab, sessions: childSessions, kind: "child" } : undefined;
  }

  private send(client: CdpClient, value: Record<string, unknown>): void {
    this.log("→", value.method ?? `#${value.id}`, value.sessionId ?? "root");
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(value));
  }

  private log(direction: string, subject: unknown, detail: unknown): void {
    // The timestamp is what lets a reader line these up against the window
    // activation log and see which command raised the app.
    if (process.env.COILCOIL_BROWSER_CDP_LOG === "1") console.error(`[browser-cdp ${Date.now()}] ${direction}`, subject, detail);
  }
}
