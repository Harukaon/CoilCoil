import { Bot, Hand, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { BrowserTabSnapshot } from "../../../../shared/desktop-api";

/**
 * 面板里显示一张归 Agent 的标签页：只有画面，没有可以点的网页。
 *
 * Agent 的页面是离屏渲染的（主进程 browser-offscreen.ts）——它点击、打字都不会碰
 * 用户的焦点。这里显示它送过来的画面，用户想自己动手就按「接管」，这张标签页换成
 * 正常的网页，页面状态原样带过来。
 *
 * `remoteFrame` 是手机端用的：手机拿的是定时截图，不走帧推送。
 */
export function AgentPageView({ tab, remoteFrame, onTakeOver }: {
  tab: BrowserTabSnapshot;
  remoteFrame?: string;
  onTakeOver(): Promise<void>;
}): React.JSX.Element {
  const [frame, setFrame] = useState<string>();
  const [takingOver, setTakingOver] = useState(false);

  useEffect(() => {
    setFrame(undefined);
    if (remoteFrame !== undefined) return;
    let current: string | undefined;
    const stop = window.coilcoil.onBrowserFrame((next) => {
      if (next.tabId !== tab.id) return;
      const url = URL.createObjectURL(new Blob([next.data as BlobPart], { type: "image/jpeg" }));
      setFrame(url);
      if (current) URL.revokeObjectURL(current);
      current = url;
    });
    return () => {
      stop();
      if (current) URL.revokeObjectURL(current);
    };
  }, [remoteFrame, tab.id]);

  const shown = remoteFrame ?? frame;
  return (
    <div className="browser-agent-view">
      {shown
        ? <img className="browser-agent-frame" src={shown} alt={tab.title} draggable={false} />
        : <div className="browser-empty"><LoaderCircle className="spin" size={20} /><strong>正在读取 Agent 的页面…</strong></div>}
      {/* 这页归 Agent：四周一圈流动的渐变描边，底部接管按钮附近一团呼吸的光晕加模糊，一眼能看出来；只挡画面，不挡按钮。 */}
      <div className="browser-agent-presence" aria-hidden="true">
        <div className="browser-agent-ring" />
        <div className="browser-agent-veil" />
        <div className="browser-agent-glow" />
      </div>
      <div className="browser-agent-bar" role="status">
        <span className="browser-agent-pulse" aria-hidden="true" />
        <Bot className="browser-agent-label" size={14} />
        <span className="browser-agent-label">Agent 正在使用这个页面</span>
        <button
          type="button"
          aria-label="接管这个页面"
          title="换成正常网页，由你自己操作；页面状态原样保留"
          disabled={takingOver}
          onClick={() => {
            setTakingOver(true);
            // 成功时这张标签页换成正常网页，这个视图随之卸下；失败才需要恢复按钮。
            void onTakeOver().finally(() => setTakingOver(false));
          }}
        >
          {takingOver ? <LoaderCircle className="spin" size={14} /> : <Hand size={14} />}
          接管
        </button>
      </div>
    </div>
  );
}
