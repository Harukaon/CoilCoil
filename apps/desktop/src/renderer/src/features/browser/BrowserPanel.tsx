import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserStateSnapshot } from "../../../../shared/desktop-api";

const EMPTY_STATE: BrowserStateSnapshot = { tabs: [] };

export function BrowserPanel({ active }: { active: boolean }): React.JSX.Element {
  const [state, setState] = useState<BrowserStateSnapshot>(EMPTY_STATE);
  const [address, setAddress] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const activeTab = useMemo(() => state.tabs.find((tab) => tab.id === state.activeTabId), [state]);

  useEffect(() => window.suocode.onBrowserStateUpdated(setState), []);

  useEffect(() => {
    let cancelled = false;
    void window.suocode.getBrowserState().then(async (current) => {
      if (cancelled) return;
      const next = active && current.tabs.length === 0 ? await window.suocode.createBrowserTab() : current;
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => setAddress(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? ""), [activeTab?.id, activeTab?.url]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = (): void => {
      const bounds = host.getBoundingClientRect();
      void window.suocode.setBrowserViewBounds({
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
        visible: active && document.visibilityState === "visible",
      });
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
      void window.suocode.setBrowserViewBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [active]);

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault();
    void window.suocode.navigateBrowser(address).then(setState);
  };

  return (
    <section className="browser-panel">
      <div className="browser-tab-strip no-drag" aria-label="浏览器标签页">
        <div className="browser-tabs">
          {state.tabs.map((tab) => (
            <div className={`browser-tab ${tab.id === state.activeTabId ? "active" : ""}`} key={tab.id}>
              <button className="browser-tab-select" type="button" onClick={() => void window.suocode.selectBrowserTab(tab.id).then(setState)}>
                {tab.loading ? <LoaderCircle className="spin" size={11} /> : <Globe2 size={11} />}
                <span>{tab.title}</span>
              </button>
              <button className="browser-tab-close" type="button" aria-label={`关闭 ${tab.title}`} onClick={() => void window.suocode.closeBrowserTab(tab.id).then(setState)}><X size={10} /></button>
            </div>
          ))}
        </div>
        <button className="browser-new-tab" type="button" aria-label="新建浏览器标签页" onClick={() => void window.suocode.createBrowserTab().then(setState)}><Plus size={13} /></button>
      </div>
      <form className="browser-toolbar no-drag" onSubmit={submitAddress}>
        <button type="button" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={() => void window.suocode.browserBack().then(setState)}><ArrowLeft size={13} /></button>
        <button type="button" aria-label="前进" disabled={!activeTab?.canGoForward} onClick={() => void window.suocode.browserForward().then(setState)}><ArrowRight size={13} /></button>
        <button type="button" aria-label="刷新网页" disabled={!activeTab} onClick={() => void window.suocode.reloadBrowser().then(setState)}><RotateCw size={12} /></button>
        <input aria-label="网页地址" value={address} placeholder="输入网址或搜索内容" spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
      </form>
      <div className="browser-native-host" ref={hostRef}>
        {!activeTab ? <div className="browser-empty"><Globe2 size={24} /><strong>打开内置浏览器</strong><button type="button" onClick={() => void window.suocode.createBrowserTab().then(setState)}>新建标签页</button></div> : null}
      </div>
    </section>
  );
}
