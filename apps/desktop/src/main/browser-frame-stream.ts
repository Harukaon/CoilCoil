import type { NativeImage, OffscreenSharedTexture, SharedTexture, SharedTextureImportedSubtle, WebContents } from "electron";
import { BrowserFrameLeases } from "./browser-frame-leases";
import {
  BROWSER_SURFACE_CHANNEL,
  BROWSER_SURFACE_DONE_CHANNEL,
  BROWSER_SURFACE_FRAME_CHANNEL,
  parseSurfaceRegistration,
  type BrowserSurfaceFrame,
  type BrowserSurfaceRegistration,
} from "../shared/browser-frames";

/** 用户正看着的那张要流畅；其余的只要还在渲染（AI 截图要用），不必每秒几十帧。 */
export const TEXTURE_FRAME_RATE = 60;
export const JPEG_FRAME_RATE = 30;
export const BACKGROUND_FRAME_RATE = 1;
const JPEG_QUALITY = 80;

type Size = { width: number; height: number };
type Surface = Omit<BrowserSurfaceRegistration, "attached">;

export interface SurfaceStreamDeps {
  /** Electron 的 sharedTexture；没有（或关掉了 GPU 画面）就只走 JPEG。 */
  textures?: Pick<SharedTexture, "subtle">;
  /** 页面现在多大（CSS 像素）。 */
  viewportOf(contents: WebContents): Size;
  timeoutMs?: number;
}

/**
 * 把用户正看着的那张离屏页面画到面板里。
 *
 * 首选 GPU 共享纹理：页面每画一帧，主进程把这张纹理借给桌面窗口，窗口画进画布后还
 * 回来，全程不拷贝像素，60 帧。必须用 subtle 手动传递：高层 sendSharedTexture 在沙箱
 * 预加载里会把主进程卡死（实测）。
 *
 * 退路是 JPEG（改造前的方式）：关了 GPU 时页面本来就只出位图；纹理传不过去时按需截
 * 一帧编码。慢的时候丢帧不排队：纹理最多三张、JPEG 最多一张在路上。
 *
 * 每张离屏页面的每一帧都经过 paint()：没人看的页面的纹理立刻还掉，不然页面的纹理池
 * 被占满后就不再出帧，AI 截图也会跟着卡住。
 *
 * 画布刚挂上、刚开始看一张页面时要主动要一帧：页面静止时不出新帧，画布是空的或者是旧
 * 画面（没人看的时候那些帧都还掉了）。
 */
export class BrowserSurfaceStream {
  private target?: { tabId: string; contents: WebContents };
  private surface?: Surface;
  /** 窗口收不下纹理（预加载报错）：这次运行里都用 JPEG。 */
  private texturesBroken = false;
  /** 纹理发出去超时没还：先改用 JPEG 让画面继续动，等卡住的都还回来再换回纹理。 */
  private texturesStalled = false;
  /** 页面最近出的是位图（GPU 关着、页面刚建好还没接上 GPU）：一秒 30 帧就够，多画的也发不出去。 */
  private paintsBitmaps = false;
  private pendingJpeg?: { tabId: string; contents: WebContents; image?: NativeImage };
  private jpegTimer?: ReturnType<typeof setTimeout>;
  private lastJpegAt = 0;
  /** 给正在看的页面设过的帧率：每帧都核对一遍，状态怎么变都不会卡在错的帧率上。 */
  private appliedRate?: number;
  /**
   * App 窗口现在看得见吗。最小化、隐藏、被别的窗口完全挡住时看不见：正看着的那张也按后台的
   * 一秒一帧画（省电，页面自己的动画也跟着慢下来），但还照常往面板送——画面不会停在很久以前。
   */
  private displayed = true;
  private readonly leases: BrowserFrameLeases;
  private readonly cleanups: Array<() => void> = [];
  /** 发出去多少帧、因为窗口跟不上丢了多少：排查、测试用。 */
  readonly stats = { texture: 0, jpeg: 0, dropped: 0 };

  constructor(private readonly host: WebContents, private readonly deps: SurfaceStreamDeps) {
    this.leases = new BrowserFrameLeases((mode) => {
      if (mode === "texture") this.stallTextures();
    }, deps.timeoutMs);
    const onSurface = (_event: unknown, raw: unknown): void => this.onSurface(raw);
    const onDone = (_event: unknown, id: unknown, failed: unknown): void => this.onDone(id, failed === true);
    // 桌面窗口重载、崩溃、关掉：那边的页面没了，在路上的纹理不会再有人读，全部收回。
    const onHostGone = (): void => this.resetHost();
    host.ipc.on(BROWSER_SURFACE_CHANNEL, onSurface);
    host.ipc.on(BROWSER_SURFACE_DONE_CHANNEL, onDone);
    host.on("did-navigate", onHostGone);
    host.on("render-process-gone", onHostGone);
    host.on("destroyed", onHostGone);
    this.cleanups.push(() => {
      host.ipc.off(BROWSER_SURFACE_CHANNEL, onSurface);
      host.ipc.off(BROWSER_SURFACE_DONE_CHANNEL, onDone);
      host.off("did-navigate", onHostGone);
      host.off("render-process-gone", onHostGone);
      host.off("destroyed", onHostGone);
    });
  }

  /** 用户正看着哪张（面板收起、看的不是离屏页面时传 undefined）。 */
  watch(tabId: string | undefined, contents: WebContents | undefined): void {
    if (this.target?.tabId === tabId && this.target?.contents === contents) return;
    this.stop();
    if (!tabId || !contents || contents.isDestroyed()) return;
    this.target = { tabId, contents };
    this.applyFrameRate();
    // 没人看的这段时间页面可能变过（那些帧都还掉了），画布上是旧画面：先要一帧。
    this.requestFreshFrame();
  }

  /** App 窗口看得见、看不见了。重新露出来时先要一帧新的，马上回到流畅。 */
  setDisplayed(displayed: boolean): void {
    if (this.displayed === displayed) return;
    this.displayed = displayed;
    this.applyFrameRate();
    if (displayed) this.requestFreshFrame();
  }

  stop(): void {
    if (this.jpegTimer) clearTimeout(this.jpegTimer);
    this.jpegTimer = undefined;
    this.pendingJpeg = undefined;
    const target = this.target;
    this.target = undefined;
    this.appliedRate = undefined;
    if (target && !target.contents.isDestroyed()) target.contents.setFrameRate(BACKGROUND_FRAME_RATE);
  }

  dispose(): void {
    this.stop();
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // 窗口已经销毁时摘监听可能报错，无所谓。
      }
    }
    this.resetHost();
  }

  /** 每张离屏页面每画一帧都走这里（见 createOffscreenPage）。 */
  paint(tabId: string, contents: WebContents, texture: OffscreenSharedTexture | undefined, image: NativeImage): void {
    const watched = this.target?.tabId === tabId && this.target.contents === contents;
    const surface = watched && this.surface?.tabId === tabId ? this.surface : undefined;
    if (texture) {
      this.notePaintKind(false);
      // 弹层（Windows 上 Chromium 自己画的下拉框、日期选择）另出一帧，不能当整页画；
      // 下拉框由面板自己画，其余的留到后续细节阶段。
      if (!surface || texture.textureInfo.widgetType !== "frame") {
        texture.release();
        return;
      }
      if (this.texturesUsable()) {
        this.sendTexture(surface, contents, texture);
        return;
      }
      texture.release();
      this.queueJpeg(tabId, contents);
      return;
    }
    // 纹理模式下 invalidate() 会来一个空位图，不算数。
    if (!watched || image.isEmpty()) return;
    this.notePaintKind(true);
    if (surface) this.queueJpeg(tabId, contents, image);
  }

  /** 页面出纹理还是位图，按最近一帧算：页面刚建好时可能先出几帧位图，不能从此锁在 30 帧。 */
  private notePaintKind(bitmap: boolean): void {
    this.paintsBitmaps = bitmap;
    this.applyFrameRate();
  }

  /**
   * 要一帧新画面。实测：位图模式（关着 GPU）invalidate() 就出一帧；纹理模式下页面静止时
   * invalidate() 只来一个空位图，停一下再开始画才出一帧纹理，页面自己看不出来（仍是可见）。
   * 两个都做，不用先知道是哪种。
   */
  private requestFreshFrame(): void {
    const target = this.target;
    if (!target || target.contents.isDestroyed()) return;
    target.contents.invalidate();
    target.contents.stopPainting();
    target.contents.startPainting();
  }

  private texturesUsable(): boolean {
    return Boolean(this.surface?.sharedTexture && this.deps.textures) && !this.texturesBroken && !this.texturesStalled;
  }

  private sendTexture(surface: Surface, contents: WebContents, texture: OffscreenSharedTexture): void {
    if (!this.leases.canSend("texture")) {
      // 窗口还没画完前面几帧：丢掉这一帧，下一帧是更新的画面。
      this.stats.dropped++;
      texture.release();
      return;
    }
    let imported: SharedTextureImportedSubtle | undefined;
    let transfer;
    try {
      imported = this.deps.textures!.subtle.importSharedTexture(texture.textureInfo);
      transfer = imported.startTransferSharedTexture();
    } catch (error) {
      if (imported) imported.release(() => texture.release());
      else texture.release();
      this.breakTextures(error);
      this.queueJpeg(surface.tabId, contents);
      return;
    }
    const owned = imported;
    // 两头都还完了（窗口画完、主进程这份引用释放）才把纹理还给页面。
    const id = this.leases.add("texture", () => owned.release(() => texture.release()));
    const { width, height } = texture.textureInfo.visibleRect;
    const sent = this.post({
      id, surfaceId: surface.surfaceId, tabId: surface.tabId, mode: "texture", transfer,
      width, height, viewport: this.deps.viewportOf(contents),
    });
    if (sent) this.stats.texture++;
    else this.leases.complete(id);
  }

  private queueJpeg(tabId: string, contents: WebContents, image?: NativeImage): void {
    this.pendingJpeg = { tabId, contents, image };
    if (this.jpegTimer) return;
    const wait = Math.max(0, this.lastJpegAt + 1000 / JPEG_FRAME_RATE - Date.now());
    this.jpegTimer = setTimeout(() => {
      this.jpegTimer = undefined;
      void this.flushJpeg();
    }, wait);
  }

  private async flushJpeg(): Promise<void> {
    const pending = this.pendingJpeg;
    const surface = pending && this.surface?.tabId === pending.tabId ? this.surface : undefined;
    if (!pending || !surface || pending.contents.isDestroyed()) {
      this.pendingJpeg = undefined;
      return;
    }
    // 上一帧还没画完：等它还回来再发，那时发的是最新的这帧。
    if (!this.leases.canSend("jpeg")) return;
    this.pendingJpeg = undefined;
    this.lastJpegAt = Date.now();
    const id = this.leases.add("jpeg", () => this.resumeJpeg());
    try {
      // 页面出的是纹理、但纹理暂时用不了时，按需截一帧。
      const image = pending.image ?? await pending.contents.capturePage();
      const { width, height } = image.getSize();
      const sent = !image.isEmpty() && width > 0 && height > 0 && this.surface === surface && this.post({
        id, surfaceId: surface.surfaceId, tabId: surface.tabId, mode: "jpeg", data: image.toJPEG(JPEG_QUALITY),
        width, height, viewport: this.deps.viewportOf(pending.contents),
      });
      if (sent) this.stats.jpeg++;
      else this.leases.complete(id);
    } catch {
      this.leases.complete(id);
    }
  }

  private resumeJpeg(): void {
    const pending = this.pendingJpeg;
    if (pending) this.queueJpeg(pending.tabId, pending.contents, pending.image);
  }

  private post(frame: BrowserSurfaceFrame): boolean {
    if (this.host.isDestroyed()) return false;
    try {
      this.host.send(BROWSER_SURFACE_FRAME_CHANNEL, frame);
      return true;
    } catch {
      return false;
    }
  }

  private onSurface(raw: unknown): void {
    const registration = parseSurfaceRegistration(raw);
    if (!registration) return;
    if (!registration.attached) {
      if (this.surface?.surfaceId === registration.surfaceId) this.surface = undefined;
      return;
    }
    this.surface = { tabId: registration.tabId, surfaceId: registration.surfaceId, sharedTexture: registration.sharedTexture };
    const target = this.target;
    if (target?.tabId !== registration.tabId || target.contents.isDestroyed()) return;
    this.applyFrameRate();
    // 新挂上的画布是空的：要一帧，不等页面自己动。
    this.requestFreshFrame();
  }

  private onDone(id: unknown, failed: boolean): void {
    if (typeof id !== "number") return;
    if (failed) this.breakTextures(new Error("窗口收不下 GPU 纹理"));
    this.leases.complete(id);
    if (this.texturesStalled && this.leases.count("texture") === 0) {
      this.texturesStalled = false;
      this.applyFrameRate();
    }
  }

  private stallTextures(): void {
    if (this.texturesStalled) return;
    this.texturesStalled = true;
    console.warn("[browser] GPU 画面迟迟没还回来，暂时改用普通画面");
    this.applyFrameRate();
    const target = this.target;
    if (target && !target.contents.isDestroyed()) target.contents.invalidate();
  }

  private breakTextures(reason: unknown): void {
    if (this.texturesBroken) return;
    this.texturesBroken = true;
    console.warn("[browser] GPU 画面不可用，改用普通画面", reason instanceof Error ? reason.message : reason);
    this.applyFrameRate();
  }

  private applyFrameRate(): void {
    const target = this.target;
    if (!target || target.contents.isDestroyed()) return;
    const rate = !this.displayed ? BACKGROUND_FRAME_RATE
      : this.texturesUsable() && !this.paintsBitmaps ? TEXTURE_FRAME_RATE : JPEG_FRAME_RATE;
    if (rate === this.appliedRate) return;
    this.appliedRate = rate;
    target.contents.setFrameRate(rate);
  }

  private resetHost(): void {
    this.surface = undefined;
    this.pendingJpeg = undefined;
    this.texturesStalled = false;
    this.leases.dispose();
  }
}
