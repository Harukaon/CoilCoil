import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BrowserWindow, WebContentsView, type Rectangle, type WebContents } from "electron";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { BrowserStateSnapshot, BrowserTabSnapshot, BrowserViewBounds } from "../shared/desktop-api";
import { browserCssBoundsToDip } from "./browser-bounds";

const DEFAULT_URL = "about:blank";
const BROWSER_TARGET_ID = "suocode-browser";
const BACKGROUND_VIEWPORT: Rectangle = { x: 0, y: 0, width: 1280, height: 720 };
const OFFSCREEN_VIEWPORT: Rectangle = { x: -16_384, y: -16_384, width: 1280, height: 720 };

interface BrowserTab {
  id: string;
  tabTargetId: string;
  pageTargetId: string;
  view: WebContentsView;
}

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
  socket: WebSocket;
  discover: boolean;
  autoAttach: boolean;
  sessions: Map<string, ClientTabSessions>;
  childSessions: Map<string, string>;
  debuggerListeners: Map<string, (...args: unknown[]) => void>;
}

function normalizedUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_URL;
  if (/^about:blank$/i.test(value)) return DEFAULT_URL;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("内置浏览器只允许 HTTP 或 HTTPS 地址。");
    return parsed.toString();
  }
  const candidate = value.includes(".") && !value.includes(" ")
    ? `https://${value}`
    : `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  return new URL(candidate).toString();
}

function targetInfo(tab: BrowserTab, kind: "tab" | "page"): Record<string, unknown> {
  const contents = tab.view.webContents;
  return {
    targetId: kind === "tab" ? tab.tabTargetId : tab.pageTargetId,
    type: kind,
    title: contents.getTitle() || "新标签页",
    url: contents.getURL() || DEFAULT_URL,
    attached: true,
    canAccessOpener: false,
    browserContextId: "",
  };
}

function responseError(error: unknown): { code: number; message: string } {
  return { code: -32000, message: error instanceof Error ? error.message : String(error) };
}

/**
 * A capability-scoped browser-level CDP facade for Chrome DevTools MCP.
 *
 * Puppeteer expects Chrome's browser -> tab -> page target hierarchy. Electron
 * exposes only a debugger bound to one WebContents. This facade supplies the
 * missing target hierarchy and forwards page commands exclusively to the
 * WebContentsView instances owned by SuoCode. No global remote-debugging port is
 * opened and renderer WebContents are never addressable.
 */
export class BrowserRuntimeManager {
  readonly token = randomBytes(32).toString("base64url");
  private readonly pathToken = randomBytes(24).toString("hex");
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly clients = new Map<string, CdpClient>();
  private readonly server: HttpServer;
  private readonly socketServer: WebSocketServer;
  private port?: number;
  private activeTabId?: string;
  private browserCssBounds: BrowserViewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private disposed = false;
  private readonly handleWindowLayoutChanged = (): void => this.applyViewLayout();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publishState: (state: BrowserStateSnapshot) => void,
    private readonly onAgentActivated: () => void,
  ) {
    this.server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    this.socketServer = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const expected = Buffer.from(`Bearer ${this.token}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      const authorized = request.url === `/devtools/browser/${this.pathToken}`
        && actual.length === expected.length
        && timingSafeEqual(actual, expected);
      if (!authorized) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.socketServer.handleUpgrade(request, socket, head, (webSocket) => this.acceptClient(webSocket));
    });
    this.window.on("resize", this.handleWindowLayoutChanged);
    this.window.webContents.on("zoom-changed", this.handleWindowLayoutChanged);
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

  state(): BrowserStateSnapshot {
    return {
      tabs: [...this.tabs.values()].map((tab) => this.tabSnapshot(tab)),
      activeTabId: this.activeTabId,
    };
  }

  async createTab(rawUrl?: string, activate = true): Promise<BrowserStateSnapshot> {
    const id = randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: "persist:suocode-browser",
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setBounds(OFFSCREEN_VIEWPORT);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const tab: BrowserTab = { id, tabTargetId: `tab-${id}`, pageTargetId: `page-${id}`, view };
    this.tabs.set(id, tab);
    this.installTabSecurity(tab);
    this.installTabEvents(tab);
    this.attachDebugger(tab);
    if (activate || !this.activeTabId) this.activeTabId = id;
    this.applyViewLayout();
    this.announceCreated(tab);
    await view.webContents.loadURL(normalizedUrl(rawUrl));
    this.publish();
    return this.state();
  }

  async ensureActiveTab(): Promise<BrowserTab> {
    const active = this.activeTab();
    if (active) return active;
    await this.createTab();
    const created = this.activeTab();
    if (!created) throw new Error("无法创建内置浏览器标签页。");
    return created;
  }

  selectTab(id: string): BrowserStateSnapshot {
    if (!this.tabs.has(id)) throw new Error("浏览器标签页不存在。");
    this.activeTabId = id;
    this.applyViewLayout();
    this.publish();
    return this.state();
  }

  closeTab(id: string): BrowserStateSnapshot {
    const tab = this.tabs.get(id);
    if (!tab) return this.state();
    const order = [...this.tabs.keys()];
    const index = order.indexOf(id);
    this.tabs.delete(id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) {
      if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach();
      tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    for (const client of this.clients.values()) this.announceDestroyed(client, tab);
    if (this.activeTabId === id) {
      this.activeTabId = order[index + 1] ?? order[index - 1] ?? [...this.tabs.keys()][0];
    }
    if (!this.window.isDestroyed()) this.applyViewLayout();
    this.publish();
    return this.state();
  }

  async navigate(rawUrl: string): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab();
    await tab.view.webContents.loadURL(normalizedUrl(rawUrl));
    return this.state();
  }

  async back(): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab();
    if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
    return this.state();
  }

  async forward(): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab();
    if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
    return this.state();
  }

  async reload(): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab();
    tab.view.webContents.reload();
    return this.state();
  }

  setBounds(bounds: BrowserViewBounds): void {
    const finite = [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite);
    if (!finite) return;
    this.browserCssBounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
      visible: Boolean(bounds.visible),
    };
    this.applyViewLayout();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.window.isDestroyed()) {
      this.window.off("resize", this.handleWindowLayoutChanged);
      this.window.webContents.off("zoom-changed", this.handleWindowLayoutChanged);
    }
    for (const client of this.clients.values()) client.socket.close(1001, "SuoCode 正在关闭");
    this.clients.clear();
    for (const tab of [...this.tabs.values()]) this.closeTab(tab.id);
    await new Promise<void>((resolve) => this.socketServer.close(() => resolve()));
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private activeTab(): BrowserTab | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  private tabSnapshot(tab: BrowserTab): BrowserTabSnapshot {
    const contents = tab.view.webContents;
    return {
      id: tab.id,
      title: contents.getTitle() || (contents.getURL() === DEFAULT_URL ? "新标签页" : contents.getURL()) || "新标签页",
      url: contents.getURL() || DEFAULT_URL,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
  }

  private publish(): void {
    this.publishState(this.state());
  }

  private installTabSecurity(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    contents.setWindowOpenHandler(({ url }) => {
      try {
        normalizedUrl(url);
        void this.createTab(url).catch((error) => console.error("[browser] 打开新标签页失败", error));
      } catch {
        // Keep unsupported protocols inside the browser sandbox.
      }
      return { action: "deny" };
    });
    const guardNavigation = (event: Electron.Event, url: string): void => {
      try {
        normalizedUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
  }

  private installTabEvents(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    const update = (): void => {
      this.publish();
      for (const client of this.clients.values()) this.announceChanged(client, tab);
    };
    contents.on("did-start-loading", update);
    contents.on("did-stop-loading", update);
    contents.on("page-title-updated", update);
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("render-process-gone", update);
  }

  private attachDebugger(tab: BrowserTab): void {
    const debug = tab.view.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
  }

  private applyViewLayout(): void {
    if (this.window.isDestroyed()) return;
    const [contentWidth, contentHeight] = this.window.getContentSize();
    const nativeBounds = browserCssBoundsToDip(
      this.browserCssBounds,
      this.window.webContents.getZoomFactor(),
      { width: contentWidth, height: contentHeight },
    );
    const bounds: Rectangle = {
      x: nativeBounds.x,
      y: nativeBounds.y,
      width: nativeBounds.width,
      height: nativeBounds.height,
    };
    for (const tab of this.tabs.values()) {
      const active = tab.id === this.activeTabId && nativeBounds.visible && bounds.width > 0 && bounds.height > 0;
      if (active) {
        tab.view.setBounds(bounds);
        tab.view.setVisible(true);
      } else if (tab.id === this.activeTabId) {
        tab.view.setBounds(OFFSCREEN_VIEWPORT);
        tab.view.setVisible(true);
      } else {
        tab.view.setBounds(BACKGROUND_VIEWPORT);
        tab.view.setVisible(false);
      }
    }
  }

  private acceptClient(socket: WebSocket): void {
    const client: CdpClient = {
      id: randomUUID(), socket, discover: false, autoAttach: false,
      sessions: new Map(), childSessions: new Map(), debuggerListeners: new Map(),
    };
    this.clients.set(client.id, client);
    this.onAgentActivated();
    for (const tab of this.tabs.values()) this.installDebuggerRelay(client, tab);
    socket.on("message", (data) => { void this.handleClientMessage(client, data); });
    socket.once("close", () => this.removeClient(client));
    socket.once("error", () => this.removeClient(client));
  }

  private removeClient(client: CdpClient): void {
    if (!this.clients.delete(client.id)) return;
    for (const [tabId, listener] of client.debuggerListeners) {
      const tab = this.tabs.get(tabId);
      tab?.view.webContents.debugger.off("message", listener as never);
    }
    client.debuggerListeners.clear();
    client.childSessions.clear();
  }

  private installDebuggerRelay(client: CdpClient, tab: BrowserTab): void {
    if (client.debuggerListeners.has(tab.id)) return;
    const listener = (_event: Electron.Event, method: string, params: unknown, sessionId?: string): void => {
      const sessions = client.sessions.get(tab.id);
      if (!sessions?.pageAttached) return;
      const payload = params && typeof params === "object" ? params as Record<string, unknown> : {};
      const childSessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
      const outboundSessionId = sessionId && client.childSessions.get(sessionId) === tab.id
        ? sessionId
        : sessions.pageSessionId;
      if (method === "Target.attachedToTarget" && childSessionId) client.childSessions.set(childSessionId, tab.id);
      this.send(client, { method, params: payload, sessionId: outboundSessionId });
      if (method === "Target.detachedFromTarget" && childSessionId) client.childSessions.delete(childSessionId);
    };
    tab.view.webContents.debugger.on("message", listener);
    client.debuggerListeners.set(tab.id, listener as (...args: unknown[]) => void);
  }

  private async handleClientMessage(client: CdpClient, data: RawData): Promise<void> {
    let request: CdpRequest | undefined;
    try {
      request = JSON.parse(data.toString()) as CdpRequest;
      if (process.env.SUOCODE_BROWSER_CDP_LOG === "1") console.error("[browser-cdp] ←", request.method, request.sessionId ?? "root");
      if (!Number.isInteger(request.id) || typeof request.method !== "string") throw new Error("无效的 CDP 请求。");
      const result = await this.executeCdp(client, request);
      this.send(client, { id: request.id, result: result ?? {}, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
    } catch (error) {
      if (request?.id !== undefined) this.send(client, { id: request.id, error: responseError(error), ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
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
      if (request.method === "Runtime.runIfWaitingForDebugger") return {};
      if (request.method === "Target.detachFromTarget") return {};
    }
    if (request.method === "Browser.close") return {};
    if (request.method === "Page.navigate" && typeof params.url === "string") normalizedUrl(params.url);
    this.attachDebugger(tab);
    const childSession = kind === "child" ? request.sessionId : undefined;
    return tab.view.webContents.debugger.sendCommand(request.method, params, childSession);
  }

  private async executeRootCommand(client: CdpClient, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
    if (method === "Browser.getVersion") {
      const tab = await this.ensureActiveTab();
      this.installDebuggerRelay(client, tab);
      return tab.view.webContents.debugger.sendCommand(method, params);
    }
    if (method === "Target.setDiscoverTargets") {
      client.discover = params.discover === true;
      if (client.discover) {
        await this.ensureActiveTab();
        this.announceAllTargets(client);
      }
      return {};
    }
    if (method === "Target.setAutoAttach") {
      client.autoAttach = params.autoAttach === true;
      if (client.autoAttach) for (const tab of this.tabs.values()) this.attachTab(client, tab);
      return {};
    }
    if (method === "Target.getTargets") return { targetInfos: this.allTargetInfos() };
    if (method === "Target.getTargetInfo") {
      const requestedId = typeof params.targetId === "string" ? params.targetId : BROWSER_TARGET_ID;
      return { targetInfo: this.findTargetInfo(requestedId) };
    }
    if (method === "Target.createTarget") {
      const before = new Set(this.tabs.keys());
      await this.createTab(typeof params.url === "string" ? params.url : undefined, params.background !== true);
      const tab = [...this.tabs.values()].find((candidate) => !before.has(candidate.id));
      if (!tab) throw new Error("创建浏览器标签页失败。");
      return { targetId: tab.tabTargetId };
    }
    if (method === "Target.activateTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""));
      if (tab) this.selectTab(tab.id);
      return {};
    }
    if (method === "Target.closeTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""));
      if (tab) this.closeTab(tab.id);
      return { success: Boolean(tab) };
    }
    if (method === "Target.attachToTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""));
      if (!tab) throw new Error("目标标签页不存在。");
      const sessions = this.ensureClientSessions(client, tab);
      this.attachTab(client, tab);
      return { sessionId: sessions.tabSessionId };
    }
    if (method === "Browser.close") return {};
    const tab = await this.ensureActiveTab();
    this.installDebuggerRelay(client, tab);
    this.attachDebugger(tab);
    return tab.view.webContents.debugger.sendCommand(method, params);
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
      params: { sessionId: sessions.tabSessionId, targetInfo: targetInfo(tab, "tab"), waitingForDebugger: false },
    });
  }

  private attachPage(client: CdpClient, tab: BrowserTab, sessions = this.ensureClientSessions(client, tab)): void {
    if (sessions.pageAttached) return;
    sessions.pageAttached = true;
    this.send(client, {
      method: "Target.attachedToTarget",
      sessionId: sessions.tabSessionId,
      params: { sessionId: sessions.pageSessionId, targetInfo: targetInfo(tab, "page"), waitingForDebugger: false },
    });
  }

  private announceAllTargets(client: CdpClient): void {
    this.send(client, { method: "Target.targetCreated", params: { targetInfo: { targetId: BROWSER_TARGET_ID, type: "browser", title: "SuoCode", url: "", attached: true, canAccessOpener: false } } });
    for (const tab of this.tabs.values()) {
      this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "tab") } });
      this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "page") } });
    }
  }

  private announceCreated(tab: BrowserTab): void {
    for (const client of this.clients.values()) {
      this.installDebuggerRelay(client, tab);
      if (client.discover) {
        this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "tab") } });
        this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "page") } });
      }
      if (client.autoAttach) this.attachTab(client, tab);
    }
  }

  private announceChanged(client: CdpClient, tab: BrowserTab): void {
    if (!client.discover) return;
    this.send(client, { method: "Target.targetInfoChanged", params: { targetInfo: targetInfo(tab, "tab") } });
    this.send(client, { method: "Target.targetInfoChanged", params: { targetInfo: targetInfo(tab, "page") } });
  }

  private announceDestroyed(client: CdpClient, tab: BrowserTab): void {
    const sessions = client.sessions.get(tab.id);
    if (sessions?.pageAttached) this.send(client, { method: "Target.detachedFromTarget", sessionId: sessions.tabSessionId, params: { sessionId: sessions.pageSessionId, targetId: tab.pageTargetId } });
    if (sessions) this.send(client, { method: "Target.detachedFromTarget", params: { sessionId: sessions.tabSessionId, targetId: tab.tabTargetId } });
    if (client.discover) {
      this.send(client, { method: "Target.targetDestroyed", params: { targetId: tab.pageTargetId } });
      this.send(client, { method: "Target.targetDestroyed", params: { targetId: tab.tabTargetId } });
    }
    client.sessions.delete(tab.id);
    for (const [sessionId, tabId] of client.childSessions) {
      if (tabId === tab.id) client.childSessions.delete(sessionId);
    }
    const listener = client.debuggerListeners.get(tab.id);
    if (listener) tab.view.webContents.debugger.off("message", listener as never);
    client.debuggerListeners.delete(tab.id);
  }

  private tabForSession(client: CdpClient, sessionId: string): { tab: BrowserTab; sessions: ClientTabSessions; kind: "tab" | "page" | "child" } | undefined {
    for (const [tabId, sessions] of client.sessions) {
      const tab = this.tabs.get(tabId);
      if (!tab) continue;
      if (sessions.tabSessionId === sessionId) return { tab, sessions, kind: "tab" };
      if (sessions.pageSessionId === sessionId) return { tab, sessions, kind: "page" };
    }
    const childTabId = client.childSessions.get(sessionId);
    const childTab = childTabId ? this.tabs.get(childTabId) : undefined;
    const childSessions = childTabId ? client.sessions.get(childTabId) : undefined;
    return childTab && childSessions ? { tab: childTab, sessions: childSessions, kind: "child" } : undefined;
  }

  private allTargetInfos(): Array<Record<string, unknown>> {
    return [
      { targetId: BROWSER_TARGET_ID, type: "browser", title: "SuoCode", url: "", attached: true, canAccessOpener: false },
      ...[...this.tabs.values()].flatMap((tab) => [targetInfo(tab, "tab"), targetInfo(tab, "page")]),
    ];
  }

  private findTargetInfo(id: string): Record<string, unknown> {
    if (id === BROWSER_TARGET_ID) return this.allTargetInfos()[0];
    const tab = this.findTabByTarget(id);
    if (!tab) throw new Error("目标不存在。");
    return targetInfo(tab, id === tab.tabTargetId ? "tab" : "page");
  }

  private findTabByTarget(id: string): BrowserTab | undefined {
    return [...this.tabs.values()].find((tab) => tab.tabTargetId === id || tab.pageTargetId === id);
  }

  private send(client: CdpClient, value: Record<string, unknown>): void {
    if (process.env.SUOCODE_BROWSER_CDP_LOG === "1") console.error("[browser-cdp] →", value.method ?? `#${value.id}`, value.sessionId ?? "root");
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(value));
  }
}
