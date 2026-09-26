import { randomBytes, randomUUID } from "node:crypto";
import { app, BrowserWindow, screen, session, webContents as webContentsRegistry, type Session, type WebContents } from "electron";
import type { BrowserElementSelection, BrowserGuestRoster, BrowserPageEvent, BrowserStateSnapshot, BrowserTabSnapshot } from "../shared/desktop-api";
import { AGENT_TAB_LIMIT, agentTabsToRecycle, RecycledAgentTabs, type BrowserTabControl, type BrowserTabOwner } from "./browser-agent-tabs";
import { captureGuestFrame } from "./browser-capture";
import { BrowserCdpBridge } from "./browser-cdp-bridge";
import { BrowserElementPicker } from "./browser-element-picker";
import { BrowserGuestRegistry } from "./browser-guests";
import { fillSavedCredentials } from "./browser-import";
import { cssCursor, PageInputForwarder, parsePageInput } from "./browser-input";
import { loadGuestUrl, normalizeBrowserUrl } from "./browser-navigation";
import { createOffscreenPage, OffscreenFrameStream, resizeOffscreenPage } from "./browser-offscreen";
import { applyGuestUserAgent, browserIdentityEnvironment, configureBrowserIdentity, installChromeObject } from "./browser-user-agent";
import {
  DEFAULT_BROWSER_SCOPE_ID as DEFAULT_SCOPE_ID,
  DEFAULT_BROWSER_URL as DEFAULT_URL,
  DEFAULT_BROWSER_VIEWPORT as DEFAULT_VIEWPORT,
  isReusableBlankTab,
  orderTabsForUi,
  type BrowserTab,
} from "./browser-runtime-types";
import { BROWSER_PARTITION, browserPartitionFor } from "./browser-webview-policy";

/**
 * 缩放挡位，和 Chrome 的一样。
 *
 * 用挡位而不是任意小数：每一挡都是设计上站得住的字号，用户按一下就换一挡，不会
 * 停在 103% 这种既不整齐、字形也发虚的地方。
 */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** 同时记住几个网页版/手机正看着的会话；多出来的按最早打开的先忘。 */
const REMOTE_SCOPE_LIMIT = 8;

/**
 * Owns CoilCoil browser tabs, guest WebContents and renderer-facing state.
 * Browser-level CDP protocol adaptation lives in BrowserCdpBridge.
 */
/**
 * 这台机器屏幕的真实尺寸。
 *
 * 后台标签页要靠 `setDeviceMetricsOverride` 拿到一个像样的视口才能截图，但那条命令
 * 会把 `screen` 一起改掉。原来传的是视口自己的尺寸，于是页面看到的是「屏幕正好
 * 1280×720、像素比 1」——屏幕和视口一模一样，这在真机上不会发生，是自动化最容易被
 * 认出来的一处。视口照旧，屏幕报真的。
 */
function realScreenMetrics(): { screenWidth: number; screenHeight: number } {
  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    return { screenWidth: width, screenHeight: height };
  } catch {
    return { screenWidth: 1920, screenHeight: 1080 };
  }
}

export class BrowserRuntimeManager {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly cdp: BrowserCdpBridge;
  private readonly elementPicker = new BrowserElementPicker();
  private readonly activeTabIds = new Map<string, string>();
  private uiScopeId = DEFAULT_SCOPE_ID;
  /**
   * 网页版、手机正看着的会话。它们和桌面窗口不是一个界面：只登记在这里，决定哪些会话
   * 的标签页变化要推过去；不能去改 uiScopeId，那是桌面窗口的——以前改了，网页版一打开
   * 别的会话，桌面这边就收不到自己会话的更新、画面也跟着停了。远程请求不带客户端身份，
   * 所以只按先后留最近几个。
   */
  private readonly remoteScopeIds = new Set<string>();
  private uiViewport = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
  /** 每个作用域自己的缩放倍数；1 不存，省得到处判断默认值。 */
  private readonly zoomFactors = new Map<string, number>();
  /** False while the browser panel is hidden, so its tab parks like a background one. */
  private panelVisible = false;
  /**
   * 界面当前所在工作区的 cookie jar：导入、统计、清空都冲它去。
   *
   * 它只决定「现在新开的标签页用哪份」，不决定已经开着的：那些各自记着自己的
   * jar（见 BrowserTab.partition），切工作区时一个都不动。
   */
  private partition = BROWSER_PARTITION;
  /**
   * 每个作用域（也就是每个会话）属于哪份 jar。
   *
   * 后台会话的 Agent 照样在开标签页、点页面，它开出来的标签页必须用它自己那个工作
   * 区的登录状态，而不是界面此刻正看着的那个工作区的。界面切走不影响它。
   */
  private readonly scopePartitions = new Map<string, string>();
  /** 已经配过身份（UA）的 jar，配一次就够。 */
  private readonly identityReady = new Set<string>();
  /** One in-flight creation per scope; see ensureActiveTab. */
  private readonly pendingEnsure = new Map<string, Promise<BrowserTab>>();
  /** 每个会话还没告诉 Agent 的回收记录。 */
  private readonly recycledTabs = new RecycledAgentTabs();
  /** 每张页面一个：把用户的操作按到达顺序送进去（见 browser-input.ts）。 */
  private readonly inputForwarders = new WeakMap<WebContents, PageInputForwarder>();
  /** 用户正看着的那张 Agent 标签页的画面，送给界面。 */
  private readonly frames = new OffscreenFrameStream((frame) => {
    if (!this.disposed && !this.window.isDestroyed()) this.window.webContents.send("browser:frame", frame);
  });
  private disposed = false;
  /** Correlates renderer-created <webview> guests with tab records. Unused until the switch. */
  private readonly guests = new BrowserGuestRegistry({
    hostWebContentsId: () => this.window.webContents.id,
    inspect: (webContentsId, expected) => {
      const contents = webContentsRegistry.fromId(webContentsId);
      if (!contents) return undefined;
      // Sessions are cached per partition string, so identity is an exact test
      // that the guest really was created in the browser's own session.
      // Electron 不肯说一个 session 叫什么名字，只能拿「是不是这一份」来问。
      const expectedSession = session.fromPartition(expected);
      return {
        hostWebContentsId: contents.hostWebContents?.id,
        type: contents.getType(),
        partition: contents.session === expectedSession ? expected : undefined,
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
    /** 在 App 窗口里弹出网页的右键菜单（菜单本身由主进程入口搭，和 <webview> 的是同一份）。 */
    private readonly showPageContextMenu: (contents: WebContents, params: Electron.ContextMenuParams) => void = () => {},
  ) {
    this.cdp = new BrowserCdpBridge({
      onAgentActivated: (scopeId) => this.onAgentActivated(scopeId),
      ensureActiveTab: (scopeId) => this.ensureAgentTab(scopeId),
      createTab: (rawUrl, activate, scopeId) => this.createCdpTab(rawUrl, activate, scopeId, false, "agent"),
      userTabs: (scopeId) => this.userTabsFor(scopeId),
      anyReadyTab: (scopeId) => {
        const ready = this.tabsForScope(scopeId).filter((tab) => tab.phase === "ready" && tab.guest && !tab.guest.isDestroyed());
        return ready.find((tab) => tab.control === "agent") ?? ready[0];
      },
      blankPlaceholder: (scopeId) => this.tabsForScope(scopeId).find((tab) =>
        tab.guest && !tab.guest.isDestroyed() && isReusableBlankTab(tab, tab.guest.getURL())),
      takeOverForAgent: (id, scopeId) => this.takeOverForAgent(id, scopeId),
      noteAgentUse: (tab) => { tab.lastUsedAt = Date.now(); },
      takeRecycledTabs: (scopeId) => this.recycledTabs.take(scopeId),
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
      setAgentFocusEmulation: (tab, enabled) => this.setFocusEmulation(tab, "agent", enabled),
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

  /**
   * 用户只看到当前工作区的标签页。
   *
   * CDP 发现仍然按 scope 隔离，后台 Agent 可以继续操作自己的页面；界面快照也按同一
   * 个 scope 过滤，避免切换挂载文件夹时把别的工作区的页面显示成当前页面。
   */
  state(scopeId = this.uiScopeId): BrowserStateSnapshot {
    return {
      scopeId,
      tabs: orderTabsForUi(this.tabs.values(), scopeId)
        .map(({ tab }) => this.tabSnapshot(tab)),
      activeTabId: this.activeTab(scopeId)?.id,
      zoom: this.zoomFor(scopeId),
    };
  }

  /** 当前这个窗口用的 cookie jar，供主进程给 guest 定分区、给导入/清除定目标。 */
  partitionName(): string {
    return this.partition;
  }

  /** 这个 jar 的 session：登录状态的导入、统计和清除都冲它去。 */
  browserSession(): Session {
    return session.fromPartition(this.partition);
  }

  /**
   * 记下某个会话属于哪个工作区，并保证那份 jar 的身份配好了。
   *
   * 界面切走之后，后台那个会话的 Agent 还在开页面、点东西——它开的标签页要落在它
   * 自己工作区那份 cookie 里。所以这个对应关系按会话记，跟界面看的是哪个无关。
   */
  noteScopeWorkspace(scopeId: string, workspacePath?: string): void {
    const scope = scopeId.trim();
    if (!scope || !workspacePath) return;
    const partition = browserPartitionFor(workspacePath);
    this.scopePartitions.set(scope, partition);
    this.prepareIdentity(partition);
  }

  /** 新标签页该落在哪份 jar：先看它所属的会话，再退回界面当前这个工作区。 */
  private partitionForScope(scopeId: string): string {
    return this.scopePartitions.get(scopeId) ?? this.partition;
  }

  private prepareIdentity(partition: string): void {
    if (this.identityReady.has(partition)) return;
    this.identityReady.add(partition);
    configureBrowserIdentity(session.fromPartition(partition), browserIdentityEnvironment(app.getLocale()));
  }

  /** 这个窗口现在认哪些 jar：已经开着的标签页那些，加上界面当前这个工作区的。 */
  expectsPartition(partition: unknown): boolean {
    if (typeof partition !== "string" || !partition) return false;
    if (partition === this.partition) return true;
    for (const tab of this.tabs.values()) if (tab.partition === partition) return true;
    for (const value of this.scopePartitions.values()) if (value === partition) return true;
    return false;
  }

  /**
   * 换工作区只换「新标签页用哪份」，不动已经开着的。
   *
   * 之前这里把所有页面丢掉重建，理由是 guest 的分区创建时就定死了。丢掉是错的：
   * 切回来页面全没了，更要命的是后台会话的 Agent 正在操作的页面也一起没了。分区
   * 定死是真的，但它是「每张标签页定死」，不是「每个窗口定死」——各自带着自己那份
   * 活着就行。
   */
  setUiScope(scopeId: string, workspacePath?: string): BrowserStateSnapshot {
    this.elementPicker.cancel();
    this.uiScopeId = scopeId.trim() || DEFAULT_SCOPE_ID;
    this.noteScopeWorkspace(this.uiScopeId, workspacePath);
    if (workspacePath) {
      this.partition = browserPartitionFor(workspacePath);
      this.prepareIdentity(this.partition);
    }
    this.refreshViewportOverrides();
    const state = this.state();
    this.publishState(state);
    return state;
  }

  /** 网页版/手机打开了某个会话：只登记下来，好把这个会话的变化推给它，不动桌面窗口。 */
  watchRemoteScope(scopeId: string, workspacePath?: string): BrowserStateSnapshot {
    const id = scopeId.trim() || DEFAULT_SCOPE_ID;
    this.noteScopeWorkspace(id, workspacePath);
    this.remoteScopeIds.delete(id);
    this.remoteScopeIds.add(id);
    for (const old of this.remoteScopeIds) {
      if (this.remoteScopeIds.size <= REMOTE_SCOPE_LIMIT) break;
      this.remoteScopeIds.delete(old);
    }
    return this.state(id);
  }

  /** 有界面正看着这个会话：桌面窗口，或者网页版/手机。 */
  private isWatched(scopeId: string): boolean {
    return scopeId === this.uiScopeId || this.remoteScopeIds.has(scopeId);
  }

  /**
   * 新会话接手草稿阶段开的标签页。
   *
   * 浏览器按会话分，可新对话要等发出第一条消息才有会话；在那之前界面落在工作区这一份
   * 作用域上。用户先开个页面、再问 Agent「看看这个页面」是很自然的顺序，所以会话一
   * 建好，那几张标签页就整批交给它：不然页面从面板上消失，Agent 也看不到它。
   *
   * 只在新会话还一张标签页都没有时接手，已经有自己页面的会话不掺进别的。cookie 跟着
   * 标签页走，同一个工作区，不用换。CDP 那边先按旧作用域宣布消失、再按新作用域宣布
   * 出现，两边连着的客户端看到的都是完整的变化。
   */
  adoptScope(fromScopeId: string, toScopeId: string, workspacePath?: string): BrowserStateSnapshot {
    const from = fromScopeId.trim();
    const to = toScopeId.trim() || DEFAULT_SCOPE_ID;
    this.noteScopeWorkspace(to, workspacePath);
    const moving = from && from !== to && this.tabsForScope(to).length === 0 ? this.tabsForScope(from) : [];
    if (moving.length === 0) return this.state(to);
    for (const tab of moving) {
      this.cdp.announceDestroyed(tab);
      tab.scopeId = to;
      // 浏览器面板开着时，草稿会先垫一张空白页。它还停在空白页就当桥自己垫的那张：
      // Agent 第一次 new_page 直接拿它用，不然新会话一开头就是「空白页 + 真页面」两张。
      // 这张常常刚垫出来、还没加载完（面板一打开就垫，紧接着就发了消息），所以这里只看
      // 「还没去别处」；真要拿去用时，isReusableBlankTab 会再确认它已就绪、仍是空白页。
      const url = tab.guest && !tab.guest.isDestroyed() ? tab.guest.getURL() : "";
      if (!url || /^about:blank$/i.test(url)) tab.implicit = true;
      this.cdp.announceCreated(tab);
    }
    const active = this.activeTabIds.get(from);
    this.activeTabIds.delete(from);
    if (active) this.activeTabIds.set(to, active);
    const zoom = this.zoomFactors.get(from);
    this.zoomFactors.delete(from);
    if (zoom !== undefined) this.zoomFactors.set(to, zoom);
    for (const tab of moving) this.applyZoom(tab);
    if (this.uiScopeId === from) {
      // 界面马上也会切到这个会话；先跟过去，免得这中间被当成后台页停放。
      this.elementPicker.cancel();
      this.uiScopeId = to;
      this.refreshViewportOverrides();
    }
    const state = this.state(to);
    if (this.isWatched(to)) this.publishState(state);
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
    if (this.isWatched(scopeId)) this.publishState(state);
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

  async createTab(rawUrl?: string, activate = true, scopeId = this.uiScopeId, placeholder = false): Promise<BrowserStateSnapshot> {
    if (placeholder) {
      // 面板给空会话垫的那一张：判断「一张都没有」和建在同一步里，不和 Agent 开页抢。
      if (this.tabsForScope(scopeId).length > 0) return this.state(scopeId);
      // Agent 开了真正的页面后这张会被收掉（dropBlankPlaceholders），那不算出错。
      await this.createCdpTab(rawUrl, activate, scopeId, true, "user").catch(() => undefined);
      return this.state(scopeId);
    }
    await this.createCdpTab(rawUrl, activate, scopeId);
    return this.state(scopeId);
  }

  /**
   * Agent 在这个会话里有了自己的页面，面板垫的空白占位页就没用了：还停在空白页（或
   * 还没加载完）的那几张收掉，不然标签条上总挂着一张谁也没用过的空白页。
   */
  private dropBlankPlaceholders(scopeId: string, keepId: string): void {
    for (const tab of this.tabsForScope(scopeId)) {
      if (tab.id === keepId || !tab.implicit || tab.control !== "user") continue;
      const url = tab.guest && !tab.guest.isDestroyed() ? tab.guest.getURL() : "";
      if (!url || /^about:blank$/i.test(url)) this.closeTab(tab.id, scopeId);
    }
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
  private createTabRecord(activate: boolean, scopeId: string, implicit: boolean, owner: BrowserTabOwner, control: BrowserTabControl): BrowserTab {
    const id = randomUUID();
    const tab: BrowserTab = {
      id,
      scopeId,
      partition: this.partitionForScope(scopeId),
      owner,
      control,
      lastUsedAt: Date.now(),
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
    const webContentsId = await this.guests.expectGuest(tab.id, tab.guestNonce, tab.partition)
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
   * Agent 的标签页：建一个离屏页面，按和 guest 一样的顺序接好——安全、事件、调试器，
   * 都在第一次真正的导航之前（见 browser-offscreen.ts 为什么 Agent 用离屏页面）。
   *
   * 调试器之前先让它加载点东西：从没加载过页面的离屏页面还没有渲染进程，这时发的
   * CDP 命令会一直等下去（<webview> 挂上时已经加载过 about:blank，所以没这个问题）。
   * 从用户那边接管过来的，这一步就是把页面状态恢复进来——恢复只肯往没加载过的页面里恢复。
   */
  private async attachOffscreen(tab: BrowserTab, history?: { entries: Electron.NavigationEntry[]; index: number }): Promise<void> {
    const page = createOffscreenPage(tab.partition, this.offscreenSize(tab));
    if (tab.phase === "closing" || !this.tabs.has(tab.id)) {
      page.destroy();
      throw new Error("标签页已关闭。");
    }
    tab.offscreen = page;
    tab.guest = page.webContents;
    tab.phase = "loading";
    this.installTabSecurity(tab);
    this.installTabEvents(tab);
    this.installGuestTeardown(tab, page.webContents);
    this.installPageFeedback(tab, page.webContents);
    if (history) await page.webContents.navigationHistory.restore(history);
    else await loadGuestUrl(page.webContents, DEFAULT_URL);
    await this.attachDebugger(tab);
    this.applyZoom(tab);
  }

  /**
   * 离屏页面多大，就是 Agent 看到的视口多大。用户正看着它时和面板一样大，画面一比一；
   * 没在看时按常见的桌面尺寸（和停靠的 guest 一样）。Agent 自己调过尺寸就按它的。
   */
  private offscreenSize(tab: BrowserTab): { width: number; height: number } {
    if (tab.emulatedSize) return tab.emulatedSize;
    const visible = this.panelVisible && tab.id === this.activeTabIds.get(this.uiScopeId);
    return visible ? this.uiViewport : DEFAULT_VIEWPORT;
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
    // 离屏页面有自己的窗口，直接改窗口大小，不用模拟。
    if (tab.offscreen) {
      resizeOffscreenPage(tab.offscreen, this.offscreenSize(tab));
      return;
    }
    if (tab.emulatedSize) return;
    const guest = tab.guest;
    if (!guest || guest.isDestroyed()) return;
    // 停不停靠只看「用户现在是不是正看着它」。这里以前还要求标签页属于界面这个
    // scope——那是多余的（tab id 全局唯一），而且现在是错的：用户点开别的会话那张
    // 标签页时，它就是屏幕上那一张，再按 1280x720 铺一遍会画到面板外面去。
    const parked = !this.panelVisible || tab.id !== this.activeTabIds.get(this.uiScopeId);
    try {
      if (!parked) {
        // Let the element's own box drive layout again.
        await guest.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
        return;
      }
      await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
        ...realScreenMetrics(),
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
    this.refreshFrames();
  }

  /** 面板正显示一张 Agent 标签页时，把它的画面送过去；换了、收起了就换目标或停下。 */
  private refreshFrames(): void {
    const tab = this.panelVisible ? this.activeTab(this.uiScopeId) : undefined;
    const watched = tab?.control === "agent" && tab.phase !== "closing" ? tab : undefined;
    this.frames.watch(watched?.id, watched?.guest);
  }

  /** A guest can die on its own — renderer reload, crash, or element removal. */
  private installGuestTeardown(tab: BrowserTab, guest: WebContents): void {
    guest.once("destroyed", () => {
      // 接管时换下来的旧页面会被销毁，那不是这张标签页没了。
      if (this.tabs.get(tab.id) !== tab || tab.guest !== guest) return;
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

  private async createCdpTab(
    rawUrl: string | undefined,
    activate: boolean,
    scopeId: string,
    implicit = false,
    owner: BrowserTabOwner = "user",
    control: BrowserTabControl = owner,
  ): Promise<BrowserTab> {
    const url = normalizeBrowserUrl(rawUrl);
    const tab = this.createTabRecord(activate, scopeId, implicit, owner, control);
    try {
      if (control === "agent") await this.attachOffscreen(tab);
      else await this.attachGuest(tab);
      await loadGuestUrl(tab.guest!, url);
      await this.finishTabCreation(tab);
    } catch (error) {
      this.closeTabRecord(tab);
      this.publish();
      throw error;
    }
    if (control === "agent") {
      this.keepAgentTabsWithinLimit(tab);
      if (!implicit) this.dropBlankPlaceholders(scopeId, tab.id);
    }
    return tab;
  }

  /** 见 browser-agent-tabs.ts：Agent 再开新页、超过上限时，关掉它最久没用过的那几张。 */
  private keepAgentTabsWithinLimit(opened: BrowserTab): void {
    const keep = new Set([opened.id, this.activeTabIds.get(opened.scopeId) ?? ""]);
    for (const tab of agentTabsToRecycle(this.tabsForScope(opened.scopeId), keep, AGENT_TAB_LIMIT)) {
      const guest = tab.guest && !tab.guest.isDestroyed() ? tab.guest : undefined;
      this.recycledTabs.record(tab.scopeId, { url: guest?.getURL() || DEFAULT_URL, title: guest?.getTitle() || "" });
      this.closeTab(tab.id, tab.scopeId);
    }
  }

  /**
   * Creation is asynchronous now, so concurrent callers must share one attempt:
   * every CDP root command funnels through here, and a fresh client typically
   * issues several at once.
   */
  async ensureAgentTab(scopeId = this.uiScopeId): Promise<BrowserTab> {
    // Agent 只能碰归它的标签页：当前那张不归它，就用它最近用过的那张。
    const active = this.readyTab(scopeId);
    if (active?.control === "agent") return active;
    const recent = this.cdpTabs(scopeId)
      .filter((tab) => tab.phase === "ready" && tab.guest && !tab.guest.isDestroyed())
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (recent) return recent;
    const inFlight = this.pendingEnsure.get(scopeId);
    if (inFlight) return inFlight;
    // 桥为 CDP 客户端垫的空白页：没人要过它，算 Agent 的，Agent 第一次 new_page 就拿它用。
    // 用户正看着自己的标签页时不把面板切过去。
    const attempt = this.createCdpTab(undefined, !this.activeTabIds.has(scopeId), scopeId, true, "agent")
      .finally(() => {
        if (this.pendingEnsure.get(scopeId) === attempt) this.pendingEnsure.delete(scopeId);
      });
    this.pendingEnsure.set(scopeId, attempt);
    return attempt;
  }

  /**
   * 界面上的地址栏、前进后退、刷新作用在当前这一张上，不管是谁开的：用户和 Agent 用的
   * 是同一个页面，不用先接管。一张都没有就给用户开一张。
   */
  private async userTab(scopeId: string): Promise<BrowserTab> {
    const active = this.activeTab(scopeId);
    if (active?.guest && !active.guest.isDestroyed() && active.phase !== "closing") return active;
    return this.createCdpTab(undefined, true, scopeId, false, "user");
  }

  /** Frames of the active tab, for a remote client that cannot host the view. */
  async captureTab(scopeId = this.uiScopeId): Promise<string | undefined> {
    return captureGuestFrame(this.activeTab(scopeId)?.guest);
  }

  /** Let the user point at one node in the visible guest without opening DevTools. */
  async pickElement(scopeId = this.uiScopeId): Promise<BrowserElementSelection | undefined> {
    const tab = this.readyTab(scopeId);
    if (!tab) throw new Error("请等待当前网页加载完成后再选择元素。");
    return this.elementPicker.pick(this.guestOf(tab));
  }

  cancelElementPick(): void {
    this.elementPicker.cancel();
  }

  /**
   * CDP 调用已经在 `findTabByTarget` 处按 client scope 限定；界面调用则再按当前
   * 工作区校验一次，避免一个旧快照或竞态请求选择、关闭其他文件夹的标签页。
   */
  selectTab(id: string, scopeId = this.uiScopeId): BrowserStateSnapshot {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("浏览器标签页不存在。");
    if (tab.scopeId !== scopeId) return this.state(scopeId);
    this.elementPicker.cancel();
    this.activeTabIds.set(scopeId, id);
    tab.lastUsedAt = Date.now();
    this.refreshViewportOverrides();
    this.publish();
    return this.state(scopeId);
  }

  /** 同 `selectTab`：跨工作区的旧标签请求直接返回当前工作区快照。 */
  closeTab(id: string, scopeId = this.uiScopeId): BrowserStateSnapshot {
    const tab = this.tabs.get(id);
    if (!tab || tab.scopeId !== scopeId) return this.state(scopeId);
    this.elementPicker.cancel();
    // 接替的那一张只从当前工作区里面挑，绝不能让一个 Agent 的当前页变成另一个
    // 文件夹的页面。
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

  async navigate(rawUrl: string, scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.userTab(scopeId);
    await loadGuestUrl(this.guestOf(tab), normalizeBrowserUrl(rawUrl));
    return this.state(scopeId);
  }

  async back(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.userTab(scopeId);
    const history = this.guestOf(tab).navigationHistory;
    if (history.canGoBack()) history.goBack();
    return this.state(scopeId);
  }

  async forward(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.userTab(scopeId);
    const history = this.guestOf(tab).navigationHistory;
    if (history.canGoForward()) history.goForward();
    return this.state(scopeId);
  }

  async reload(scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = await this.userTab(scopeId);
    this.guestOf(tab).reload();
    return this.state(scopeId);
  }

  /**
   * 用户在面板里对页面的一次操作。
   *
   * 只送进桌面窗口当前会话正显示着的那一张：旧画面、别的会话、后台标签页送来的一律
   * 不收——界面上看不到的页面，不该被一个迟到的点击点中。焦点进出例外：用户点回 App
   * 别处、切走标签页时，那张页面已经不是正显示的了，失焦还是要送到。
   */
  forwardInput(scopeId: string, tabId: string, raw: unknown): void {
    const input = parsePageInput(raw);
    if (!input) return;
    const tab = this.tabs.get(tabId);
    const page = tab?.offscreen;
    if (!tab || tab.scopeId !== scopeId || tab.phase !== "ready" || !page || page.isDestroyed()) return;
    const contents = tab.guest;
    if (!contents || contents.isDestroyed()) return;
    if (input.kind === "focus") {
      void this.setFocusEmulation(tab, "user", input.focused);
      return;
    }
    const visible = scopeId === this.uiScopeId && this.panelVisible && this.activeTabIds.get(scopeId) === tabId;
    if (!visible) return;
    let forwarder = this.inputForwarders.get(contents);
    if (!forwarder) {
      forwarder = new PageInputForwarder(contents);
      this.inputForwarders.set(contents, forwarder);
    }
    const now = Date.now();
    tab.userInputAt = now;
    // 用户正在用的页面不算「最久没用」，Agent 开新页超上限时不会先收掉它。
    tab.lastUsedAt = now;
    if (input.kind === "mouse" && input.type === "down" && input.button === "right") tab.userContextMenuAt = now;
    const [width, height] = page.getContentSize();
    forwarder.forward(input, { width, height });
  }

  /**
   * 页面「以为自己有焦点」：Agent 和用户任何一边要就开着，两边都不要才关（见
   * BrowserTab.focusEmulation）。离屏页面本来永远没有焦点，不开的话输入框不闪光标、
   * 有的网页不响应键盘。
   */
  private async setFocusEmulation(tab: BrowserTab, who: "agent" | "user", enabled: boolean): Promise<void> {
    const state = tab.focusEmulation ?? { agent: false, user: false, applied: false };
    state[who] = enabled;
    tab.focusEmulation = state;
    const wanted = state.agent || state.user;
    if (wanted === state.applied) return;
    const contents = tab.guest;
    if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return;
    state.applied = wanted;
    try {
      await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: wanted });
    } catch (error) {
      state.applied = !wanted;
      console.warn("[browser] 切换页面焦点失败", error instanceof Error ? error.message : error);
    }
  }

  /**
   * 离屏页面自己的反馈，面板要跟着变：鼠标指到的地方该显示什么光标，用户右键时的菜单。
   *
   * 右键菜单只为用户弹：Agent 在页面上右键（CDP 按右键）也会触发，那时在用户面前弹出
   * 一个菜单，会把他的键盘焦点抢走。
   */
  private installPageFeedback(tab: BrowserTab, contents: WebContents): void {
    contents.on("cursor-changed", (_event, type, image, _scale, _size, hotspot) => {
      this.publishPageEvent({ tabId: tab.id, kind: "cursor", cursor: cssCursor(type, image, hotspot) });
    });
    contents.on("context-menu", (_event, params) => {
      const at = tab.userContextMenuAt;
      tab.userContextMenuAt = undefined;
      if (at === undefined || Date.now() - at > 1500) return;
      this.showPageContextMenu(contents, params);
    });
  }

  private publishPageEvent(event: BrowserPageEvent): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.send("browser:page-event", event);
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
    if (hidden) this.elementPicker.cancel();
    // A zero size means the panel is hidden, so the active tab is parked like any
    // other and needs the override back to stay screenshot-able.
    if (this.panelVisible === !hidden) {
      if (hidden || (width === this.uiViewport.width && height === this.uiViewport.height)) return;
      this.uiViewport = { width, height };
      // 面板只是变了大小：正看着的那张 Agent 标签页是离屏页面，得跟着改窗口大小，
      // 不然画面还按旧尺寸画，拉宽后多出来的地方留白。用户的 guest 跟着元素走，不用管。
      const tab = this.activeTab(this.uiScopeId);
      if (tab?.offscreen && tab.phase !== "closing") resizeOffscreenPage(tab.offscreen, this.offscreenSize(tab));
      return;
    }
    this.panelVisible = !hidden;
    if (!hidden) this.uiViewport = { width, height };
    this.refreshViewportOverrides();
  }

  /** 用户在这个会话里开着的标签页，给 Agent 挑一张接管。Agent 碰不了它们，只能看到有哪些。 */
  private userTabsFor(scopeId: string): Array<{ id: string; title: string; url: string; active: boolean }> {
    return this.tabsForScope(scopeId)
      .filter((tab) => tab.control === "user" && tab.phase === "ready" && tab.guest && !tab.guest.isDestroyed())
      .map((tab) => ({
        id: tab.id,
        title: tab.guest!.getTitle(),
        url: tab.guest!.getURL() || DEFAULT_URL,
        active: this.activeTabIds.get(scopeId) === tab.id,
      }));
  }

  /**
   * Agent 接管用户的标签页：换成离屏页面，页面状态原样搬过去。
   *
   * 用 Chromium 恢复标签页的那套机制（navigationHistory.getAllEntries / restore）：
   * 网址、前进后退历史、表单里填的内容、滚动位置都带过去；页面脚本会重新跑一遍，
   * 内存里没保存的东西（单页应用的临时状态、正在播放的位置）带不过去。cookie 是同一
   * 份，登录状态还在。不用用户同意，界面上这张标签页换成 Agent 的样子。
   */
  async takeOverForAgent(id: string, scopeId: string): Promise<BrowserTab> {
    const tab = this.tabs.get(id);
    if (!tab || tab.scopeId !== scopeId) throw new Error("标签页不存在。");
    if (tab.control === "agent") return tab;
    const source = tab.guest;
    if (tab.phase !== "ready" || !source || source.isDestroyed()) throw new Error("这张标签页还没加载好，稍后再接管。");
    const history = await this.historyOf(source);
    const previous = { nonce: tab.guestNonce, guest: source };
    tab.control = "agent";
    try {
      await this.attachOffscreen(tab, history);
      await this.refreshPageTargetIdentity(tab);
    } catch (error) {
      // 没搬成就原样退回：还是用户那张 <webview>。
      if (tab.offscreen && !tab.offscreen.isDestroyed()) tab.offscreen.destroy();
      Object.assign(tab, { control: "user", offscreen: undefined, guest: previous.guest, phase: "ready" });
      this.publish();
      throw error;
    }
    // 旧的 <webview> 从名册里拿掉，渲染层会删掉元素、销毁它。
    this.guests.release(tab.id);
    if (previous.guest.debugger.isAttached()) previous.guest.debugger.detach();
    tab.guestNonce = randomBytes(16).toString("hex");
    tab.phase = "ready";
    tab.announced = true;
    tab.lastUsedAt = Date.now();
    this.publishRoster();
    this.refreshViewportOverrides();
    this.cdp.announceCreated(tab);
    this.publish();
    return tab;
  }

  /**
   * 用户接管 Agent 的标签页：换成正常的 <webview>，页面状态原样搬过去。
   *
   * Chromium 只肯往从没加载过页面的 WebContents 里恢复，所以新元素带着接管标记报到，
   * 主进程让它什么都不加载、在 did-attach 里直接认领（见 browser-webview-policy.ts
   * 的 restoreGuestSrc），恢复完页面，渲染层再照常用 nonce 登记确认。Agent 从这一刻
   * 起看不到这张标签页了。
   */
  async takeOverForUser(id: string, scopeId = this.uiScopeId): Promise<BrowserStateSnapshot> {
    const tab = this.tabs.get(id);
    if (!tab || tab.scopeId !== scopeId) return this.state(scopeId);
    if (tab.control === "user") return this.state(scopeId);
    const source = tab.guest;
    const page = tab.offscreen;
    if (tab.phase !== "ready" || !source || source.isDestroyed() || !page) throw new Error("这张标签页还没加载好，稍后再接管。");
    const history = await this.historyOf(source);
    this.cdp.announceDestroyed(tab);
    tab.announced = false;
    tab.control = "user";
    tab.phase = "awaiting-guest";
    tab.guestNonce = randomBytes(16).toString("hex");
    tab.guest = undefined;
    tab.offscreen = undefined;
    const claimed = this.guests.expectRestoreGuest(tab.id, tab.partition);
    const registered = this.guests.expectGuest(tab.id, tab.guestNonce, tab.partition);
    this.refreshFrames();
    this.publishRoster();
    this.publish();
    try {
      const guest = webContentsRegistry.fromId(await claimed);
      if (!guest || guest.isDestroyed()) throw new Error("内置浏览器视图已失效。");
      tab.guest = guest;
      tab.phase = "loading";
      this.installTabSecurity(tab);
      this.installTabEvents(tab);
      this.installGuestTeardown(tab, guest);
      // 先恢复再挂调试器：从没加载过页面的 guest 上挂调试器、发 CDP 命令，恢复会卡住。
      await guest.navigationHistory.restore(history);
      await this.attachDebugger(tab);
      this.applyZoom(tab);
      await registered;
    } catch (error) {
      // 没搬成：退回成 Agent 那张离屏页面，它还活着。
      this.guests.release(tab.id);
      Object.assign(tab, { control: "agent", guest: source, offscreen: page, phase: "ready", announced: true });
      this.publishRoster();
      this.refreshViewportOverrides();
      this.cdp.announceCreated(tab);
      this.publish();
      throw error;
    }
    if (source.debugger.isAttached()) source.debugger.detach();
    page.destroy();
    tab.phase = "ready";
    this.refreshViewportOverrides();
    this.publish();
    return this.state(scopeId);
  }

  /**
   * 接管时要搬走的东西：历史，加上每一页的页面状态（表单内容、滚动位置）。
   *
   * Chromium 平时是隔一阵子才把页面状态同步出来一次，页面不在前台时隔得更久——刚填进
   * 去的内容很可能还没记上，搬过去输入框就是空的。先做一次同文档的 replaceState（网址、
   * history.state 都不变），Chromium 会随这次提交把当前页面状态立刻带出来。
   */
  private async historyOf(contents: WebContents): Promise<{ entries: Electron.NavigationEntry[]; index: number }> {
    await contents.executeJavaScript("history.replaceState(history.state, '')", true).catch(() => undefined);
    return { entries: contents.navigationHistory.getAllEntries(), index: contents.navigationHistory.getActiveIndex() };
  }

  /** will-attach-webview 里问：这个带接管标记的元素，是不是真有这张标签页在等接管。 */
  acceptsRestoreAttach(tabId: string, partition: unknown): boolean {
    return this.guests.acceptsRestore(tabId, partition);
  }

  /** did-attach-webview 里认领接管用的 guest；核对不过就关掉它。 */
  claimRestoreGuest(tabId: string, guest: WebContents): void {
    try {
      this.guests.claimRestore(tabId, guest.id);
    } catch (error) {
      console.error("[browser] 接管用的浏览器视图校验失败", error);
      if (!guest.isDestroyed()) guest.close();
    }
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
      // 只有归用户的标签页才是嵌在面板里的 <webview>；Agent 的是离屏页面，不在这里。
      tabs: [...this.tabs.values()]
        .filter((tab) => tab.phase !== "closing" && tab.control === "user")
        .map((tab) => ({
          tabId: tab.id,
          nonce: tab.guestNonce,
          partition: tab.partition,
          ...this.guests.restorePending(tab.id) ? { restore: true } : {},
        })),
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
    this.elementPicker.cancel();
    this.frames.stop();
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
    // Agent 看得到、碰得到的只有归它的标签页；用户的要先接管（takeOverForAgent）。
    return this.tabsForScope(scopeId).filter((tab) => tab.announced && tab.control === "agent");
  }

  private activeTab(scopeId: string): BrowserTab | undefined {
    const id = this.activeTabIds.get(scopeId);
    const tab = id ? this.tabs.get(id) : undefined;
    return tab?.scopeId === scopeId ? tab : undefined;
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
      if (!tab.offscreen) guest.close({ waitForBeforeUnload: false });
    }
    if (tab.offscreen && !tab.offscreen.isDestroyed()) tab.offscreen.destroy();
    tab.offscreen = undefined;
    tab.guest = undefined;
    this.refreshFrames();
    this.publishRoster();
  }

  private tabSnapshot(tab: BrowserTab): BrowserTabSnapshot {
    const contents = tab.guest;
    // A tab exists in the strip while its guest is still being created.
    if (!contents || contents.isDestroyed()) {
      return { id: tab.id, title: "新标签页", url: DEFAULT_URL, loading: true, canGoBack: false, canGoForward: false, agent: tab.control === "agent" };
    }
    return {
      id: tab.id,
      title: contents.getTitle() || (contents.getURL() === DEFAULT_URL ? "新标签页" : contents.getURL()) || "新标签页",
      url: contents.getURL() || DEFAULT_URL,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      agent: tab.control === "agent",
    };
  }

  private publish(): void {
    this.publishState(this.state());
    // 网页版/手机看着的会话也推一份；各个界面只收自己会话的那份。
    for (const scopeId of this.remoteScopeIds) if (scopeId !== this.uiScopeId) this.publishState(this.state(scopeId));
  }

  private installTabSecurity(tab: BrowserTab): void {
    const contents = this.guestOf(tab);
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    // 权限「有没有」也要和「能不能要」说同一句话。Electron 默认的检查是放行的，于是
    // 页面读到 Notification.permission === "granted" ——从来没弹过窗却已经授权，真
    // 浏览器里不可能出现。两边都答「没有」，看上去就是一个拒绝过通知的普通用户。
    contents.session.setPermissionCheckHandler(() => false);
    contents.setWindowOpenHandler(({ url }) => {
      try {
        normalizeBrowserUrl(url);
        // 页面自己弹出的新窗口跟着打开它的那张算：Agent 页里弹出来的还是 Agent 的。
        void this.createCdpTab(url, true, tab.scopeId, false, tab.owner, tab.control).catch((error) => console.error("[browser] 打开新标签页失败", error));
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
      // 不再只在「这张是界面这个 scope 的」时候才发：别的会话那几张现在也画在上面
      // 那一排里，不发的话它们的标题和地址就永远停在刚创建时的样子，用户看着一排
      // 「新标签页」，不知道 agent 到底把它们带到哪儿去了。
      this.publish();
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
    contents.on("dom-ready", () => fillSavedCredentials(contents, tab.partition));
    contents.on("render-process-gone", update);
  }

  /** 返回的 promise 是给第一次导航用的：身份必须在导航发出之前盖上（见 attachGuest）。 */
  private attachDebugger(tab: BrowserTab): Promise<void> {
    const debug = this.guestOf(tab).debugger;
    if (debug.isAttached()) return Promise.resolve();
    debug.attach("1.3");
    return Promise.all([applyGuestUserAgent(debug), installChromeObject(debug)]).then(() => undefined);
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
    if (tab.offscreen) {
      resizeOffscreenPage(tab.offscreen, tab.emulatedSize);
      return {};
    }
    this.attachDebugger(tab);
    await this.guestOf(tab).debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      ...realScreenMetrics(),
      deviceScaleFactor: 1,
      mobile: false,
    });
    return {};
  }

}
