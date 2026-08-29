/**
 * 「回到底部」箭头什么时候露面。
 *
 * 原来的判定是「只要不贴底就显示」（离底 48px 起），往上滚一点点、甚至只是
 * 内容长高了一行，箭头就跳出来，而这时候用户根本没走远，一个箭头反而是打扰。
 *
 * 现在用两个固定阈值，显示和隐藏各一条：往上滚过 SHOW 才出现，滚回 HIDE 以内
 * 才收起。两条线拉开距离（迟滞），是因为一条线时用户停在临界点上、或者流式
 * 回复每写一行就把内容顶高一点，距离会在这条线两侧来回穿，箭头就一闪一闪。
 *
 * 阈值是写死的像素数，不按视口高度算：本项目 UI 阈值的口径是「简单的固定阈值，
 * 不做会来回翻转的布局测量」。360px 大约是一屏对话的三分之一到一半，够得上
 * 「我确实往回翻了」；120px 大约是一条消息的高度，回到这个范围就算回来了。
 */
export const SCROLL_DOWN_SHOW_DISTANCE = 360;
export const SCROLL_DOWN_HIDE_DISTANCE = 120;

/**
 * 给定当前是否显示、以及离底部还有多远，算出下一刻是否显示。
 *
 * @param visible 箭头当前是否已经显示
 * @param distance 视口底边离内容底部的距离（像素，贴底为 0）
 */
export function nextScrollDownVisible(visible: boolean, distance: number): boolean {
  return visible ? distance > SCROLL_DOWN_HIDE_DISTANCE : distance > SCROLL_DOWN_SHOW_DISTANCE;
}
