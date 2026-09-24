import type { WebContents } from "electron";

/**
 * Agent 往内置浏览器的网页里输入时，焦点怎么处理（renderer 那一半见
 * renderer/src/features/browser/focusReturn.ts）。
 *
 * CDP 的键盘和输入法命令（Input.insertText / dispatchKeyEvent / imeSetComposition）
 * 是发给「当前有焦点的那个页面」的：焦点要是在 App 里用户的输入框上，Agent 打的字会
 * 直接进用户的输入框。所以这类命令发出前先把焦点给网页，保证字进网页。
 *
 * 同时告诉 App：Agent 这一阵还在输入，焦点先别要回去；等这阵输入停下来，App 再把焦点
 * 和光标还给用户原来所在的地方。
 */
export const BROWSER_AGENT_INPUT_CHANNEL = "browser:agent-input";

/** 一阵输入里两条命令之间的空档（fill 是清空、逐字输入好几条）不会超过这么久。 */
export const AGENT_INPUT_HOLD_MS = 800;

const KEYBOARD_METHODS = new Set(["Input.insertText", "Input.dispatchKeyEvent", "Input.imeSetComposition"]);

export function prepareAgentInput(guest: WebContents, method: string, params: Record<string, unknown>): void {
  if (!method.startsWith("Input.")) return;
  // 鼠标只是移过去不会动焦点，也不算在输入。
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") return;
  guest.hostWebContents?.send(BROWSER_AGENT_INPUT_CHANNEL, AGENT_INPUT_HOLD_MS);
  if (KEYBOARD_METHODS.has(method)) guest.focus();
}
