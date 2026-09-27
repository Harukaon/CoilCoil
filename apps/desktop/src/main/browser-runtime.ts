import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, session, sharedTexture, shell, type Session, type WebContents } from "electron";
import type { BrowserCaret, BrowserElementSelection, BrowserPageEvent, BrowserStateSnapshot, BrowserTabSnapshot } from "../shared/desktop-api";
import { AGENT_TAB_LIMIT, agentTabsToRecycle, RecycledAgentTabs, type BrowserTabOwner } from "./browser-agent-tabs";
import { captureGuestFrame } from "./browser-capture";
import { BrowserCdpBridge } from "./browser-cdp-bridge";
import { BrowserElementPicker } from "./browser-element-picker";
import { fillSavedCredentials } from "./browser-import";
import { cssCursor, PageInputForwarder, parseFindRequest, parsePageInput } from "./browser-input";
import { readPageCaret } from "./browser-page-caret";
import { PageCursors } from "./browser-page-cursor";
import { readPageTooltip } from "./browser-page-tooltip";
import { PageDialogs } from "./browser-page-dialogs";
import { PageDrags, parseFileDrop } from "./browser-page-drags";
import { isPrintRequest, PageRequests } from "./browser-page-requests";
import { PageSelects } from "./browser-page-selects";
import { loadGuestUrl, normalizeBrowserUrl } from "./browser-navigation";
import { BrowserSurfaceStream } from "./browser-frame-stream";
import { createOffscreenPage, resizeOffscreenPage } from "./browser-offscreen";
import { applyGuestUserAgent, browserIdentityEnvironment, configureBrowserIdentity, installChromeObject } from "./browser-user-agent";
import {
  DEFAULT_BROWSER_SCOPE_ID as DEFAULT_SCOPE_ID,
  DEFAULT_BROWSER_URL as DEFAULT_URL,
  DEFAULT_BROWSER_VIEWPORT as DEFAULT_VIEWPORT,
  isReusableBlankTab,
  orderTabsForUi,
  type BrowserTab,
} from "./browser-runtime-types";
import { BROWSER_PARTITION, browserPartitionFor } from "./browser-page-policy";

/**
 * 缩放挡位，和 Chrome 的一样。
 *
 * 用挡位而不是任意小数：每一挡都是设计上站得住的字号，用户按一下就换一挡，不会
 * 停在 103% 这种既不整齐、字形也发虚的地方。
 */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** 同时记住几个网页版/手机正看着的会话；多出来的按最早打开的先忘。 */
const REMOTE_SCOPE_LIMIT = 8;
/** Agent 停手多久以后，面板上「正在操作」的提示收起：盖住它两步之间思考的空当，不一闪一闪。 */
const AGENT_ACTIVE_MS = 8000;

/**
 * 内置浏览器的全部标签页：每一张都是一个离屏页面（见 browser-offscreen.ts），用户在
 * 面板里看它的画面、直接在上面操作，Agent 通过 CDP（BrowserCdpBridge）操作同一个页面。
 * 这里管标签页的生老病死、给界面的快照，以及用户操作怎么送进页面。
 */
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
  /** 网页弹的 alert/confirm/prompt 挂在标签页上，面板里回答，不弹系统对话框。 */
  private readonly dialogs = new PageDialogs(() => this.publish());
  private readonly drags = new PageDrags();
  private readonly pageCursors = new PageCursors((tabId, cursor) =>
    this.publishPageEvent({ tabId, kind: "cursor", cursor }));
  /** 每张页面「正在操作」提示的收起计时。 */
  private readonly agentIdle = new Map<string, ReturnType<typeof setTimeout>>();
  /** 网页下拉框的选项由面板画（离屏页面里原生弹层出不来）。 */
  private readonly selects = new PageSelects((event) => this.publishPageEvent(event), (id, contents) =>
    !this.disposed && this.panelVisible && this.activeTabIds.get(this.uiScopeId) === id && this.tabs.get(id)?.guest === contents);
  /** 网页要选文件、要打印：先拦下，是用户要的才弹面板、出 PDF（见 browser-page-requests.ts）。 */
  private readonly pageRequests = new PageRequests({
    userJustActed: (id) => Date.now() - (this.tabs.get(id)?.userPressAt ?? 0) < 2000,
    chooseFiles: async (multiple) => {
      if (this.window.isDestroyed()) return undefined;
      const result = await dialog.showOpenDialog(this.window, { properties: multiple ? ["openFile", "multiSelections"] : ["openFile"] });
      return result.canceled ? undefined : result.filePaths;
    },
    printAsPdf: async (contents) => {
      const file = join(app.getPath("temp"), `coilcoil-print-${Date.now()}.pdf`);
      await writeFile(file, await contents.printToPDF({ printBackground: true }));
      const failure = await shell.openPath(file);
      if (failure) throw new Error(failure);
    },
  });
  /** 每张页面一个：把用户的操作按到达顺序送进去（见 browser-input.ts）。 */
  private readonly inputForwarders = new WeakMap<WebContents, PageInputForwarder>();
  /** 用户正看着的那张离屏页面的画面，画到面板里（见 browser-frame-stream.ts）。 */
  private readonly frames: BrowserSurfaceStream;
  private disposed = false;
  /**
   * App 界面重载、崩溃重开：标签页都是离屏页面，不跟着界面走，一张都不关。界面那边的
   * 状态没了：用户点进页面时开的「页面有焦点」撤掉，开着的下拉列表收起。
   */
  private readonly handleHostReload = (
    _event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean,
  ): void => {
    if (!isMainFrame || isInPlace) return;
    this.forgetUiState();
  };
  private readonly handleHostGone = (): void => this.forgetUiState();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publishState: (state: BrowserStateSnapshot) => void,
    private readonly onAgentActivated: (scopeId: string) => void,
    /** 在 App 窗口里弹出网页的右键菜单（菜单本身由主进程入口搭）。 */
    private readonly showPageContextMenu: (contents: WebContents, params: Electron.ContextMenuParams) => void = () => {},
  ) {
    this.frames = new BrowserSurfaceStream(window.webContents, {
      textures: sharedTexture,
      viewportOf: (contents) => {
        const [width, height] = BrowserWindow.fromWebContents(contents)?.getContentSize() ?? [0, 0];
        return { width, height };
      },
    });
    this.cdp = new BrowserCdpBridge({
      onAgentActivated: (scopeId) => this.onAgentActivated(scopeId),
      ensureActiveTab: (scopeId) => this.ensureAgentTab(scopeId),
      createTab: (rawUrl, activate, scopeId) => this.createCdpTab(rawUrl, activate, scopeId, false, "agent"),
      tabList: (scopeId) => this.tabList(scopeId),
      anyReadyTab: (scopeId) => this.tabsForScope(scopeId).find((tab) => tab.phase === "ready" && tab.guest && !tab.guest.isDestroyed()),
      blankPlaceholder: (scopeId) => this.tabsForScope(scopeId).find((tab) =>
        tab.guest && !tab.guest.isDestroyed() && isReusableBlankTab(tab, tab.guest.getURL())),
      noteAgentUse: (tab) => this.noteAgentUse(tab),
      noteAgentPointer: (tab) => this.pageCursors.agentMoved(tab.id),
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
      pageDrags: this.drags,
    });
    // 窗口最小化、隐藏、⌘H 隐藏整个 App、被别的窗口完全挡住（macOS 也发 hide，但 isVisible
    // 还是 true）时，面板谁也看不见：正看着的那张也降到一秒一帧。页面大小不变，Agent 照常用。
    const covered = (value: boolean) => (): void => {
      this.frames.setDisplayed(!value && !window.isDestroyed() && window.isVisible() && !window.isMinimized());
    };
    window.on("hide", covered(true));
    window.on("minimize", covered(true));
    window.on("show", covered(false));
    window.on("restore", covered(false));
    this.window.webContents.on("did-start-navigation", this.handleHostReload);
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
      if (tab.id === keepId || !tab.implicit || tab.owner !== "user") continue;
      const url = tab.guest && !tab.guest.isDestroyed() ? tab.guest.getURL() : "";
      if (!url || /^about:blank$/i.test(url)) this.closeTab(tab.id, scopeId);
    }
  }

  /**
   * 先同步占好这张标签页的位置，再去等页面建好。
   *
   * 记录和它在 activeTabIds 里的位置必须在同一轮里落下：ensureActiveTab 有十几个调用方，
   * 不这样每个都会在第一张还没建好时各开一张。页面提交之前它是隔离的——announced 为
   * false、pageTargetId 是占位的——CDP 客户端看不到一个背后还没有页面的目标。
   */
  private createTabRecord(activate: boolean, scopeId: string, implicit: boolean, owner: BrowserTabOwner): BrowserTab {
    const id = randomUUID();
    const tab: BrowserTab = {
      id,
      scopeId,
      partition: this.partitionForScope(scopeId),
      owner,
      lastUsedAt: Date.now(),
      tabTargetId: `tab-${id}`,
      pageTargetId: `pending-page-${id}`,
      phase: "creating",
      announced: false,
      ...implicit ? { implicit: true } : {},
    };
    this.tabs.set(id, tab);
    if (activate || !this.activeTabIds.has(scopeId)) this.activeTabIds.set(scopeId, id);
    // 标签条上立刻出现一个「新标签页」，页面建好再换成真的标题。
    this.publish();
    return tab;
  }

  /**
   * 建一个离屏页面，按这个顺序接好：安全、事件、调试器，都在第一次真正的导航之前
   * （为什么用离屏页面见 browser-offscreen.ts）。
   *
   * 调试器之前先让它加载点东西：从没加载过页面的离屏页面还没有渲染进程，这时发的
   * CDP 命令会一直等下去。
   */
  private async attachOffscreen(tab: BrowserTab): Promise<void> {
    const page = createOffscreenPage(tab.partition, this.offscreenSize(tab), (contents, texture, image) => this.frames.paint(tab.id, contents, texture, image));
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
    this.dialogs.install(tab.id, page.webContents);
    await loadGuestUrl(page.webContents, DEFAULT_URL);
    await this.attachDebugger(tab);
    await this.dialogs.watch(page.webContents);
    await this.pageRequests.install(tab.id, page.webContents);
    await this.drags.install(page.webContents);
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

  /** 每张离屏页面都有自己的窗口，视口就是窗口大小：用户正看着的和面板一样大，其余按常见桌面尺寸。 */
  private async applyViewportOverride(tab: BrowserTab): Promise<void> {
    if (tab.offscreen) resizeOffscreenPage(tab.offscreen, this.offscreenSize(tab));
  }

  /** Re-evaluate every tab's viewport after the visible tab changes. */
  private refreshViewportOverrides(): void {
    for (const tab of this.tabs.values()) {
      if (tab.phase === "closing" || !tab.guest) continue;
      void this.applyViewportOverride(tab);
    }
    this.refreshFrames();
  }

  /** 面板正显示哪一张，就把它的画面送过去；换了、收起了就换目标或停下。 */
  private refreshFrames(): void {
    const tab = this.panelVisible ? this.activeTab(this.uiScopeId) : undefined;
    const watched = tab && tab.phase !== "closing" ? tab : undefined;
    this.frames.watch(watched?.id, watched?.guest);
  }

  /** 页面自己没了（被系统回收、异常销毁）：这张标签页跟着关掉。 */
  private installGuestTeardown(tab: BrowserTab, guest: WebContents): void {
    guest.once("destroyed", () => {
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
  ): Promise<BrowserTab> {
    const url = normalizeBrowserUrl(rawUrl);
    const tab = this.createTabRecord(activate, scopeId, implicit, owner);
    try {
      await this.attachOffscreen(tab);
      await loadGuestUrl(tab.guest!, url);
      await this.finishTabCreation(tab);
    } catch (error) {
      this.closeTabRecord(tab);
      this.publish();
      throw error;
    }
    if (owner === "agent") {
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
    // 用户和 Agent 用的是同一批页面：当前那张能用就是它，不然用最近用过的那张。
    const active = this.readyTab(scopeId);
    if (active?.announced) return active;
    const recent = this.cdpTabs(scopeId)
      .filter((tab) => tab.phase === "ready" && tab.guest && !tab.guest.isDestroyed())
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (recent) return recent;
    const inFlight = this.pendingEnsure.get(scopeId);
    if (inFlight) return inFlight;
    // 一张都没有：给 CDP 客户端垫一张空白页，算 Agent 的，Agent 第一次 new_page 就拿它用。
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
    if (this.activeTabIds.get(scopeId) !== id) this.pageCursors.switched(id);
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
    if (!this.shownTab(scopeId, tabId)) return;
    let forwarder = this.inputForwarders.get(contents);
    if (!forwarder) {
      forwarder = new PageInputForwarder(contents, process.platform,
        (point) => this.selects.intercept(tab.id, contents, point),
        () => !this.disposed && this.shownTab(tab.scopeId, tab.id)?.guest === contents,
        (key) => this.selects.intercept(tab.id, contents, undefined, key),
        { userMouse: (event) => this.drags.userMouse(contents, event), userEscape: () => this.drags.userEscape(contents) });
      this.inputForwarders.set(contents, forwarder);
    }
    const now = Date.now();
    // 真按下去的（点、按键、输入法上屏）才算「用户要的」：网页这时要选文件、要打印，给他弹。
    const pressed = (input.kind === "mouse" && input.type === "down") || (input.kind === "key" && input.type === "down")
      || input.kind === "text" || (input.kind === "ime" && input.type === "commit");
    if (pressed) tab.userPressAt = now;
    // 用户在 Agent 开的页面里动过手（点、打字、滚着看、复制粘贴），这页就归他用，超上限时不收；
    // 鼠标只是从画面上经过不算——面板一直显示着 Agent 的页面，不然谁的鼠标一晃，上限就没了。
    if (pressed || input.kind === "wheel" || input.kind === "edit") tab.userInputAt = now;
    // 用户正在用的页面不算「最久没用」，Agent 开新页超上限时不会先收掉它。
    tab.lastUsedAt = now;
    if (input.kind === "mouse" && input.type === "down" && input.button === "right") tab.userContextMenuAt = now;
    // 滚轮不移动页面里的虚拟鼠标；Agent 刚停在链接上时不能借一次滚动把它的小手换到用户身上。
    if (input.kind === "mouse") this.pageCursors.userMoved(tab.id);
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
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.inputForwarders.get(contents)?.reset();
    });
    contents.on("found-in-page", (_event, result) => {
      this.publishPageEvent({ tabId: tab.id, kind: "find", matches: result.matches, active: result.activeMatchOrdinal });
    });
    contents.on("cursor-changed", (_event, type, image, _scale, _size, hotspot) => {
      this.pageCursors.pageChanged(tab.id, cssCursor(type, image, hotspot));
    });
    contents.on("context-menu", (_event, params) => {
      const at = tab.userContextMenuAt;
      tab.userContextMenuAt = undefined;
      if (at === undefined || Date.now() - at > 1500) return;
      this.showPageContextMenu(contents, params);
    });
  }

  /** 用户在面板打开的日期、时间、颜色选择器里选了值（或者没选就关了）。 */
  async chooseValue(scopeId: string, tabId: string, pickerId: string, value: string | null, final: boolean): Promise<void> {
    if (this.pickerAnswer(scopeId, tabId, value !== null)) await this.selects.chooseValue(tabId, pickerId, value, final);
  }

  /** 用户在面板画的下拉框列表里选了一项（或者没选就关了）。 */
  async chooseSelect(scopeId: string, tabId: string, pickerId: string, index: number | null): Promise<void> {
    if (this.pickerAnswer(scopeId, tabId, index !== null)) await this.selects.choose(tabId, pickerId, index);
  }

  /** 面板的选择器回话只认这个会话的标签页；真选了的还得是用户正看着的那张，这一下也算用户用过。 */
  private pickerAnswer(scopeId: string, tabId: string, chose: boolean): boolean {
    const tab = chose ? this.shownTab(scopeId, tabId) : this.tabs.get(tabId);
    if (!tab || tab.scopeId !== scopeId) return false;
    if (chose) tab.userInputAt = Date.now();
    return true;
  }

  /**
   * 桌面窗口正显示的就是这张（会话对、面板开着、是这个会话当前的标签页、页面还在）。面板来的
   * 查找、光标、悬停提示、拖文件、选择器回话只认这张，后台的、别的会话的一律不收。
   */
  private shownTab(scopeId: string, tabId: string): BrowserTab | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.scopeId !== scopeId || scopeId !== this.uiScopeId || !this.panelVisible || this.activeTabIds.get(scopeId) !== tabId) return undefined;
    return tab.guest && !tab.guest.isDestroyed() ? tab : undefined;
  }

  /** 用户从访达拖文件到面板的页面上：放进松手的位置（见 browser-page-drags.ts）。只收正显示的那张。 */
  dropFiles(scopeId: string, tabId: string, rawPoint: unknown, rawPaths: unknown): void {
    const tab = this.shownTab(scopeId, tabId);
    const contents = tab?.guest;
    if (!tab?.offscreen || !contents) return;
    const [width, height] = tab.offscreen.getContentSize();
    const drop = parseFileDrop(rawPoint, rawPaths, { width, height });
    if (!drop) return;
    tab.userInputAt = tab.lastUsedAt = Date.now();
    void this.drags.dropFiles(contents, drop.point, drop.files, drop.modifiers).catch((error: unknown) => {
      console.warn("[browser] 放进拖来的文件失败", error instanceof Error ? error.message : error);
    });
  }

  /** 用户在面板的查找栏里搜：只在桌面窗口正显示的那张页面里找，结果推回面板。 */
  findInPage(scopeId: string, tabId: string, raw: unknown): void {
    const request = parseFindRequest(raw);
    if (!request) return;
    // 收起查找、清高亮不限于正显示的那张：切走标签页时，面板正是在给刚才那张收尾。
    if ("stop" in request || !request.text) {
      const tab = this.tabs.get(tabId);
      if (tab?.scopeId !== scopeId || scopeId !== this.uiScopeId || !tab.guest || tab.guest.isDestroyed()) return;
      tab.guest.stopFindInPage("keepSelection");
      this.publishPageEvent({ tabId, kind: "find", matches: 0, active: 0 });
      return;
    }
    // Electron 的 findNext 意思是「开始一次新的查找」：换了字时为 true，找下一处时为 false。
    this.shownTab(scopeId, tabId)?.guest?.findInPage(request.text, { forward: request.forward, findNext: request.newSearch });
  }

  /** 用户在面板里打字的位置，输入法候选框跟着它。只问桌面窗口正显示的页面；停在网页对话框上时不问。 */
  caretOf(scopeId: string, tabId: string): Promise<BrowserCaret | null> {
    const contents = this.shownTab(scopeId, tabId)?.guest;
    return contents && !this.dialogs.snapshot(tabId) ? readPageCaret(contents) : Promise.resolve(null);
  }

  /** 鼠标停在面板画面上这一点（页面窗口的像素）：这里的悬停提示。只问桌面窗口正显示的那张。 */
  tooltipAt(scopeId: string, tabId: string, raw: unknown): Promise<string | null> {
    const contents = this.shownTab(scopeId, tabId)?.guest;
    const { x, y } = (raw && typeof raw === "object" ? raw : {}) as { x?: unknown; y?: unknown };
    const inPage = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000;
    if (!contents || this.dialogs.snapshot(tabId) || !inPage(x) || !inPage(y)) return Promise.resolve(null);
    return readPageTooltip(contents, { x, y });
  }

  /** 用户在面板里回答网页弹的对话框。只认桌面窗口或网页版正看着的那个会话里的标签页。 */
  replyDialog(scopeId: string, tabId: string, dialogId: string, accept: boolean, text: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.scopeId !== scopeId || !this.isWatched(scopeId)) return;
    this.dialogs.reply(tabId, dialogId, accept, text);
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
      // 面板只是变了大小：正看着的那张离屏页面得跟着改窗口大小，不然画面还按旧尺寸画，
      // 拉宽后多出来的地方留白。
      const tab = this.activeTab(this.uiScopeId);
      if (tab?.offscreen && tab.phase !== "closing") resizeOffscreenPage(tab.offscreen, this.offscreenSize(tab));
      return;
    }
    this.panelVisible = !hidden;
    if (!hidden) {
      this.uiViewport = { width, height };
      const tab = this.activeTab(this.uiScopeId);
      if (tab) this.pageCursors.switched(tab.id);
    }
    this.refreshViewportOverrides();
  }

  /**
   * 这个会话里的全部标签页，给 Agent 的 browser_tabs：用户开的、Agent 开的都在，用户
   * 正看着哪一张也标出来。用户和 Agent 用的是同一批页面，不用接管、不会刷新。
   */
  private tabList(scopeId: string): Array<{ id: string; title: string; url: string; active: boolean; owner: BrowserTabOwner }> {
    return this.cdpTabs(scopeId)
      .filter((tab) => tab.phase === "ready" && tab.guest && !tab.guest.isDestroyed())
      .map((tab) => ({
        id: tab.id,
        title: tab.guest!.getTitle(),
        url: tab.guest!.getURL() || DEFAULT_URL,
        active: this.activeTabIds.get(scopeId) === tab.id,
        owner: tab.owner,
      }));
  }

  /** 界面重载、崩溃：界面上的状态没了，页面还在。 */
  private forgetUiState(): void {
    if (this.disposed) return;
    this.elementPicker.cancel();
    for (const tab of this.tabs.values()) {
      this.selects.forget(tab.id);
      this.pageCursors.switched(tab.id);
      if (tab.focusEmulation?.user) void this.setFocusEmulation(tab, "user", false);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.elementPicker.cancel();
    this.frames.dispose();
    if (!this.window.isDestroyed()) {
      this.window.webContents.off("did-start-navigation", this.handleHostReload);
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
    // 这个会话里的标签页 Agent 都看得到、都能用：用户开的也一样（用户拍板的）。
    return this.tabsForScope(scopeId).filter((tab) => tab.announced);
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

  /** Agent 在这张页面上动了手：记下（上限收页看这个），面板亮出「正在操作」，停手一会儿后收起。 */
  private noteAgentUse(tab: BrowserTab): void {
    const now = Date.now();
    const wasActive = now - (tab.agentActiveAt ?? 0) < AGENT_ACTIVE_MS;
    tab.lastUsedAt = tab.agentActiveAt = now;
    if (!wasActive) this.publish();
    clearTimeout(this.agentIdle.get(tab.id));
    this.agentIdle.set(tab.id, setTimeout(() => {
      this.agentIdle.delete(tab.id);
      if (!this.disposed && this.tabs.get(tab.id) === tab) this.publish();
    }, AGENT_ACTIVE_MS + 50));
  }

  private closeTabRecord(tab: BrowserTab): void {
    tab.phase = "closing";
    clearTimeout(this.agentIdle.get(tab.id));
    this.agentIdle.delete(tab.id);
    if (!this.tabs.delete(tab.id)) return;
    if (this.activeTabIds.get(tab.scopeId) === tab.id) {
      const replacement = this.tabsForScope(tab.scopeId)[0];
      if (replacement) this.activeTabIds.set(tab.scopeId, replacement.id);
      else this.activeTabIds.delete(tab.scopeId);
    }
    // 趁页面还在先告诉 CDP 客户端，它们挂在这个调试器上的转发才摘得干净。
    this.cdp.announceDestroyed(tab);
    this.selects.forget(tab.id);
    this.pageCursors.forget(tab.id);
    const guest = tab.guest;
    if (guest && !guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
    // 直接销毁窗口：页面的 beforeunload 不能把一张标签页留住。
    if (tab.offscreen && !tab.offscreen.isDestroyed()) tab.offscreen.destroy();
    tab.offscreen = undefined;
    tab.guest = undefined;
    this.refreshFrames();
  }

  private agentActive(tab: BrowserTab): boolean {
    return Date.now() - (tab.agentActiveAt ?? 0) < AGENT_ACTIVE_MS;
  }

  private tabSnapshot(tab: BrowserTab): BrowserTabSnapshot {
    const contents = tab.guest;
    // A tab exists in the strip while its guest is still being created.
    if (!contents || contents.isDestroyed()) {
      return { id: tab.id, title: "新标签页", url: DEFAULT_URL, loading: true, canGoBack: false, canGoForward: false, agent: tab.owner === "agent", agentActive: this.agentActive(tab) };
    }
    return {
      id: tab.id,
      title: contents.getTitle() || (contents.getURL() === DEFAULT_URL ? "新标签页" : contents.getURL()) || "新标签页",
      url: contents.getURL() || DEFAULT_URL,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      agent: tab.owner === "agent",
      agentActive: this.agentActive(tab),
      ...this.dialogs.snapshot(tab.id) ? { dialog: this.dialogs.snapshot(tab.id) } : {},
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
      // 页面调 print()：替身借 window.open 报的信，不是真要开窗口（见 browser-page-requests.ts）。
      if (isPrintRequest(url)) {
        void this.pageRequests.requestPrint(tab.id, contents);
        return { action: "deny" };
      }
      try {
        normalizeBrowserUrl(url);
        // 页面自己弹出的新窗口跟着打开它的那张算：Agent 页里弹出来的还是 Agent 的。
        void this.createCdpTab(url, true, tab.scopeId, false, tab.owner).catch((error) => console.error("[browser] 打开新标签页失败", error));
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

  /** 返回的 promise 是给第一次导航用的：身份必须在导航发出之前盖上（见 attachOffscreen）。 */
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
    if (tab.offscreen) resizeOffscreenPage(tab.offscreen, tab.emulatedSize);
    return {};
  }

}
