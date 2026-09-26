import { BrowserWindow, screen, type NativeImage, type OffscreenSharedTexture, type WebContents } from "electron";
import { BACKGROUND_FRAME_RATE } from "./browser-frame-stream";
import { browserPagePreferences } from "./browser-page-policy";

/**
 * 内置浏览器的每张标签页：离屏渲染的页面。
 *
 * Chromium 在把一次鼠标按下、触摸、点按派发给某个页面之前，会无条件地把焦点交给那个
 * 页面（RenderWidgetHostImpl::OnInputEventPreDispatch → FocusOwningWebContents）。
 * 页面嵌在 App 窗口里（<webview>）时，Agent 一点击，焦点就从用户正在打字的输入框
 * 挪进网页，接着打的字全进了网页——这是 Chromium 的规则，绕不开。
 *
 * 所以页面不嵌进窗口：每张标签页一个隐藏、离屏的 BrowserWindow。它不在任何
 * 可见窗口的焦点链上，Chromium 那条规则只在它自己身上生效，用户的焦点不受影响；输入
 * 照样是真实的输入（CDP 的鼠标、键盘），网站看到的也是真实事件。画面通过 paint 事件
 * 拿出来（有 GPU 时是共享纹理，见 browser-frame-stream.ts），画在面板里；用户在画面上
 * 的操作转进页面（browser-input.ts）。
 *
 * 为什么是 BrowserWindow 而不是不挂窗口的 WebContentsView：离屏页面的大小取自承载它
 * 的窗口，不挂窗口的视图是 0×0，什么都不渲染，点击落空、截图卡死；挂在 App 窗口上
 * 又只能和 App 窗口一样大。每张标签页一个自己的窗口，才能各自设大小。
 */
export function createOffscreenPage(
  partition: string,
  size: { width: number; height: number },
  /** 页面每画一帧都交出来：有人看就画到面板里，没人看就立刻还掉纹理。 */
  onPaint: (contents: WebContents, texture: OffscreenSharedTexture | undefined, image: NativeImage) => void,
): BrowserWindow {
  const page = new BrowserWindow({
    show: false,
    // 双保险：这个窗口永远不该成为系统焦点窗口，也不该出现在任务栏、窗口切换里。
    focusable: false,
    skipTaskbar: true,
    frame: false,
    useContentSize: true,
    width: size.width,
    height: size.height,
    webPreferences: browserPagePreferences({ partition, deviceScaleFactor: displayScale(), sharedTexture: sharedTextureFrames() }),
  });
  page.webContents.setFrameRate(BACKGROUND_FRAME_RATE);
  const contents = page.webContents;
  contents.on("paint", (event, _dirty, image) => onPaint(contents, event.texture, image));
  return page;
}

/**
 * 页面画面走 GPU 共享纹理。出问题时设 COILCOIL_BROWSER_GPU_FRAMES=0 退回改造前的 JPEG
 * 画面（新开的页面生效），不用发新版。关了 GPU 的机器上页面本来就只出位图，自动退回。
 */
export function sharedTextureFrames(): boolean {
  return process.env.COILCOIL_BROWSER_GPU_FRAMES !== "0";
}

export function resizeOffscreenPage(page: BrowserWindow, size: { width: number; height: number }): void {
  if (page.isDestroyed()) return;
  const [width, height] = page.getContentSize();
  if (width === size.width && height === size.height) return;
  page.setContentSize(size.width, size.height);
  // 静止的页面改完大小不一定马上重画，主动要一帧，界面上立刻换成新尺寸的画面。
  page.webContents.invalidate();
}

function displayScale(): number {
  try {
    return screen.getPrimaryDisplay().scaleFactor || 1;
  } catch {
    return 1;
  }
}
