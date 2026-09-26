import { ipcRenderer, sharedTexture } from "electron";
import {
  BROWSER_SURFACE_CHANNEL,
  BROWSER_SURFACE_DONE_CHANNEL,
  BROWSER_SURFACE_FRAME_CHANNEL,
  type BrowserSurfaceFrame,
  type BrowserSurfaceRegistration,
} from "../shared/browser-frames";
import type { BrowserSurfaceInfo } from "../shared/desktop-api";

/**
 * 面板里的页面画面：主进程借来的 GPU 纹理（或 JPEG）直接画进界面交来的画布。
 *
 * 纹理只在预加载里经手，界面脚本拿不到。每一帧画完立刻还（主进程收到才把纹理还给
 * 页面）；画布不在了、画失败了也照样还，不能让页面等一张永远不回来的纹理。
 */
interface Surface {
  tabId: string;
  canvas: HTMLCanvasElement;
  onInfo: (info: BrowserSurfaceInfo) => void;
  context?: CanvasRenderingContext2D | null;
  infoKey?: string;
  /** 画过的最新一帧：JPEG 解码有快有慢，晚到的旧帧不能盖住新帧。 */
  lastFrame: number;
}

const surfaces = new Map<string, Surface>();
/** 这里收不收得了 GPU 纹理（平台不支持时没有这个模块，主进程就只发 JPEG）。 */
const canImportTextures = typeof sharedTexture?.subtle?.finishTransferSharedTexture === "function";

function register(registration: BrowserSurfaceRegistration): void {
  ipcRenderer.send(BROWSER_SURFACE_CHANNEL, registration);
}

function done(id: number, failed = false): void {
  ipcRenderer.send(BROWSER_SURFACE_DONE_CHANNEL, id, failed);
}

function draw(surface: Surface, source: CanvasImageSource, width: number, height: number, frame: BrowserSurfaceFrame): void {
  const canvas = surface.canvas;
  if (!canvas.isConnected || frame.id < surface.lastFrame || width <= 0 || height <= 0) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  // 页面总是画满不透明的底色，画布不要透明通道，合成时省一步。
  surface.context ??= canvas.getContext("2d", { alpha: false });
  if (!surface.context) return;
  surface.context.drawImage(source, 0, 0, width, height);
  surface.lastFrame = frame.id;
  // 大小、方式变了才告诉界面，不是每帧都让界面重画一遍。
  const key = `${width}x${height} ${frame.viewport.width}x${frame.viewport.height} ${frame.mode}`;
  if (key === surface.infoKey) return;
  surface.infoKey = key;
  surface.onInfo({ width, height, viewport: { ...frame.viewport }, mode: frame.mode });
}

function receiveTexture(frame: Extract<BrowserSurfaceFrame, { mode: "texture" }>): void {
  let imported: Electron.SharedTextureImportedSubtle;
  try {
    imported = sharedTexture.subtle.finishTransferSharedTexture(frame.transfer);
  } catch (error) {
    console.warn("[browser] 收不下页面的 GPU 画面，改用普通画面", error);
    done(frame.id, true);
    return;
  }
  let failed = false;
  try {
    const surface = surfaces.get(frame.surfaceId);
    if (surface) {
      const video = imported.getVideoFrame();
      try {
        draw(surface, video, video.displayWidth, video.displayHeight, frame);
      } finally {
        video.close();
      }
    }
  } catch (error) {
    failed = true;
    console.warn("[browser] 画页面的 GPU 画面失败，改用普通画面", error);
  } finally {
    // 这边的引用释放完再回执：主进程收到回执才会把纹理还给页面。
    imported.release(() => done(frame.id, failed));
  }
}

function receiveJpeg(frame: Extract<BrowserSurfaceFrame, { mode: "jpeg" }>): void {
  const surface = surfaces.get(frame.surfaceId);
  if (!surface) {
    done(frame.id);
    return;
  }
  // 解码不占界面线程；画完（或者失败）才回执，主进程据此发下一帧。
  void createImageBitmap(new Blob([frame.data as BlobPart], { type: "image/jpeg" }))
    .then((bitmap) => {
      try {
        draw(surface, bitmap, bitmap.width, bitmap.height, frame);
      } finally {
        bitmap.close();
      }
    })
    .catch(() => undefined)
    .finally(() => done(frame.id));
}

ipcRenderer.on(BROWSER_SURFACE_FRAME_CHANNEL, (_event, frame: BrowserSurfaceFrame) => {
  if (frame?.mode === "texture") receiveTexture(frame);
  else if (frame?.mode === "jpeg") receiveJpeg(frame);
});

export function attachBrowserSurface(tabId: string, canvas: HTMLCanvasElement, onInfo: (info: BrowserSurfaceInfo) => void): () => void {
  if (typeof tabId !== "string" || !(canvas instanceof HTMLCanvasElement) || typeof onInfo !== "function") {
    throw new TypeError("挂画布的参数不对。");
  }
  const surfaceId = crypto.randomUUID();
  surfaces.set(surfaceId, { tabId, canvas, onInfo, lastFrame: 0 });
  register({ tabId, surfaceId, attached: true, sharedTexture: canImportTextures });
  return () => {
    if (!surfaces.delete(surfaceId)) return;
    register({ tabId, surfaceId, attached: false, sharedTexture: canImportTextures });
  };
}
