import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BrowserWindow, session, webContents as webContentsRegistry, type WebContents } from "electron";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { BrowserGuestRoster, BrowserStateSnapshot, BrowserTabSnapshot } from "../shared/desktop-api";
import { BrowserGuestRegistry } from "./browser-guests";
import { normalizeBrowserUrl } from "./browser-navigation";
import { BROWSER_PARTITION } from "./browser-webview-policy";

const DEFAULT_URL = "about:blank";
const DEFAULT_SCOPE_ID = "default";
const BROWSER_TARGET_ID = "suocode-browser";
const BROWSER_CONTEXT_ID = "suocode-browser-context";
/**
 * Logical viewport for a tab the user is not looking at.
 *
 * A parked guest is a 1x1 element on screen, so without this every background
 * tab would report a 1x1 viewport to the page and to agents. Emulation gives it
 * a real size; the element stays tiny but composited, which is what keeps
 * Page.captureScreenshot working at all.
 */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

interface BrowserTab {
  id: string;
  scopeId: string;
  tabTargetId: string;
  pageTargetId: string;
  /** Set once the renderer reports the <webview> it created for this tab. */
  guest?: WebContents;
  /** Travels with the roster entry so a stale report cannot satisfy a newer slot. */
  guestNonce: string;
  phase: "awaiting-guest" | "loading" | "ready" | "closing";
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
  const contents = tab.guest!;
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
 * <webview> guests owned by SuoCode. No global remote-debugging port is
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
  private uiViewport = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
  /** False while the browser panel is hidden, so its tab parks like a background one. */
  private panelVisible = false;
  /** One in-flight creation per scope; see ensureActiveTab. */
  private readonly pendingEnsure = new Map<string, Promise<BrowserTab>>();
  private disposed = false;
  /** Correlates renderer-created <webview> guests with tab records. Unused until the switch. */
  private readonly guests = new BrowserGuestRegistry({
    expectedPartition: BROWSER_PARTITION,
    hostWebContentsId: () => this.window.webContents.id,
    inspect: (webContentsId) => {
      const contents = webContentsRegistry.fromId(webContentsId);
      if (!contents) return undefined;
      // Sessions are cached per partition string, so identity is an exact test
      // that the guest really was created in the browser's own session.
      const expected = session.fromPartition(BROWSER_PARTITION);
      return {
        hostWebContentsId: contents.hostWebContents?.id,
        type: contents.getType(),
        partition: contents.session === expected ? BROWSER_PARTITION : undefined,
        destroyed: contents.isDestroyed(),
      };
    },
  });
  private readonly handleHostNavigation = (
    _event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean,
  ): void => {
    if (isMainFrame) this.dropAllGuests();
  };
  private readonly handleHostGone = (): void => this.dropAllGuests();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publishState: (state: BrowserStateSnapshot) => void,
    private readonly onAgentActivated: (scopeId: string) => void,
    private readonly publishGuestRoster: (roster: BrowserGuestRoster) => void = () => {},
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
    // Guests live in the renderer's document, so a reload or crash destroys every
    // one of them. Tear the records down deliberately and tell clients their
    // targets are gone; resurrecting them under the old page target id would
    // leave Playwright with a permanently half-initialized Page.
    this.window.webContents.on("did-start-navigation", this.handleHostNavigation);
    this.window.webContents.on("render-process-gone", this.handleHostGone);
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
    this.refreshViewportOverrides();
    const state = this.state();
    this.publishState(state);
    return state;
  }

  async createTab(rawUrl?: string, activate = true, scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    await this.createCdpTab(rawUrl, activate, scopeId);
    return this.state(scopeId);
  }

  /**
   * Reserve the tab synchronously, before any await.
   *
   * The guest itself is created by the renderer, which is asynchronous, but the
   * record and its claim on activeTabIds must land in this turn: ensureActiveTab
   * has thirteen callers that would otherwise each start their own tab while the
   * first was still in flight. The tab is quarantined until its page commits —
   * announced stays false and pageTargetId is a placeholder — so no CDP client
   * can see a target that has no WebContents behind it yet.
   */
  private createTabRecord(activate: boolean, scopeId: string): BrowserTab {
    const id = randomUUID();
    const tab: BrowserTab = {
      id,
      scopeId,
      tabTargetId: `tab-${id}`,
      pageTargetId: `pending-page-${id}`,
      guestNonce: randomBytes(16).toString("hex"),
      phase: "awaiting-guest",
      announced: false,
    };
    this.tabs.set(id, tab);
    if (activate || !this.activeTabIds.has(scopeId)) this.activeTabIds.set(scopeId, id);
    // The tab strip shows a placeholder immediately, and the roster tells the
    // renderer to mint the element this tab is waiting for.
    this.publish();
    this.publishRoster();
    return tab;
  }

  /**
   * Wait for the renderer to create and report this tab's <webview>, then wire it
   * up in the same order the main-process view used: security, events, debugger —
   * all before the first navigation.
   */
  private async attachGuest(tab: BrowserTab): Promise<void> {
    const webContentsId = await this.guests.expectGuest(tab.id, tab.guestNonce)
      .catch(async (error: unknown) => {
        // A guest cannot arrive if the layer never mounted; report that instead.
        await this.guests.waitForLayer();
        throw error;
      });
    const guest = webContentsRegistry.fromId(webContentsId);
    if (!guest || guest.isDestroyed()) throw new Error("内置浏览器视图已失效。");
    if (tab.phase === "closing" || !this.tabs.has(tab.id)) throw new Error("标签页已关闭。");
    tab.guest = guest;
    tab.phase = "loading";
    this.installTabSecurity(tab);
    this.installTabEvents(tab);
    this.installGuestTeardown(tab, guest);
    this.attachDebugger(tab);
    await this.applyViewportOverride(tab);
  }

  /**
   * Give a parked guest a real logical viewport.
   *
   * A parked guest is a 1x1 element, and a guest hidden any other way stops
   * compositing — which makes Page.captureScreenshot hang forever. Keeping it
   * tiny but on screen and overriding the metrics is what lets an agent drive and
   * screenshot a tab the user is not looking at.
   *
   * The visible tab must NOT carry this override: its element is already the size
   * of the panel, and forcing 1280x720 on top would render the page wider than the
   * space it is drawn into and clip it.
   */
  private async applyViewportOverride(tab: BrowserTab): Promise<void> {
    if (tab.emulatedSize) return;
    const guest = tab.guest;
    if (!guest || guest.isDestroyed()) return;
    const parked = !this.panelVisible
      || tab.scopeId !== this.uiScopeId
      || tab.id !== this.activeTabIds.get(this.uiScopeId);
    try {
      if (!parked) {
        // Let the element's own box drive layout again.
        await guest.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
        return;
      }
      await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
        screenWidth: DEFAULT_VIEWPORT.width,
        screenHeight: DEFAULT_VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch (error) {
      console.error("[browser] 设置视口失败", error);
    }
  }

  /** Re-evaluate every tab's viewport after the visible tab changes. */
  private refreshViewportOverrides(): void {
    for (const tab of this.tabs.values()) {
      if (tab.phase === "closing" || !tab.guest) continue;
      void this.applyViewportOverride(tab);
    }
  }

  /** A guest can die on its own — renderer reload, crash, or element removal. */
  private installGuestTeardown(tab: BrowserTab, guest: WebContents): void {
    guest.once("destroyed", () => {
      if (this.tabs.get(tab.id) !== tab) return;
      this.closeTabRecord(tab);
      this.publish();
    });
  }

  private async finishTabCreation(tab: BrowserTab): Promise<void> {
    await this.refreshPageTargetIdentity(tab);
    tab.phase = "ready";
    tab.announced = true;
    this.refreshViewportOverrides();
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
    const result = await this.guestOf(tab).debugger.sendCommand("Target.getTargetInfo") as {
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
      await this.attachGuest(tab);
      await tab.guest!.loadURL(url);
      await this.finishTabCreation(tab);
    } catch (error) {
      this.closeTabRecord(tab);
      this.publish();
      throw error;
    }
    return tab;
  }

  /**
   * Creation is asynchronous now, so concurrent callers must share one attempt:
   * every CDP root command funnels through here, and a fresh client typically
   * issues several at once.
   */
  async ensureActiveTab(scopeId = this.uiScopeId): Promise<BrowserTab> {
    const active = this.readyTab(scopeId);
    if (active) return active;
    const inFlight = this.pendingEnsure.get(scopeId);
    if (inFlight) return inFlight;
    const attempt = this.createCdpTab(undefined, true, scopeId)
      .finally(() => {
        if (this.pendingEnsure.get(scopeId) === attempt) this.pendingEnsure.delete(scopeId);
      });
    this.pendingEnsure.set(scopeId, attempt);
    return attempt;
  }

  selectTab(id: string, scopeId = this.uiScopeId): BrowserStateSnapshot {
    if (this.tabs.get(id)?.scopeId !== scopeId) throw new Error("浏览器标签页不存在。");
    this.activeTabIds.set(scopeId, id);
    this.refreshViewportOverrides();
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
      // The promoted tab is now the visible one and must drop its parked viewport.
      this.refreshViewportOverrides();
    }
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
      this.publish();
    }
  }

  async navigate(rawUrl: string, scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    await this.guestOf(tab).loadURL(normalizeBrowserUrl(rawUrl));
    return this.state(scopeId);
  }

  async back(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    const history = this.guestOf(tab).navigationHistory;
    if (history.canGoBack()) history.goBack();
    return this.state(scopeId);
  }

  async forward(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    const history = this.guestOf(tab).navigationHistory;
    if (history.canGoForward()) history.goForward();
    return this.state(scopeId);
  }

  async reload(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    this.guestOf(tab).reload();
    return this.state(scopeId);
  }

  /**
   * The visible size of the browser panel, reported by the renderer.
   *
   * Replaces the old bounds pump: positioning is CSS now, but Browser.getWindowBounds
   * and chrome-devtools-mcp's resize_page still need to know how big the page the
   * user is looking at actually is.
   */
  setUiViewport(viewport: { width: number; height: number }): void {
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    const hidden = !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0;
    // A zero size means the panel is hidden, so the active tab is parked like any
    // other and needs the override back to stay screenshot-able.
    if (this.panelVisible === !hidden) {
      if (!hidden) this.uiViewport = { width, height };
      return;
    }
    this.panelVisible = !hidden;
    if (!hidden) this.uiViewport = { width, height };
    this.refreshViewportOverrides();
  }

  /**
   * The `<webview>` elements the renderer must keep mounted. Carries no URL and no
   * scope id, so the app document never holds an agent's browsing state.
   *
   * Empty until the switch to guest-backed tabs; the layer and its IPC land first
   * so the handshake can be exercised before anything depends on it.
   */
  guestRoster(): BrowserGuestRoster {
    return {
      tabs: [...this.tabs.values()]
        .filter((tab) => tab.phase !== "closing")
        .map((tab) => ({ tabId: tab.id, nonce: tab.guestNonce })),
    };
  }

  /** The renderer's guest layer has mounted and can create elements. */
  markGuestLayerReady(): BrowserGuestRoster {
    this.guests.markLayerReady();
    return this.guestRoster();
  }

  /** Push the roster after the tab set changes so the renderer mints or drops elements. */
  private publishRoster(): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.publishGuestRoster(this.guestRoster());
  }

  registerGuest(tabId: string, nonce: string, webContentsId: number): void {
    this.guests.register(tabId, nonce, webContentsId);
  }

  /** The renderer that owned every guest went away; close the records it backed. */
  private dropAllGuests(): void {
    if (this.disposed) return;
    this.guests.markLayerGone();
    const tabs = [...this.tabs.values()];
    if (tabs.length === 0) return;
    for (const tab of tabs) this.closeTabRecord(tab);
    this.publish();
  }

  reportGuestFailure(tabId: string, nonce: string, reason: string): void {
    this.guests.fail(tabId, nonce, reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.guests.dispose();
    if (!this.window.isDestroyed()) {
      this.window.webContents.off("did-start-navigation", this.handleHostNavigation);
      this.window.webContents.off("render-process-gone", this.handleHostGone);
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

  /**
   * Tabs a CDP client is allowed to see. A tab exists internally before its page
   * has committed, while its target id is still a placeholder; announcing one
   * would hand Playwright a `pending-page-` id it can never resolve. Every path
   * that enumerates or resolves targets for a client must filter through here —
   * `tabsForScope` stays for the UI, which does show tabs while they load.
   */
  private cdpTabs(scopeId: string): BrowserTab[] {
    return this.tabsForScope(scopeId).filter((tab) => tab.announced);
  }

  private activeTab(scopeId: string): BrowserTab | undefined {
    const id = this.activeTabIds.get(scopeId);
    return id ? this.tabs.get(id) : undefined;
  }

  /** The active tab only when it can actually serve a command. */
  private readyTab(scopeId: string): BrowserTab | undefined {
    const tab = this.activeTab(scopeId);
    if (!tab || tab.phase !== "ready") return undefined;
    return tab.guest && !tab.guest.isDestroyed() ? tab : undefined;
  }

  /** The guest behind a tab, or a clear error rather than a null dereference. */
  private guestOf(tab: BrowserTab): WebContents {
    if (!tab.guest || tab.guest.isDestroyed()) throw new Error("内置浏览器视图不可用。");
    return tab.guest;
  }

  private closeTabRecord(tab: BrowserTab): void {
    tab.phase = "closing";
    if (!this.tabs.delete(tab.id)) return;
    if (this.activeTabIds.get(tab.scopeId) === tab.id) {
      const replacement = this.tabsForScope(tab.scopeId)[0];
      if (replacement) this.activeTabIds.set(tab.scopeId, replacement.id);
      else this.activeTabIds.delete(tab.scopeId);
    }
    // Frees the pending reservation and the guest binding; a late registration
    // for this tab is then refused rather than silently bound.
    this.guests.release(tab.id);
    const guest = tab.guest;
    if (guest && !guest.isDestroyed()) {
      if (guest.debugger.isAttached()) guest.debugger.detach();
      // beforeunload must not let a page keep an agent's tab alive.
      guest.close({ waitForBeforeUnload: false });
    }
    tab.guest = undefined;
    // Announce before the roster drops the element, so clients see the target
    // destroyed while its session bookkeeping is still intact.
    for (const client of this.clients.values()) {
      if (client.scopeId === tab.scopeId) this.announceDestroyed(client, tab);
    }
    this.publishRoster();
  }

  private tabSnapshot(tab: BrowserTab): BrowserTabSnapshot {
    const contents = tab.guest;
    // A tab exists in the strip while its guest is still being created.
    if (!contents || contents.isDestroyed()) {
      return { id: tab.id, title: "新标签页", url: DEFAULT_URL, loading: true, canGoBack: false, canGoForward: false };
    }
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
    const contents = this.guestOf(tab);
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
    const contents = this.guestOf(tab);
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
    const debug = this.guestOf(tab).debugger;
    if (!debug.isAttached()) debug.attach("1.3");
  }

  private acceptClient(socket: WebSocket, mode: CdpClient["mode"], scopeId: string): void {
    const client: CdpClient = {
      id: randomUUID(), scopeId, mode, socket, discover: false, autoAttach: false,
      sessions: new Map(), directSessions: new Map(), childSessions: new Map(), debuggerListeners: new Map(),
    };
    this.clients.set(client.id, client);
    this.onAgentActivated(scopeId);
    for (const tab of this.cdpTabs(scopeId)) this.installDebuggerRelay(client, tab);
    socket.on("message", (data) => { void this.handleClientMessage(client, data); });
    socket.once("close", () => this.removeClient(client));
    socket.once("error", () => this.removeClient(client));
  }

  private removeClient(client: CdpClient): void {
    if (!this.clients.delete(client.id)) return;
    for (const [tabId, listener] of client.debuggerListeners) {
      const tab = this.tabs.get(tabId);
      tab?.guest?.debugger.off("message", listener as never);
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
    this.guestOf(tab).debugger.on("message", listener);
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
    if (request.method === "Emulation.clearDeviceMetricsOverride") {
      // Clearing outright would drop the guest back to its 1x1 element box, so
      // restore the default logical viewport instead of leaving it unusable.
      delete tab.emulatedSize;
      await this.applyViewportOverride(tab);
      return {};
    }
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
      const result = await this.guestOf(tab).debugger.sendCommand(request.method, params, childSession);
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
        tabs: this.cdpTabs(client.scopeId).map((tab) => ({
          id: tab.id,
          pageTargetId: tab.pageTargetId,
          title: tab.guest?.getTitle() || "新标签页",
          url: tab.guest?.getURL() || DEFAULT_URL,
          active: tab.id === activeTabId,
        })),
      };
    }
    if (method === "Target.getBrowserContexts") return { browserContextIds: [browserContextId(client.scopeId)] };
    if (method === "Browser.getVersion") {
      const tab = await this.ensureActiveTab(client.scopeId);
      this.installDebuggerRelay(client, tab);
      return this.guestOf(tab).debugger.sendCommand(method, params);
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
      if (client.autoAttach) for (const tab of this.cdpTabs(client.scopeId)) this.attachTab(client, tab);
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
    return this.guestOf(tab).debugger.sendCommand(method, params);
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
    for (const tab of this.cdpTabs(client.scopeId)) {
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
    if (listener) tab.guest?.debugger.off("message", listener as never);
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
      ...this.cdpTabs(scopeId).flatMap((tab) => client?.mode === "playwright"
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
    return this.cdpTabs(scopeId).find((tab) => tab.tabTargetId === id || tab.pageTargetId === id);
  }

  private findTabByWindowId(value: unknown, scopeId: string): BrowserTab | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return this.cdpTabs(scopeId).find((tab) => tab.guest?.id === value);
  }

  private windowBounds(tab: BrowserTab): Record<string, unknown> {
    const visible = tab.emulatedSize ?? {
      width: Math.max(1, this.uiViewport.width),
      height: Math.max(1, this.uiViewport.height),
    };
    return { left: 0, top: 0, width: visible.width, height: visible.height, windowState: "normal" };
  }

  private windowForTab(tab: BrowserTab): Record<string, unknown> {
    return { windowId: this.guestOf(tab).id, bounds: this.windowBounds(tab) };
  }

  private async setContentsSize(tab: BrowserTab, params: Record<string, unknown>): Promise<Record<string, never>> {
    const width = typeof params.width === "number" ? Math.round(params.width) : NaN;
    const height = typeof params.height === "number" ? Math.round(params.height) : NaN;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384) {
      throw new Error("浏览器视口尺寸无效。");
    }
    tab.emulatedSize = { width, height };
    this.attachDebugger(tab);
    await this.guestOf(tab).debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
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
