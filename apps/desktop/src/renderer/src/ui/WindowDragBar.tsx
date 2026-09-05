import { useEffect, useRef } from "react";
import { observeWindowDragBar } from "./window-drag";

/**
 * 一条可以拖动窗口的标题带。
 *
 * 用法：放在标题栏的**第一个子节点**，并给标题栏 `position: relative`。整条约定
 * （为什么是空的一层、为什么必须排在最前、为什么要留最小宽度）写在
 * `ui/window-drag.ts` 的文件头，改标题栏之前先看那里。
 *
 * 这一层自己不放任何内容：它的矩形只随标题栏尺寸变化，不会被后面新加的 UI 改写；
 * 标题栏里的按钮排在它后面，会自动在它身上挖出 no-drag 的洞。
 *
 * 盯的是**父元素**而不是这一层自己：拖动带失不失效，取决于整条标题栏的尺寸和它
 * 里面那些洞，而不是这一层的尺寸。顺带把 `.window-drag-bar` 补到父元素上，刷新
 * 机制靠它认人。
 */
export function WindowDragBar({ className }: { className?: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const bar = ref.current?.parentElement;
    if (!bar) return;
    return observeWindowDragBar(bar);
  }, []);
  // 用 span 而不是 div：标题栏里到处是 `> div` / `> div:first-child` 这类选择器，
  // 多插一个 div 会把它们悄悄挪到这一层上（绝对定位后 span 一样是块盒，显示没差别）。
  return <span className={className ? `window-drag window-drag-layer ${className}` : "window-drag window-drag-layer"} aria-hidden="true" ref={ref} />;
}
