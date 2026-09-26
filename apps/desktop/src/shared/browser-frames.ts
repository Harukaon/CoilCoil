import type { SharedTextureTransfer } from "electron";

/**
 * 页面画面怎么从主进程到面板：主进程和桌面窗口预加载之间的内部通道。
 *
 * 纹理只在这两者之间走，界面脚本（React）拿不到，网页更拿不到：界面只把画布交给
 * 预加载（attachBrowserSurface），拿回「画面多大、用的哪种方式」。
 */
export const BROWSER_SURFACE_CHANNEL = "browser:surface";
export const BROWSER_SURFACE_FRAME_CHANNEL = "browser:surface-frame";
export const BROWSER_SURFACE_DONE_CHANNEL = "browser:surface-done";

/** 面板里的画布挂上、摘下时告诉主进程；sharedTexture 说明这个窗口收不收得了 GPU 纹理。 */
export interface BrowserSurfaceRegistration {
  tabId: string;
  surfaceId: string;
  attached: boolean;
  sharedTexture: boolean;
}

interface SurfaceFrameBase {
  /** 画完要还回去的凭据：主进程按它归还纹理、决定下一帧什么时候发。 */
  id: number;
  surfaceId: string;
  tabId: string;
  /** 画面的像素大小（页面大小乘屏幕缩放）。 */
  width: number;
  height: number;
  /** 这一帧画的页面有多大（CSS 像素）：用户点画面时按它换算成页面上的位置。 */
  viewport: { width: number; height: number };
}

/** GPU 共享纹理（不拷贝像素，60 帧）；GPU 用不了、纹理传不过去时是 JPEG（改造前的方式）。 */
export type BrowserSurfaceFrame =
  | SurfaceFrameBase & { mode: "texture"; transfer: SharedTextureTransfer }
  | SurfaceFrameBase & { mode: "jpeg"; data: Uint8Array };

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

/** 预加载送来的挂载消息不直接信：结构不对的丢掉。 */
export function parseSurfaceRegistration(value: unknown): BrowserSurfaceRegistration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!text(record.tabId) || !text(record.surfaceId)) return undefined;
  if (typeof record.attached !== "boolean" || typeof record.sharedTexture !== "boolean") return undefined;
  return { tabId: record.tabId, surfaceId: record.surfaceId, attached: record.attached, sharedTexture: record.sharedTexture };
}
