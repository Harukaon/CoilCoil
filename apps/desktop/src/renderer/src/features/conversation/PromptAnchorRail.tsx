import { useState } from "react";
import type { FocusEvent, MouseEvent } from "react";

export interface PromptAnchor {
  /** 用户消息 id，对应 DOM 上的 data-message-id */
  id: string;
  /** 提示词原文，用于悬浮预览 */
  text: string;
  /** 在完整 timeline 中的下标（含未加载的历史轮次） */
  index: number;
}

function excerpt(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line || "（仅图片）";
}

/**
 * 对话左侧的提示词锚点条：每条横线对应一条用户 prompt。默认几乎不可见，
 * 悬浮整条导航时浮现，悬浮单条横线时微微放大并预览内容，点击跳转。
 * 尚未加载进可视 timeline 的历史轮次（index < loadedFrom）显示为空心弱化态，
 * 点击会先展开历史再定位。
 */
export function PromptAnchorRail({ anchors, loadedFrom, onSelect }: {
  anchors: PromptAnchor[];
  loadedFrom: number;
  onSelect: (anchor: PromptAnchor) => void;
}): React.JSX.Element | null {
  const [tip, setTip] = useState<{ text: string; y: number; ordinal: number }>();

  if (anchors.length < 2) return null;

  const showTip = (target: HTMLElement, anchor: PromptAnchor, ordinal: number): void => {
    const host = target.closest(".prompt-anchor-rail");
    if (!host) return;
    const rect = target.getBoundingClientRect();
    setTip({
      text: excerpt(anchor.text),
      y: rect.top + rect.height / 2 - host.getBoundingClientRect().top,
      ordinal,
    });
  };

  return (
    <nav className="prompt-anchor-rail" aria-label="提示词导航">
      <div className="prompt-anchor-list" role="list" onMouseLeave={() => setTip(undefined)} onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setTip(undefined);
      }}>
        {anchors.map((anchor, ordinal) => (
          <button
            key={anchor.id}
            className={`prompt-anchor-item${anchor.index < loadedFrom ? " unloaded" : ""}`}
            type="button"
            role="listitem"
            aria-label={`跳转到第 ${ordinal + 1} 条提示词`}
            onMouseEnter={(event: MouseEvent<HTMLButtonElement>) => showTip(event.currentTarget, anchor, ordinal)}
            onFocus={(event: FocusEvent<HTMLButtonElement>) => showTip(event.currentTarget, anchor, ordinal)}
            onClick={() => onSelect(anchor)}
          >
            <i />
          </button>
        ))}
      </div>
      {tip ? (
        <span className="prompt-anchor-tip" style={{ top: `${tip.y}px` }}>
          <b>#{tip.ordinal + 1}</b>
          <span>{tip.text}</span>
        </span>
      ) : null}
    </nav>
  );
}
