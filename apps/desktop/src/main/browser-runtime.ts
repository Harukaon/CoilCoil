import { randomBytes, randomUUID } from "node:crypto";
import { BrowserWindow, session, webContents as webContentsRegistry, type WebContents } from "electron";
import type { BrowserGuestRoster, BrowserStateSnapshot, BrowserTabSnapshot } from "../shared/desktop-api";
import { captureGuestFrame } from "./browser-capture";
import { BrowserCdpBridge } from "./browser-cdp-bridge";
import { BrowserGuestRegistry } from "./browser-guests";
import { fillSavedCredentials } from "./browser-import";
import { loadGuestUrl, normalizeBrowserUrl } from "./browser-navigation";
import { applyGuestUserAgent } from "./browser-user-agent";
import {
  DEFAULT_BROWSER_SCOPE_ID as DEFAULT_SCOPE_ID,
  DEFAULT_BROWSER_URL as DEFAULT_URL,
  DEFAULT_BROWSER_VIEWPORT as DEFAULT_VIEWPORT,
  type BrowserTab,
} from "./browser-runtime-types";
import { BROWSER_PARTITION } from "./browser-webview-policy";

/**
 * 缩放挡位，和 Chrome 的一样。
 *
 * 用挡位而不是任意小数：每一挡都是设计上站得住的字号，用户按一下就换一挡，不会
 * 停在 103% 这种既不整齐、字形也发虚的地方。
 */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/**
 * Owns CoilCoil browser tabs, guest WebContents and renderer-facing state.
 * Browser-level CDP protocol adaptation lives in BrowserCdpBridge.
 */
export class BrowserRuntimeManager {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly cdp: BrowserCdpBridge;
  private readonly activeTabIds = new Map<string, string>();
  private uiScopeId = DEFAULT_SCOPE_ID;
  private uiViewport = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
  /** 每个作用域自己的缩放倍数；1 不存，省得到处判断默认值。 */
  private readonly zoomFactors = new Map<string, number>();
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
    this.cdp = new BrowserCdpBridge({
      onAgentActivated: (scopeId) => this.onAgentActivated(scopeId),
      ensureActiveTab: (scopeId) => this.ensureActiveTab(scopeId),
      createTab: (rawUrl, activate, scopeId) => this.createCdpTab(rawUrl, activate, scopeId),
      selectTab: (id, scopeId) => { this.selectTab(id, scopeId); },
      closeTab: (id, scopeId) => { this.closeTab(id, scopeId); },
      cdpTabs: (scopeId) => this.cdpTabs(scopeId),
      tabById: (id) => this.tabs.get(id),
      guestOf: (tab) => this.guestOf(tab),
      attachDebugger: (tab) => this.attachDebugger(tab),
      applyViewportOverride: (tab) => this.applyViewportOverride(tab),
      windowBounds: (tab) => this.windowBounds(tab),
      windowForTab: (tab) => this.windowForTab(tab),
      setContentsSize: (tab, params) => this.setContentsSize(tab, params),
    });
    // Guests live in the renderer's document, so a reload or crash destroys every
    // one of them. Tear the records down deliberately and tell clients their
    // targets are gone; resurrecting them under an old page target id would
    // leave any CDP client attached to stale execution contexts.
    this.window.webContents.on("did-start-navigation", this.handleHostNavigation);
    this.window.webContents.on("render-process-gone", this.handleHostGone);
  }

  get token(): string {
    return this.cdp.token;
  }

  /** What an agent asked the browser to do most recently. See the bridge's ring. */
  recentCdpCommands(): Array<{ method: string; msAgo: number }> {
    return this.cdp.recentCommands();
  }

  async start(): Promise<void> {
    await this.cdp.start();
  }

  endpoint(): string {
    return this.cdp.endpoint();
  }

  state(scopeId = this.uiScopeId): BrowserStateSnapshot {
    return {
      scopeId,
      tabs: this.tabsForScope(scopeId).map((tab) => this.tabSnapshot(tab)),
      activeTabId: this.activeTabIds.get(scopeId),
      zoom: this.zoomFor(scopeId),
    };
  }

  setUiScope(scopeId: string): BrowserStateSnapshot {
    this.uiScopeId = scopeId.trim() || DEFAULT_SCOPE_ID;
    this.refreshViewportOverrides();
    const state = this.state();
    this.publishState(state);
    return state;
  }

  private zoomFor(scopeId: string): number {
    return this.zoomFactors.get(scopeId) ?? 1;
  }

  /**
   * 一次动一挡。
   *
   * 缩放是整个内置浏览器的，不是某一个标签页的：这个作用域里现在开着的标签、之后
   * 新开的标签，看到的都是同一个字号——用户调的是「这个浏览器的字太小了」，不是
   * 「这一页的字太小了」。
   */
  setZoom(step: "in" | "out" | "reset", scopeId = this.uiScopeId): BrowserStateSnapshot {
    const current = this.zoomFor(scopeId);
    const index = ZOOM_STEPS.indexOf(current);
    const next = step === "reset"
      ? 1
      : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (index < 0 ? ZOOM_STEPS.indexOf(1) : index) + (step === "in" ? 1 : -1)))];
    if (next === 1) this.zoomFactors.delete(scopeId);
    else this.zoomFactors.set(scopeId, next);
    for (const tab of this.tabsForScope(scopeId)) this.applyZoom(tab);
    const state = this.state(scopeId);
    if (scopeId === this.uiScopeId) this.publishState(state);
    return state;
  }

  /**
   * Chromium 记的是「这个站点的缩放」，换一个站点就回到默认，所以每次导航完都要
   * 再落一次；否则用户放大过的浏览器一点链接就变回原样。
   */
  private applyZoom(tab: BrowserTab): void {
    const guest = tab.guest;
    if (!guest || guest.isDestroyed()) return;
    guest.setZoomFactor(this.zoomFor(tab.scopeId));
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
  private createTabRecord(activate: boolean, scopeId: string, implicit = false): BrowserTab {
    const id = randomUUID();
    const tab: BrowserTab = {
      id,
      scopeId,
      tabTargetId: `tab-${id}`,
      pageTargetId: `pending-page-${id}`,
      guestNonce: randomBytes(16).toString("hex"),
      phase: "awaiting-guest",
      announced: false,
      ...implicit ? { implicit: true } : {},
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
    await this.attachDebugger(tab);
    await this.applyViewportOverride(tab);
    this.applyZoom(tab);
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
    this.cdp.announceCreated(tab);
    this.publish();
  }

  /**
   * Use Chromium's real page target id instead of inventing one.
   *
   * Chrome DevTools MCP uses Puppeteer, which correlates the page target, its
   * main frame and execution contexts while constructing a Page. A synthetic
   * target id can leave that Page permanently half-initialized.
   * Electron exposes the real identity through the debugger attached to this
   * exact WebContents, so using it preserves Puppeteer's invariants and
   * CoilCoil's single-WebContents isolation boundary.
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

  private async createCdpTab(rawUrl: string | undefined, activate: boolean, scopeId: string, implicit = false): Promise<BrowserTab> {
    const url = normalizeBrowserUrl(rawUrl);
    const tab = this.createTabRecord(activate, scopeId, implicit);
    try {
      await this.attachGuest(tab);
      await loadGuestUrl(tab.guest!, url);
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
    const attempt = this.createCdpTab(undefined, true, scopeId, true)
      .finally(() => {
        if (this.pendingEnsure.get(scopeId) === attempt) this.pendingEnsure.delete(scopeId);
      });
    this.pendingEnsure.set(scopeId, attempt);
    return attempt;
  }

  /** Frames of the active tab, for a remote client that cannot host the view. */
  async captureTab(scopeId = this.uiScopeId): Promise<string | undefined> {
    return captureGuestFrame(this.activeTab(scopeId)?.guest);
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
    this.cdp.releaseScope(scopeId);
    for (const tab of this.tabsForScope(scopeId)) this.closeTabRecord(tab);
    this.activeTabIds.delete(scopeId);
    if (this.uiScopeId === scopeId) {
      this.publish();
    }
  }

  async navigate(rawUrl: string, scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.ensureActiveTab(scopeId);
    await loadGuestUrl(this.guestOf(tab), normalizeBrowserUrl(rawUrl));
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
    for (const tab of [...this.tabs.values()]) this.closeTabRecord(tab);
    await this.cdp.dispose();
  }

  private tabsForScope(scopeId: string): BrowserTab[] {
    return [...this.tabs.values()].filter((tab) => tab.scopeId === scopeId);
  }

  /**
   * Tabs a CDP client is allowed to see. A tab exists internally before its page
   * has committed, while its target id is still a placeholder; announcing one
   * would hand a CDP client a `pending-page-` id it can never resolve. Every path
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
    // Notify CDP clients while the guest still exists, so relay listeners can be
    // detached from the exact debugger they were registered on.
    this.cdp.announceDestroyed(tab);
    const guest = tab.guest;
    if (guest && !guest.isDestroyed()) {
      if (guest.debugger.isAttached()) guest.debugger.detach();
      // beforeunload must not let a page keep an agent's tab alive.
      guest.close({ waitForBeforeUnload: false });
    }
    tab.guest = undefined;
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
      if (tab.announced) this.cdp.announceChanged(tab);
    };
    contents.on("did-start-loading", update);
    contents.on("did-stop-loading", update);
    contents.on("page-title-updated", update);
    contents.on("did-navigate", () => {
      this.applyZoom(tab);
      update();
    });
    contents.on("did-navigate-in-page", update);
    // A login form is only worth filling once the document exists; anything the
    // user has already typed is left alone by the fill itself.
    contents.on("dom-ready", () => fillSavedCredentials(contents));
    contents.on("render-process-gone", update);
  }

  /** 返回的 promise 是给第一次导航用的：身份必须在导航发出之前盖上（见 attachGuest）。 */
  private attachDebugger(tab: BrowserTab): Promise<void> {
    const debug = this.guestOf(tab).debugger;
    if (debug.isAttached()) return Promise.resolve();
    debug.attach("1.3");
    return applyGuestUserAgent(debug);
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

}
