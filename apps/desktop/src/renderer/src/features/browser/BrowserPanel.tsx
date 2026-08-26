import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserStateSnapshot } from "../../../../shared/desktop-api";
import { useMobileRemote } from "../../hooks/useMobileRemote";
import { setGuestPlacement } from "./guestLayer";

/** Fast enough to follow the agent clicking through a page, cheap enough to stream. */
const REMOTE_FRAME_INTERVAL_MS = 1_200;

const EMPTY_STATE = (scopeId: string): BrowserStateSnapshot => ({ scopeId, tabs: [] });

export function BrowserPanel({ active, scopeId }: { active: boolean; scopeId: string }): React.JSX.Element {
  const [state, setState] = useState<BrowserStateSnapshot>(() => EMPTY_STATE(scopeId));
  const [address, setAddress] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const mobile = useMobileRemote();
  const [frame, setFrame] = useState<string>();
  const activeTab = useMemo(() => state.tabs.find((tab) => tab.id === state.activeTabId), [state]);

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  useEffect(() => window.coilcoil.onBrowserStateUpdated((next) => {
    if (next.scopeId === scopeRef.current) setState(next);
  }), []);

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY_STATE(scopeId));
    void window.coilcoil.setBrowserScope(scopeId).then(async (current) => {
      if (cancelled) return;
      const next = active && current.tabs.length === 0 ? await window.coilcoil.createBrowserTab(scopeId) : current;
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [active, scopeId]);

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

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault();
    void window.coilcoil.navigateBrowser(scopeId, address).then(setState);
  };

  return (
    <section className="browser-panel">
      <div className="browser-tab-strip no-drag" aria-label="浏览器标签页">
        <div className="browser-tabs">
          {state.tabs.map((tab) => (
            <div className={`browser-tab ${tab.id === state.activeTabId ? "active" : ""}`} key={tab.id}>
              <button className="browser-tab-select" type="button" onClick={() => void window.coilcoil.selectBrowserTab(scopeId, tab.id).then(setState)}>
                {tab.loading ? <LoaderCircle className="spin" size={11} /> : <Globe2 size={11} />}
                <span>{tab.title}</span>
              </button>
              <button className="browser-tab-close" type="button" aria-label={`关闭 ${tab.title}`} onClick={() => void window.coilcoil.closeBrowserTab(scopeId, tab.id).then(setState)}><X size={10} /></button>
            </div>
          ))}
          <button className="browser-new-tab" type="button" aria-label="新建浏览器标签页" onClick={() => void window.coilcoil.createBrowserTab(scopeId).then(setState)}><Plus size={13} /></button>
        </div>
      </div>
      <form className="browser-toolbar no-drag" onSubmit={submitAddress}>
        <button type="button" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={() => void window.coilcoil.browserBack(scopeId).then(setState)}><ArrowLeft size={13} /></button>
        <button type="button" aria-label="前进" disabled={!activeTab?.canGoForward} onClick={() => void window.coilcoil.browserForward(scopeId).then(setState)}><ArrowRight size={13} /></button>
        <button type="button" aria-label="刷新网页" disabled={!activeTab} onClick={() => void window.coilcoil.reloadBrowser(scopeId).then(setState)}><RotateCw size={12} /></button>
        <input aria-label="网页地址" value={address} placeholder="输入网址或搜索内容" spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
      </form>
      <div className={`browser-native-host ${mobile ? "browser-remote-host" : ""}`} ref={hostRef}>
        {!activeTab ? <div className="browser-empty"><Globe2 size={24} /><strong>打开内置浏览器</strong><button type="button" onClick={() => void window.coilcoil.createBrowserTab(scopeId).then(setState)}>新建标签页</button></div> : null}
        {mobile && activeTab ? (
          frame
            ? <img className="browser-remote-frame" src={frame} alt={activeTab.title} />
            : <div className="browser-empty"><LoaderCircle className="spin" size={20} /><strong>正在读取 Mac 上的页面…</strong></div>
        ) : null}
      </div>
    </section>
  );
}
