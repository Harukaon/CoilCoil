import * as Popover from "@radix-ui/react-popover";
import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, Minus, Plus, RotateCw, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserStateSnapshot } from "../../../../shared/desktop-api";
import { useMobileRemote } from "../../hooks/useMobileRemote";
import { toastError } from "../../ui/toast";
import { BrowserDataMenu } from "./BrowserDataMenu";
import { setGuestPlacement } from "./guestLayer";

/** Fast enough to follow the agent clicking through a page, cheap enough to stream. */
const REMOTE_FRAME_INTERVAL_MS = 1_200;

/**
 * 内置浏览器的页面区：地址栏 + 网页。
 *
 * 标签条不在这里——每个网页标签都是右侧栏顶部那一排里的一个标签，和终端一样，
 * 由 WorkspaceInspector 画（见 features/inspector/inspectorTabs.ts）。所以这里
 * 永远只显示当前标签页，标签集合和当前标签由主进程说了算。
 */
export function BrowserPanel({ active, scopeId, state, onState }: {
  active: boolean;
  scopeId: string;
  state: BrowserStateSnapshot;
  onState(next: BrowserStateSnapshot): void;
}): React.JSX.Element {
  const [address, setAddress] = useState("");
  const [zoomOpen, setZoomOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const mobile = useMobileRemote();
  const [frame, setFrame] = useState<string>();
  const activeTab = useMemo(() => state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0], [state]);

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  useEffect(() => setAddress(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? ""), [activeTab?.id, activeTab?.url]);

  const activeTabId = activeTab?.id;

  /**
   * On the phone the page is captured on the Mac and shown as frames.
   *
   * The desktop renders the page into a `<webview>` guest, which a browser tab
   * cannot host. The page is live on the Mac either way — the agent is driving
   * it — so the remote panel watches it instead of embedding it.
   */
  useEffect(() => {
    if (!mobile) { setFrame(undefined); return; }
    if (!active || !activeTabId) { setFrame(undefined); return; }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        const next = await window.coilcoil.captureBrowserTab(scopeRef.current);
        if (!cancelled && next) setFrame(next);
      } catch {
        // A tab that went away mid-capture just means the next frame is late.
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), REMOTE_FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [mobile, active, activeTabId]);

  // The guest is a <webview> in the layer at the app root, so this measures the
  // hole it should fill rather than pushing native bounds over IPC.
  useLayoutEffect(() => {
    const host = hostRef.current;
    // A remote client has no guest layer to place anything into, and reporting
    // its panel size would resize the agent's browser to a phone screen.
    if (!host || mobile) return;
    const update = (): void => {
      const visible = active && document.visibilityState === "visible";
      const rect = host.getBoundingClientRect();
      if (!visible || !activeTabId || rect.width <= 0 || rect.height <= 0) {
        setGuestPlacement(undefined);
        // Zero tells main the panel is hidden, so the tab parks and keeps a real
        // emulated viewport instead of rendering into its 1x1 element box.
        void window.coilcoil.setBrowserUiViewport({ width: 0, height: 0 });
        return;
      }
      setGuestPlacement({ tabId: activeTabId, x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      // Agents ask for the window size; report what the user is actually looking at.
      void window.coilcoil.setBrowserUiViewport({ width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(update);
    observer.observe(host);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("visibilitychange", update);
      setGuestPlacement(undefined);
      void window.coilcoil.setBrowserUiViewport({ width: 0, height: 0 });
    };
  }, [active, activeTabId, mobile]);

  /**
   * Every toolbar action ends in a state refresh, so a failed one has to say so.
   * Without this the rejection had nowhere to go and became an unhandled promise
   * error in the log that the user never saw.
   */
  const apply = (action: Promise<BrowserStateSnapshot>): void => {
    void action.then(onState).catch((error: unknown) => {
      toastError(error instanceof Error ? error.message : String(error));
    });
  };

  const zoomPercent = Math.round((state.zoom ?? 1) * 100);
  const zoomed = zoomPercent !== 100;

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault();
    apply(window.coilcoil.navigateBrowser(scopeId, address));
  };

  return (
    <section className="browser-panel">
      <form className="browser-toolbar no-drag" onSubmit={submitAddress}>
        <button type="button" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={() => apply(window.coilcoil.browserBack(scopeId))}><ArrowLeft size={13} /></button>
        <button type="button" aria-label="前进" disabled={!activeTab?.canGoForward} onClick={() => apply(window.coilcoil.browserForward(scopeId))}><ArrowRight size={13} /></button>
        <button type="button" aria-label="刷新网页" disabled={!activeTab} onClick={() => apply(window.coilcoil.reloadBrowser(scopeId))}><RotateCw size={12} /></button>
        <input aria-label="网页地址" value={address} placeholder="输入网址或搜索内容" spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
        {/* 缩放是整个内置浏览器的字号，所以按钮平时只是个图标；调过之后它自己把
            当前倍数写在旁边，用户一眼知道现在不是 100%，不用点开确认。 */}
        <Popover.Root open={zoomOpen} onOpenChange={setZoomOpen}>
          <Popover.Trigger asChild>
            <button className="browser-zoom" type="button" aria-label="缩放">
              <Search size={13} />
              {zoomed ? <span>{zoomPercent}%</span> : null}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="browser-zoom-popover" side="bottom" align="end" sideOffset={6} collisionPadding={12}>
              <button type="button" aria-label="缩小" disabled={zoomPercent <= 50} onClick={() => apply(window.coilcoil.setBrowserZoom(scopeId, "out"))}><Minus size={13} /></button>
              <strong>{zoomPercent}%</strong>
              <button type="button" aria-label="放大" disabled={zoomPercent >= 300} onClick={() => apply(window.coilcoil.setBrowserZoom(scopeId, "in"))}><Plus size={13} /></button>
              <button type="button" className="browser-zoom-reset" disabled={!zoomed} onClick={() => apply(window.coilcoil.setBrowserZoom(scopeId, "reset"))}>重置</button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {/* Importing reads this Mac's keychain, so it stays on the Mac's own window. */}
        {mobile ? null : <BrowserDataMenu />}
      </form>
      <div className={`browser-native-host ${mobile ? "browser-remote-host" : ""}`} ref={hostRef}>
        {!activeTab ? <div className="browser-empty"><Globe2 size={24} /><strong>打开内置浏览器</strong><button type="button" onClick={() => apply(window.coilcoil.createBrowserTab(scopeId))}>新建标签页</button></div> : null}
        {mobile && activeTab ? (
          frame
            ? <img className="browser-remote-frame" src={frame} alt={activeTab.title} />
            : <div className="browser-empty"><LoaderCircle className="spin" size={20} /><strong>正在读取 Mac 上的页面…</strong></div>
        ) : null}
      </div>
    </section>
  );
}
