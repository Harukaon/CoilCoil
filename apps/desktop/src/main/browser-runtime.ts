import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BrowserWindow, WebContentsView, type Rectangle, type WebContents } from "electron";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { BrowserStateSnapshot, BrowserTabSnapshot, BrowserViewBounds } from "../shared/desktop-api";
import { browserCssBoundsToDip } from "./browser-bounds";
import { normalizeBrowserUrl } from "./browser-navigation";

const DEFAULT_URL = "about:blank";
const DEFAULT_SCOPE_ID = "default";
const BROWSER_TARGET_ID = "suocode-browser";
const BROWSER_CONTEXT_ID = "suocode-browser-context";
const BACKGROUND_VIEWPORT: Rectangle = { x: 0, y: 0, width: 1280, height: 720 };
const OFFSCREEN_VIEWPORT: Rectangle = { x: -16_384, y: -16_384, width: 1280, height: 720 };

interface BrowserTab {
  id: string;
  scopeId: string;
  tabTargetId: string;
  pageTargetId: string;
  view: WebContentsView;
  announced: boolean;
  emulatedSize?: { width: number; height: number };
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
  scopeId: string;
  mode: "devtools" | "playwright";
  socket: WebSocket;
  discover: boolean;
  autoAttach: boolean;
  sessions: Map<string, ClientTabSessions>;
  directSessions: Map<string, string>;
  childSessions: Map<string, string>;
  debuggerListeners: Map<string, (...args: unknown[]) => void>;
}

function browserContextId(scopeId: string): string {
  return `${BROWSER_CONTEXT_ID}:${scopeId}`;
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
    browserContextId: browserContextId(tab.scopeId),
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
  private readonly activeTabIds = new Map<string, string>();
  private uiScopeId = DEFAULT_SCOPE_ID;
  private browserCssBounds: BrowserViewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private disposed = false;
  private readonly handleWindowLayoutChanged = (): void => this.applyViewLayout();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publishState: (state: BrowserStateSnapshot) => void,
    private readonly onAgentActivated: (scopeId: string) => void,
  ) {
    this.server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    this.socketServer = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const expected = Buffer.from(`Bearer ${this.token}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const authorizedPath = requestUrl.pathname === `/devtools/browser/${this.pathToken}`
        || requestUrl.pathname === `/playwright/browser/${this.pathToken}`;
      const authorized = authorizedPath
        && actual.length === expected.length
        && timingSafeEqual(actual, expected);
      if (!authorized) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const mode = requestUrl.pathname.startsWith(`/playwright/browser/${this.pathToken}`) ? "playwright" : "devtools";
      const scopeId = requestUrl.searchParams.get("scope")?.trim() || DEFAULT_SCOPE_ID;
      this.socketServer.handleUpgrade(request, socket, head, (webSocket) => this.acceptClient(webSocket, mode, scopeId));
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

  playwrightEndpoint(): string {
    if (!this.port) throw new Error("内置浏览器 CDP 桥尚未启动。");
    return `ws://127.0.0.1:${this.port}/playwright/browser/${this.pathToken}`;
  }

  state(scopeId = this.uiScopeId): BrowserStateSnapshot {
    return {
      scopeId,
      tabs: this.tabsForScope(scopeId).map((tab) => this.tabSnapshot(tab)),
      activeTabId: this.activeTabIds.get(scopeId),
    };
  }

  setUiScope(scopeId: string): BrowserStateSnapshot {
    this.uiScopeId = scopeId.trim() || DEFAULT_SCOPE_ID;
    this.applyViewLayout();
    const state = this.state();
    this.publishState(state);
    return state;
  }

  async createTab(rawUrl?: string, activate = true, scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = this.createTabRecord(activate, scopeId);
    const url = normalizeBrowserUrl(rawUrl);
    await tab.view.webContents.loadURL(url);
    await this.finishTabCreation(tab);
    return this.state(scopeId);
  }

  /**
   * Create and announce the target without waiting for navigation.
   *
   * A new Electron WebContents does not have a committed document yet. We keep
   * it private until about:blank is ready so Puppeteer cannot issue Page/Runtime
   * initialization commands against a half-created target.
   */
  private createTabRecord(activate: boolean, scopeId: string): BrowserTab {
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
    const tab: BrowserTab = {
      id,
      scopeId,
      tabTargetId: `tab-${id}`,
      pageTargetId: `pending-page-${id}`,
      view,
      announced: false,
    };
    this.tabs.set(id, tab);
    this.installTabSecurity(tab);
    this.installTabEvents(tab);
    this.attachDebugger(tab);
    if (activate || !this.activeTabIds.has(scopeId)) this.activeTabIds.set(scopeId, id);
    return tab;
  }

  private async finishTabCreation(tab: BrowserTab): Promise<void> {
    await this.refreshPageTargetIdentity(tab);
    tab.announced = true;
    this.applyViewLayout();
    this.announceCreated(tab);
    this.publish();
  }

  /**
   * Use Chromium's real page target id instead of inventing one.
   *
   * Playwright correlates the page target, its main frame and execution
   * contexts while constructing a Page. A synthetic target id lets the CDP
   * connection open, but leaves the Page in a permanently half-initialized
   * state (page.url() is empty and all semantic actions wait forever).
   * Electron exposes the real identity through the debugger attached to this
   * exact WebContents, so using it preserves both Playwright's invariants and
   * SuoCode's single-WebContents isolation boundary.
   */
  private async refreshPageTargetIdentity(tab: BrowserTab): Promise<void> {
    this.attachDebugger(tab);
    const result = await tab.view.webContents.debugger.sendCommand("Target.getTargetInfo") as {
      targetInfo?: { targetId?: unknown };
    };
    const targetId = result.targetInfo?.targetId;
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new Error("无法读取内置浏览器页面的真实 CDP target id。");
    }
    tab.pageTargetId = targetId;
  }

  private async createCdpTab(rawUrl: string | undefined, activate: boolean, scopeId: string): Promise<BrowserTab> {
    const url = normalizeBrowserUrl(rawUrl);
    const tab = this.createTabRecord(activate, scopeId);
    try {
      await tab.view.webContents.loadURL(url);
      await this.finishTabCreation(tab);
    } catch (error) {
      this.closeTabRecord(tab);
      throw error;
    }
    return tab;
  }

  async ensureActiveTab(scopeId = this.uiScopeId): Promise<BrowserTab> {
    const active = this.activeTab(scopeId);
    if (active) return active;
    await this.createTab(undefined, true, scopeId);
    const created = this.activeTab(scopeId);
    if (!created) throw new Error("无法创建内置浏览器标签页。");
    return created;
  }

  selectTab(id: string, scopeId = this.uiScopeId): BrowserStateSnapshot {
    if (this.tabs.get(id)?.scopeId !== scopeId) throw new Error("浏览器标签页不存在。");
    this.activeTabIds.set(scopeId, id);
    this.applyViewLayout();
    this.publish();
    return this.state(scopeId);
  }

  closeTab(id: string, scopeId = this.uiScopeId): BrowserStateSnapshot {
    const tab = this.tabs.get(id);
    if (!tab || tab.scopeId !== scopeId) return this.state(scopeId);
    const order = this.tabsForScope(scopeId).map((item) => item.id);
    const index = order.indexOf(id);
    this.closeTabRecord(tab);
    if (this.activeTabIds.get(scopeId) === id) {
      const next = order[index + 1] ?? order[index - 1];
      if (next) this.activeTabIds.set(scopeId, next);
      else this.activeTabIds.delete(scopeId);
    }
    if (!this.window.isDestroyed()) this.applyViewLayout();
    this.publish();
    return this.state(scopeId);
  }

  releaseScope(scopeId: string): void {
    for (const client of [...this.clients.values()]) {
      if (client.scopeId === scopeId) client.socket.close(1008, "浏览器会话已释放");
    }
    for (const tab of this.tabsForScope(scopeId)) this.closeTabRecord(tab);
    this.activeTabIds.delete(scopeId);
    if (this.uiScopeId === scopeId) {
      this.applyViewLayout();
      this.publish();
    }
  }

  async navigate(rawUrl: string, scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    await tab.view.webContents.loadURL(normalizeBrowserUrl(rawUrl));
    return this.state(scopeId);
  }

  async back(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
    return this.state(scopeId);
  }

  async forward(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
    return this.state(scopeId);
  }

  async reload(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    tab.view.webContents.reload();
    return this.state(scopeId);
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
    for (const tab of [...this.tabs.values()]) this.closeTabRecord(tab);
    await new Promise<void>((resolve) => this.socketServer.close(() => resolve()));
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private tabsForScope(scopeId: string): BrowserTab[] {
    return [...this.tabs.values()].filter((tab) => tab.scopeId === scopeId);
  }

  private activeTab(scopeId: string): BrowserTab | undefined {
    const id = this.activeTabIds.get(scopeId);
    return id ? this.tabs.get(id) : undefined;
  }

  private closeTabRecord(tab: BrowserTab): void {
    if (!this.tabs.delete(tab.id)) return;
    if (this.activeTabIds.get(tab.scopeId) === tab.id) {
      const replacement = this.tabsForScope(tab.scopeId)[0];
      if (replacement) this.activeTabIds.set(tab.scopeId, replacement.id);
      else this.activeTabIds.delete(tab.scopeId);
    }
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) {
      if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach();
      tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    for (const client of this.clients.values()) {
      if (client.scopeId === tab.scopeId) this.announceDestroyed(client, tab);
    }
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
        normalizeBrowserUrl(url);
        void this.createTab(url, true, tab.scopeId).catch((error) => console.error("[browser] 打开新标签页失败", error));
      } catch {
        // Keep unsupported protocols inside the browser sandbox.
      }
      return { action: "deny" };
    });
    const guardNavigation = (event: Electron.Event, url: string): void => {
      try {
        normalizeBrowserUrl(url);
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
      if (tab.scopeId === this.uiScopeId) this.publish();
      if (tab.announced) {
        for (const client of this.clients.values()) {
          if (client.scopeId === tab.scopeId) this.announceChanged(client, tab);
        }
      }
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
      const isUiActive = tab.scopeId === this.uiScopeId && tab.id === this.activeTabIds.get(this.uiScopeId);
      const active = isUiActive && nativeBounds.visible && bounds.width > 0 && bounds.height > 0;
      if (active) {
        tab.view.setBounds(bounds);
        tab.view.setVisible(true);
      } else if (isUiActive) {
        tab.view.setBounds(OFFSCREEN_VIEWPORT);
        tab.view.setVisible(true);
      } else {
        tab.view.setBounds(BACKGROUND_VIEWPORT);
        tab.view.setVisible(false);
      }
    }
  }

  private acceptClient(socket: WebSocket, mode: CdpClient["mode"], scopeId: string): void {
    const client: CdpClient = {
      id: randomUUID(), scopeId, mode, socket, discover: false, autoAttach: false,
      sessions: new Map(), directSessions: new Map(), childSessions: new Map(), debuggerListeners: new Map(),
    };
    this.clients.set(client.id, client);
    this.onAgentActivated(scopeId);
    for (const tab of this.tabsForScope(scopeId)) this.installDebuggerRelay(client, tab);
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
    client.directSessions.clear();
    client.childSessions.clear();
  }

  private installDebuggerRelay(client: CdpClient, tab: BrowserTab): void {
    if (client.scopeId !== tab.scopeId) return;
    if (client.debuggerListeners.has(tab.id)) return;
    const listener = (_event: Electron.Event, method: string, params: unknown, sessionId?: string): void => {
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
        // Every flat CDP session attached to this target receives its own copy
        // of page events. Lighthouse relies on those events while its
        // short-lived session is active.
        if (sessions?.pageAttached) this.send(client, { method, params: payload, sessionId: sessions.pageSessionId });
        for (const directSessionId of directSessionIds) this.send(client, { method, params: payload, sessionId: directSessionId });
      }
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
    if (kind === "direct" && request.method === "Target.detachFromTarget") {
      client.directSessions.delete(request.sessionId);
      return {};
    }
    if (request.method === "Browser.close") return {};
    if (request.method === "Browser.getWindowForTarget") return this.windowForTab(tab);
    if (request.method === "Browser.setContentsSize") return this.setContentsSize(tab, params);
    if (request.method === "Emulation.clearDeviceMetricsOverride") delete tab.emulatedSize;
    // Electron's page-level debugger does not currently expose Chrome's
    // experimental WebMCP domain. Puppeteer initializes it optimistically and
    // treats an unavailable domain as optional, but Electron can leave the
    // command pending instead of returning a method-not-found response. Reply
    // with an empty capability set so page initialization can finish.
    if (request.method === "WebMCP.enable" || request.method === "WebMCP.disable") return {};
    if (request.method === "WebMCP.invokeTool" || request.method === "WebMCP.cancelInvocation") {
      throw new Error("内置浏览器暂不支持网页注册的 WebMCP 工具。");
    }
    if (request.method === "Page.navigate" && typeof params.url === "string") {
      params.url = normalizeBrowserUrl(params.url);
    }
    this.attachDebugger(tab);
    const childSession = kind === "child" ? request.sessionId : undefined;
    try {
      const result = await tab.view.webContents.debugger.sendCommand(request.method, params, childSession);
      if (process.env.SUOCODE_BROWSER_CDP_LOG === "1") console.error("[browser-cdp] ✓", request.method, request.sessionId);
      return result;
    } catch (error) {
      if (process.env.SUOCODE_BROWSER_CDP_LOG === "1") console.error("[browser-cdp] ✗", request.method, error);
      throw error;
    }
  }

  private async executeRootCommand(client: CdpClient, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "SuoCode.getBrowserState") {
      await this.ensureActiveTab(client.scopeId);
      const activeTabId = this.activeTabIds.get(client.scopeId);
      return {
        activeTabId,
        activePageTargetId: activeTabId ? this.tabs.get(activeTabId)?.pageTargetId : undefined,
        tabs: this.tabsForScope(client.scopeId).map((tab) => ({
          id: tab.id,
          pageTargetId: tab.pageTargetId,
          title: tab.view.webContents.getTitle() || "新标签页",
          url: tab.view.webContents.getURL() || DEFAULT_URL,
          active: tab.id === activeTabId,
        })),
      };
    }
    if (method === "Target.getBrowserContexts") return { browserContextIds: [browserContextId(client.scopeId)] };
    if (method === "Browser.getVersion") {
      const tab = await this.ensureActiveTab(client.scopeId);
      this.installDebuggerRelay(client, tab);
      return tab.view.webContents.debugger.sendCommand(method, params);
    }
    if (method === "Target.setDiscoverTargets") {
      client.discover = params.discover === true;
      if (client.discover) {
        await this.ensureActiveTab(client.scopeId);
        this.announceAllTargets(client);
      }
      return {};
    }
    if (method === "Target.setAutoAttach") {
      client.autoAttach = params.autoAttach === true;
      if (client.autoAttach) for (const tab of this.tabsForScope(client.scopeId)) this.attachTab(client, tab);
      return {};
    }
    if (method === "Target.getTargets") return { targetInfos: this.allTargetInfos(client) };
    if (method === "Target.getTargetInfo") {
      const requestedId = typeof params.targetId === "string" ? params.targetId : BROWSER_TARGET_ID;
      return { targetInfo: this.findTargetInfo(requestedId, client.scopeId) };
    }
    if (method === "Target.createTarget") {
      const tab = await this.createCdpTab(typeof params.url === "string" ? params.url : undefined, params.background !== true, client.scopeId);
      // CDP's Target.createTarget returns the page target. The synthetic `tab`
      // target only exists to reproduce Chrome's parent/child auto-attach
      // hierarchy; returning it makes Puppeteer wait for a PageTarget that can
      // never be initialized and is the source of the 30 second new_page stall.
      return { targetId: tab.pageTargetId };
    }
    if (method === "Target.activateTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""), client.scopeId);
      if (tab) this.selectTab(tab.id, client.scopeId);
      return {};
    }
    if (method === "Target.closeTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""), client.scopeId);
      if (tab) this.closeTab(tab.id, client.scopeId);
      return { success: Boolean(tab) };
    }
    if (method === "Target.attachToTarget") {
      const tab = this.findTabByTarget(String(params.targetId ?? ""), client.scopeId);
      if (!tab) throw new Error("目标标签页不存在。");
      // Lighthouse and other consumers may open a temporary CDP session on a
      // page that Puppeteer already owns. Reusing Puppeteer's persistent tab
      // session means the temporary consumer's detach also invalidates the
      // persistent session, after which restore-emulation commands never
      // resolve. A real browser allocates a fresh flat session for every
      // explicit page attachment, so mirror that behavior here.
      if (params.targetId === tab.pageTargetId) {
        this.ensureClientSessions(client, tab);
        const sessionId = `direct-session-${client.id.slice(0, 8)}-${randomUUID()}`;
        client.directSessions.set(sessionId, tab.id);
        this.send(client, {
          method: "Target.attachedToTarget",
          params: { sessionId, targetInfo: targetInfo(tab, "page"), waitingForDebugger: false },
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
      const tab = this.findTabByWindowId(params.windowId, client.scopeId) ?? await this.ensureActiveTab(client.scopeId);
      return { bounds: this.windowBounds(tab) };
    }
    if (method === "Browser.setWindowBounds") {
      const tab = this.findTabByWindowId(params.windowId, client.scopeId) ?? await this.ensureActiveTab(client.scopeId);
      const bounds = params.bounds && typeof params.bounds === "object" ? params.bounds as Record<string, unknown> : {};
      if (typeof bounds.width === "number" && typeof bounds.height === "number") {
        await this.setContentsSize(tab, bounds);
      }
      return {};
    }
    if (method === "Browser.getWindowForTarget") {
      const requested = typeof params.targetId === "string" ? this.findTabByTarget(params.targetId, client.scopeId) : undefined;
      return this.windowForTab(requested ?? await this.ensureActiveTab(client.scopeId));
    }
    if (method === "Browser.setContentsSize") {
      const tab = this.findTabByWindowId(params.windowId, client.scopeId) ?? await this.ensureActiveTab(client.scopeId);
      return this.setContentsSize(tab, params);
    }
    const tab = await this.ensureActiveTab(client.scopeId);
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
    if (client.mode === "playwright") {
      if (sessions.pageAttached) return;
      sessions.pageAttached = true;
      this.send(client, {
        method: "Target.attachedToTarget",
        params: { sessionId: sessions.pageSessionId, targetInfo: targetInfo(tab, "page"), waitingForDebugger: false },
      });
      return;
    }
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
    for (const tab of this.tabsForScope(client.scopeId)) {
      if (client.mode === "devtools") this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "tab") } });
      this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "page") } });
    }
  }

  private announceCreated(tab: BrowserTab): void {
    if (!tab.announced) return;
    for (const client of this.clients.values()) {
      if (client.scopeId !== tab.scopeId) continue;
      this.installDebuggerRelay(client, tab);
      if (client.discover) {
        if (client.mode === "devtools") this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "tab") } });
        this.send(client, { method: "Target.targetCreated", params: { targetInfo: targetInfo(tab, "page") } });
      }
      if (client.autoAttach) this.attachTab(client, tab);
    }
  }

  private announceChanged(client: CdpClient, tab: BrowserTab): void {
    if (!client.discover) return;
    if (client.mode === "devtools") this.send(client, { method: "Target.targetInfoChanged", params: { targetInfo: targetInfo(tab, "tab") } });
    this.send(client, { method: "Target.targetInfoChanged", params: { targetInfo: targetInfo(tab, "page") } });
  }

  private announceDestroyed(client: CdpClient, tab: BrowserTab): void {
    const sessions = client.sessions.get(tab.id);
    if (sessions?.pageAttached) this.send(client, { method: "Target.detachedFromTarget", sessionId: sessions.tabSessionId, params: { sessionId: sessions.pageSessionId, targetId: tab.pageTargetId } });
    if (sessions && client.mode === "devtools") this.send(client, { method: "Target.detachedFromTarget", params: { sessionId: sessions.tabSessionId, targetId: tab.tabTargetId } });
    if (client.discover) {
      this.send(client, { method: "Target.targetDestroyed", params: { targetId: tab.pageTargetId } });
      if (client.mode === "devtools") this.send(client, { method: "Target.targetDestroyed", params: { targetId: tab.tabTargetId } });
    }
    client.sessions.delete(tab.id);
    for (const [sessionId, tabId] of client.directSessions) {
      if (tabId === tab.id) client.directSessions.delete(sessionId);
    }
    for (const [sessionId, tabId] of client.childSessions) {
      if (tabId === tab.id) client.childSessions.delete(sessionId);
    }
    const listener = client.debuggerListeners.get(tab.id);
    if (listener) tab.view.webContents.debugger.off("message", listener as never);
    client.debuggerListeners.delete(tab.id);
  }

  private tabForSession(client: CdpClient, sessionId: string): { tab: BrowserTab; sessions: ClientTabSessions; kind: "tab" | "page" | "direct" | "child" } | undefined {
    for (const [tabId, sessions] of client.sessions) {
      const tab = this.tabs.get(tabId);
      if (!tab || tab.scopeId !== client.scopeId) continue;
      if (sessions.tabSessionId === sessionId) return { tab, sessions, kind: "tab" };
      if (sessions.pageSessionId === sessionId) return { tab, sessions, kind: "page" };
    }
    const directTabId = client.directSessions.get(sessionId);
    const directTab = directTabId ? this.tabs.get(directTabId) : undefined;
    const directSessions = directTabId ? client.sessions.get(directTabId) : undefined;
    if (directTab?.scopeId === client.scopeId && directSessions) return { tab: directTab, sessions: directSessions, kind: "direct" };
    const childTabId = client.childSessions.get(sessionId);
    const childTab = childTabId ? this.tabs.get(childTabId) : undefined;
    const childSessions = childTabId ? client.sessions.get(childTabId) : undefined;
    return childTab?.scopeId === client.scopeId && childSessions ? { tab: childTab, sessions: childSessions, kind: "child" } : undefined;
  }

  private allTargetInfos(client?: CdpClient): Array<Record<string, unknown>> {
    const scopeId = client?.scopeId ?? this.uiScopeId;
    return [
      { targetId: BROWSER_TARGET_ID, type: "browser", title: "SuoCode", url: "", attached: true, canAccessOpener: false },
      ...this.tabsForScope(scopeId).flatMap((tab) => client?.mode === "playwright"
        ? [targetInfo(tab, "page")]
        : [targetInfo(tab, "tab"), targetInfo(tab, "page")]),
    ];
  }

  private findTargetInfo(id: string, scopeId: string): Record<string, unknown> {
    if (id === BROWSER_TARGET_ID) return this.allTargetInfos()[0];
    const tab = this.findTabByTarget(id, scopeId);
    if (!tab) throw new Error("目标不存在。");
    return targetInfo(tab, id === tab.tabTargetId ? "tab" : "page");
  }

  private findTabByTarget(id: string, scopeId: string): BrowserTab | undefined {
    return this.tabsForScope(scopeId).find((tab) => tab.tabTargetId === id || tab.pageTargetId === id);
  }

  private findTabByWindowId(value: unknown, scopeId: string): BrowserTab | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return this.tabsForScope(scopeId).find((tab) => tab.view.webContents.id === value);
  }

  private windowBounds(tab: BrowserTab): Record<string, unknown> {
    const visible = tab.emulatedSize ?? {
      width: Math.max(1, this.browserCssBounds.width || BACKGROUND_VIEWPORT.width),
      height: Math.max(1, this.browserCssBounds.height || BACKGROUND_VIEWPORT.height),
    };
    return { left: 0, top: 0, width: visible.width, height: visible.height, windowState: "normal" };
  }

  private windowForTab(tab: BrowserTab): Record<string, unknown> {
    return { windowId: tab.view.webContents.id, bounds: this.windowBounds(tab) };
  }

  private async setContentsSize(tab: BrowserTab, params: Record<string, unknown>): Promise<Record<string, never>> {
    const width = typeof params.width === "number" ? Math.round(params.width) : NaN;
    const height = typeof params.height === "number" ? Math.round(params.height) : NaN;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384) {
      throw new Error("浏览器视口尺寸无效。");
    }
    tab.emulatedSize = { width, height };
    this.attachDebugger(tab);
    await tab.view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return {};
  }

  private send(client: CdpClient, value: Record<string, unknown>): void {
    if (process.env.SUOCODE_BROWSER_CDP_LOG === "1") console.error("[browser-cdp] →", value.method ?? `#${value.id}`, value.sessionId ?? "root");
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(value));
  }
}
