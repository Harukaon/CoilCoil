/**
 * 整窗透明度。
 *
 * 走的是 `BrowserWindow.setOpacity()`——整扇窗（含文字）一起变透，而不是 macOS
 * 那种「背景毛玻璃、文字仍然实心」的 vibrancy。选它是因为 vibrancy 要求窗口以
 * `transparent: true` 创建，而且界面里每一层表面都得改成半透明背景色；CoilCoil
 * 的颜色令牌全是实心的，那样改等于把整套配色重做一遍，而且暗色下极容易糊。
 * 整窗透明度只有一个数值，随时可调、不用重启，也不挑主题。
 *
 * 代价是文字也会跟着透一点，所以下限卡在 0.7：再往下正文就开始发虚了。
 *
 * Linux 上 Electron 不实现 setOpacity（取决于合成器），调用是空操作，不报错。
 *
 * 存一份在 userData 里而不是只放渲染进程的 localStorage：localStorage 要等页面
 * 加载完才读得到，窗口会先按不透明显示再跳一下。存在主进程这边就能在 show()
 * 之前应用好。
 */
import { readFileSync, writeFileSync } from "node:fs";

export const WINDOW_OPACITY_MIN = 0.7;
export const WINDOW_OPACITY_MAX = 1;

/** 把任意输入收敛成一个能直接交给 setOpacity 的值；读不懂就当「不透明」。 */
export function resolveWindowOpacity(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return WINDOW_OPACITY_MAX;
  return Math.min(WINDOW_OPACITY_MAX, Math.max(WINDOW_OPACITY_MIN, numeric));
}

/** 读持久化的透明度。文件不存在、读坏了、写的不是数字，一律回落到不透明。 */
export function readStoredWindowOpacity(file: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return WINDOW_OPACITY_MAX;
    return resolveWindowOpacity((parsed as { opacity?: unknown }).opacity);
  } catch {
    return WINDOW_OPACITY_MAX;
  }
}

/**
 * 写回持久化的透明度，返回真正落盘的那个值。
 *
 * 写失败（磁盘满、目录只读）不抛：一个外观偏好不值得把设置界面搞崩，下次启动
 * 回落到上一次的值就行。
 */
export function writeStoredWindowOpacity(file: string, value: unknown): number {
  const opacity = resolveWindowOpacity(value);
  try {
    writeFileSync(file, `${JSON.stringify({ opacity }, null, 2)}\n`, "utf8");
  } catch {
    // 忽略：见上。
  }
  return opacity;
}
