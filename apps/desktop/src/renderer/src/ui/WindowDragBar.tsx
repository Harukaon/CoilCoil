/**
 * 一条可以拖动窗口的标题带。
 *
 * ## 约定（新加标题栏时照做）
 *
 * 1. 标题栏的**第一个子节点**放 `<WindowDragBar />`，并给标题栏 `.window-drag-bar`
 *    和 `position: relative`。这一层是**空的**：绝对定位铺满标题栏，自己不放任何
 *    内容，所以它的矩形只随标题栏尺寸走，不会被后面新加的 UI 改写。
 * 2. 必须排在最前。Electron 拿到的是一串矩形，按文档顺序依次做并集（drag）/
 *    差集（no-drag）；排在后面的按钮才能在拖动层上挖出自己的洞。放到后面，反而
 *    会把按钮那块重新变回可拖动。
 * 3. 只给真正要点的元素标 `no-drag`。`button` / `input` / `textarea` / `select`
 *    已经由全局规则覆盖了，**不要给容器标**——那等于把整块从拖动带里挖掉。
 * 4. 标题栏里会随内容长大的东西（标签条、按钮组）要给拖动层留一条最小宽度的空带，
 *    见 styles.css 里 `.inspector-drag-surface` 的 `min-width`。
 * 5. 标题栏里的选择器**不要用 `:first-child`**：这一层永远排第一，写
 *    `> div:first-child` 一条也匹配不上。要按类型选就用 `:first-of-type`。
 *
 * ## 这里没有任何刷新机制，这是有意的
 *
 * 这个文件以前带着一整套「逼 Chromium 重算拖动矩形」的东西：一个 0×0 的哨兵元素、
 * 指针悬停时每 250ms 一次的轮询、按下鼠标时再刷一次、窗口 resize 刷一次、body 的
 * 子节点增删监听，以及每条标题栏各自的 ResizeObserver + MutationObserver。它们是
 * 为了治「标题栏偶发拖不动」一层层加上去的，但那个偶发失效一次都没被真正定位过，
 * 补丁只是把现场盖住，让下一轮更难查。2026-09-16 全部拆掉，回到裸结构。
 *
 * 判断基准是左侧栏顶上那条（`.sidebar-drag`）：它**从来没有失效过**，而它和这里
 * 唯一的结构差别是它是空的——上面没有压着标题文字。再出现拖不动时，请从这个差别
 * 查起，不要再往这里加刷新。
 */
export function WindowDragBar({ className }: { className?: string }): React.JSX.Element {
  // 用 span 而不是 div：标题栏里到处是 `> div` 这类选择器，多插一个 div 会把它们
  // 悄悄挪到这一层上（绝对定位之后 span 一样是块盒，显示没差别）。
  return <span className={className ? `window-drag window-drag-layer ${className}` : "window-drag window-drag-layer"} aria-hidden="true" />;
}
