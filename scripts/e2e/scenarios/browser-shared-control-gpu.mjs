// 同 browser-shared-control，但开着 GPU：画面走共享纹理时，用户直接在画面上点、打字、用下拉框照常。
export { run } from "./browser-shared-control.mjs";
export const description = "开着 GPU（页面走共享纹理）：用户和 Agent 共用同一个页面，点击、打字、输入法、下拉框照常，不抢焦点、不刷新";
export const launchOptions = { gpu: true };
