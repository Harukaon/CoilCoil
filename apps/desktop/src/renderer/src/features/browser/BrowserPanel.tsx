import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserStateSnapshot } from "../../../../shared/desktop-api";
import { isBrowserViewVisible } from "./browserViewVisibility";

const EMPTY_STATE = (scopeId: string): BrowserStateSnapshot => ({ scopeId, tabs: [] });

export function BrowserPanel({ active, covered = false, scopeId }: { active: boolean; covered?: boolean; scopeId: string }): React.JSX.Element {
  const [state, setState] = useState<BrowserStateSnapshot>(() => EMPTY_STATE(scopeId));
  const [address, setAddress] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const activeTab = useMemo(() => state.tabs.find((tab) => tab.id === state.activeTabId), [state]);

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  useEffect(() => window.suocode.onBrowserStateUpdated((next) => {
    if (next.scopeId === scopeRef.current) setState(next);
  }), []);

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY_STATE(scopeId));
    void window.suocode.setBrowserScope(scopeId).then(async (current) => {
      if (cancelled) return;
      const next = active && current.tabs.length === 0 ? await window.suocode.createBrowserTab(scopeId) : current;
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [active, scopeId]);

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
        visible: isBrowserViewVisible(active, covered, document.visibilityState === "visible"),
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
  }, [active, covered]);

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault();
    void window.suocode.navigateBrowser(scopeId, address).then(setState);
  };

  return (
    <section className="browser-panel">
      <div className="browser-tab-strip no-drag" aria-label="浏览器标签页">
        <div className="browser-tabs">
          {state.tabs.map((tab) => (
            <div className={`browser-tab ${tab.id === state.activeTabId ? "active" : ""}`} key={tab.id}>
              <button className="browser-tab-select" type="button" onClick={() => void window.suocode.selectBrowserTab(scopeId, tab.id).then(setState)}>
                {tab.loading ? <LoaderCircle className="spin" size={11} /> : <Globe2 size={11} />}
                <span>{tab.title}</span>
              </button>
              <button className="browser-tab-close" type="button" aria-label={`关闭 ${tab.title}`} onClick={() => void window.suocode.closeBrowserTab(scopeId, tab.id).then(setState)}><X size={10} /></button>
            </div>
          ))}
          <button className="browser-new-tab" type="button" aria-label="新建浏览器标签页" onClick={() => void window.suocode.createBrowserTab(scopeId).then(setState)}><Plus size={13} /></button>
        </div>
      </div>
      <form className="browser-toolbar no-drag" onSubmit={submitAddress}>
        <button type="button" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={() => void window.suocode.browserBack(scopeId).then(setState)}><ArrowLeft size={13} /></button>
        <button type="button" aria-label="前进" disabled={!activeTab?.canGoForward} onClick={() => void window.suocode.browserForward(scopeId).then(setState)}><ArrowRight size={13} /></button>
        <button type="button" aria-label="刷新网页" disabled={!activeTab} onClick={() => void window.suocode.reloadBrowser(scopeId).then(setState)}><RotateCw size={12} /></button>
        <input aria-label="网页地址" value={address} placeholder="输入网址或搜索内容" spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
      </form>
      <div className="browser-native-host" ref={hostRef}>
        {!activeTab ? <div className="browser-empty"><Globe2 size={24} /><strong>打开内置浏览器</strong><button type="button" onClick={() => void window.suocode.createBrowserTab(scopeId).then(setState)}>新建标签页</button></div> : null}
      </div>
    </section>
  );
}
