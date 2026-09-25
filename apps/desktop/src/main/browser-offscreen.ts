import { BrowserWindow, screen, type NativeImage, type WebContents } from "electron";
import type { BrowserFrame } from "../shared/desktop-api";

/**
 * Agent 用的标签页：离屏渲染的页面。
 *
 * Chromium 在把一次鼠标按下、触摸、点按派发给某个页面之前，会无条件地把焦点交给那个
 * 页面（RenderWidgetHostImpl::OnInputEventPreDispatch → FocusOwningWebContents）。
 * 页面嵌在 App 窗口里（<webview>）时，Agent 一点击，焦点就从用户正在打字的输入框
 * 挪进网页，接着打的字全进了网页——这是 Chromium 的规则，绕不开。
 *
 * 所以 Agent 的页面不嵌进窗口：每张标签页一个隐藏、离屏的 BrowserWindow。它不在任何
 * 可见窗口的焦点链上，Chromium 那条规则只在它自己身上生效，用户的焦点不受影响；输入
 * 照样是真实的输入（CDP 的鼠标、键盘），网站看到的也是真实事件。画面通过 paint 事件
 * 拿出来，画在面板里给用户看；用户要自己操作时「接管」，换成正常的 <webview>。
 *
 * 为什么是 BrowserWindow 而不是不挂窗口的 WebContentsView：离屏页面的大小取自承载它
 * 的窗口，不挂窗口的视图是 0×0，什么都不渲染，点击落空、截图卡死；挂在 App 窗口上
 * 又只能和 App 窗口一样大。每张标签页一个自己的窗口，才能各自设大小。
 */
export function createOffscreenPage(partition: string, size: { width: number; height: number }): BrowserWindow {
  const page = new BrowserWindow({
    show: false,
    // 双保险：这个窗口永远不该成为系统焦点窗口，也不该出现在任务栏、窗口切换里。
    focusable: false,
    skipTaskbar: true,
    frame: false,
    useContentSize: true,
    width: size.width,
    height: size.height,
    webPreferences: {
      offscreen: { deviceScaleFactor: displayScale() },
      partition,
      // 和 <webview> guest 同一套加固（见 browser-webview-policy.ts）。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  page.webContents.setFrameRate(BACKGROUND_FRAME_RATE);
  return page;
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

/** 用户正看着的那张出画面要流畅；其余的只要还在渲染（截图要用），不必每秒几十帧。 */
const VISIBLE_FRAME_RATE = 30;
const BACKGROUND_FRAME_RATE = 1;
const FRAME_QUALITY = 80;

/**
 * 把「用户正看着的那张 Agent 标签页」的画面送给界面。
 *
 * 同一时刻只看一张：换标签、面板收起时换目标或停下。paint 事件比界面画得快时只留
 * 最新一帧，按帧率节拍发出去，不堆积。
 */
export class OffscreenFrameStream {
  private target?: { tabId: string; contents: WebContents; listener: (event: unknown, dirty: unknown, image: NativeImage) => void };
  private latest?: NativeImage;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly send: (frame: BrowserFrame) => void) {}

  watch(tabId: string | undefined, contents: WebContents | undefined): void {
    if (this.target?.tabId === tabId && this.target?.contents === contents) return;
    this.stop();
    if (!tabId || !contents || contents.isDestroyed()) return;
    const listener = (_event: unknown, _dirty: unknown, image: NativeImage): void => { this.latest = image; };
    contents.on("paint", listener);
    contents.setFrameRate(VISIBLE_FRAME_RATE);
    this.target = { tabId, contents, listener };
    // 页面静止时不出新帧，先要一帧，面板一打开就有画面。
    contents.invalidate();
    this.timer = setInterval(() => this.flush(), Math.round(1000 / VISIBLE_FRAME_RATE));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.latest = undefined;
    const target = this.target;
    this.target = undefined;
    if (!target || target.contents.isDestroyed()) return;
    target.contents.off("paint", target.listener);
    target.contents.setFrameRate(BACKGROUND_FRAME_RATE);
  }

  private flush(): void {
    const image = this.latest;
    const target = this.target;
    if (!image || !target) return;
    this.latest = undefined;
    const { width, height } = image.getSize();
    if (width <= 0 || height <= 0) return;
    this.send({ tabId: target.tabId, width, height, data: image.toJPEG(FRAME_QUALITY) });
  }
}
