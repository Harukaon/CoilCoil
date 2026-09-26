// 同 browser-background，但开着 GPU：页面画面走共享纹理时，AI 在后台照样截图、点击。
export { run } from "./browser-background.mjs";
export const description = "开着 GPU（页面走共享纹理）：窗口最小化、应用隐藏、右侧栏收起时，AI 跳到另一个网站后照样能截图、能点";
export const launchOptions = { gpu: true };
