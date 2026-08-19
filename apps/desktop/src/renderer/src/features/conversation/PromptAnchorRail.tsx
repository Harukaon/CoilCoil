import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { excerpt } from "./promptAnchors";

export interface PromptAnchor {
  /** 用户消息 id，对应 DOM 上的 data-message-id */
  id: string;
  /** 提示词原文，用于列表预览 */
  text: string;
  /** 在完整 timeline 中的下标（含未加载的历史轮次） */
  index: number;
}

/**
 * 对话左侧的提示词导航。
 *
 * 静止时是一个按钮——竖排三个小点。点击弹出面板：每行一条 prompt 摘要，点击跳转，
 * 条目多了面板自己滚动；点面板以外的任何地方（或按 Esc）关闭。
 *
 * 面板走 Radix Popover（和模型选择器、Token 详情同一套）。这一点很关键：
 * `.conversation-pane` 是 `overflow: hidden`，自己用绝对定位画的面板会被它裁掉，
 * 而且用 `translateY(-50%)` 居中时面板高度一变位置就跟着跳。Popover 会 portal 到
 * 顶层并自带避让，位置不再取决于自身高度，关闭也由它统一处理。
 */
export function PromptAnchorRail({ anchors, loadedFrom, onSelect }: {
  anchors: PromptAnchor[];
  loadedFrom: number;
  onSelect: (anchor: PromptAnchor) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  if (anchors.length < 2) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <nav className="prompt-anchor-rail" aria-label="提示词导航">
        <Popover.Trigger asChild>
          <button className="prompt-anchor-marks" type="button" aria-label="提示词导航">
            <i /><i /><i />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="prompt-anchor-card"
            side="right"
            align="center"
            sideOffset={6}
            collisionPadding={12}
          >
            <ol aria-label="按提示词跳转">
              {anchors.map((anchor, ordinal) => (
                <li key={anchor.id}>
                  <button
                    className={`prompt-anchor-row${anchor.index < loadedFrom ? " unloaded" : ""}`}
                    type="button"
                    title={anchor.text}
                    aria-label={`跳转到第 ${ordinal + 1} 条提示词`}
                    onClick={() => { setOpen(false); onSelect(anchor); }}
                  >
                    {excerpt(anchor.text)}
                  </button>
                </li>
              ))}
            </ol>
          </Popover.Content>
        </Popover.Portal>
      </nav>
    </Popover.Root>
  );
}
