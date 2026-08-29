import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** How tall a fenced block may be before it is folded, in pixels. */
export const COLLAPSED_CODE_HEIGHT = 320;
/** Below this much excess the fold would save nothing worth a click. */
const FOLD_THRESHOLD = 48;
/** How long the button stays on "已复制" before going back, in milliseconds. */
export const COPIED_FEEDBACK_MS = 1600;

export function shouldFoldCodeBlock(contentHeight: number): boolean {
  return contentHeight > COLLAPSED_CODE_HEIGHT + FOLD_THRESHOLD;
}

/**
 * 取一个代码块要复制出去的原文。
 *
 * 优先读 `<code>` 而不是 `<pre>`：真正的代码只住在 `<code>` 里，将来若在 `<pre>`
 * 上挂行号槽或文件名条，它们不会跟着被复制走。围栏解析后末尾总会多一个换行，
 * 粘到终端里会白白多敲一次回车，所以去掉。
 */
export function codeBlockText(pre: HTMLElement | null): string {
  if (!pre) return "";
  const code = pre.querySelector("code");
  return (code?.textContent ?? pre.textContent ?? "").replace(/\n$/, "");
}

/**
 * A fenced code block that folds itself when it is long.
 *
 * A single pasted file used to push the whole conversation off screen, and the
 * reply underneath it was reached by scrolling past hundreds of lines nobody
 * asked to re-read. Long blocks open to a fixed height with the rest one click
 * away; short ones are untouched, and the fold never hides so little that the
 * button costs more than it saves.
 *
 * 复制按钮钉在块的**右下角**：右上角会压住第一行代码（也是最常被读的一行），
 * 右下角只压住块尾的留白。它挂在 `.markdown-code-surface` 上而不是 `<pre>` 里，
 * 因为横向滚动的是 `<pre>`——放进去会被一起滚出视野。
 */
export function CollapsibleCodeBlock({ children, ...props }: {
  children?: ReactNode;
} & Record<string, unknown>): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [foldable, setFoldable] = useState(false);
  const [lines, setLines] = useState(0);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Streaming grows the block after it first renders, so the measurement has
    // to follow the content rather than run once on mount.
    const measure = (): void => {
      setFoldable(shouldFoldCodeBlock(element.scrollHeight));
      setLines(element.textContent ? element.textContent.replace(/\n$/, "").split("\n").length : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const copy = useCallback((): void => {
    const text = codeBlockText(ref.current);
    if (!text) return;
    // 折叠状态下复制的仍是整块原文：折叠只改 `<pre>` 的可见高度，不动它的内容。
    // 剪贴板走浏览器 API，被拒时退回主进程的剪贴板（页面失焦时前者会抛）。
    // 两条路都失败就不亮「已复制」——按钮保持原样，本身就是没成功的反馈。
    void navigator.clipboard.writeText(text)
      .catch(() => window.coilcoil.copyText(text))
      .then(() => {
        setCopied(true);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      })
      .catch(() => undefined);
  }, []);

  const collapsed = foldable && !expanded;
  return (
    <div className={`markdown-code-block ${collapsed ? "collapsed" : ""}`}>
      <div className="markdown-code-surface">
        <pre {...props} ref={ref} style={collapsed ? { maxHeight: COLLAPSED_CODE_HEIGHT } : undefined}>{children}</pre>
        <button
          className={`markdown-code-copy ${copied ? "copied" : ""}`}
          type="button"
          aria-label={copied ? "已复制代码" : "复制代码"}
          onClick={copy}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      {foldable ? (
        <button className="markdown-code-toggle" type="button" onClick={() => setExpanded((current) => !current)}>
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span>{collapsed ? `展开全部${lines ? ` · ${lines} 行` : ""}` : "收起"}</span>
        </button>
      ) : null}
    </div>
  );
}
