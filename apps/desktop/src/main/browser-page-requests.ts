import type { WebContents } from "electron";

/** 打印替身报信的地址：借 window.open 递到主进程（setWindowOpenHandler），不真开窗口。 */
export const PRINT_REQUEST_URL = "about:blank#coilcoil-print-request";

export function isPrintRequest(url: string): boolean {
  return url === PRINT_REQUEST_URL;
}

/**
 * 页面加载前先跑：把 window.print 换成只报信的替身。同源 iframe、页面脚本自己调的都走它
 * （每个新文档都先跑这段）。
 *
 * 报信借 window.open：新窗口请求本来就先到主进程的 setWindowOpenHandler，用不着给调试
 * 会话开 Runtime 域——那个会话和 Agent 共用，提前开着 Runtime，Agent 后连上来时就收不到
 * 页面已有的执行上下文，操作不了这张页面（实测）。open 在页面脚本跑之前就取好，页面改
 * 了 window.open 也不受影响。替身用 bind 造，`toString()` 天然是 `[native code]`，和
 * window.chrome 那段一个道理（见 browser-user-agent.ts）。
 */
export const PRINT_SCRIPT = `(() => {
  const open = window.open.bind(window);
  const print = function () { try { open("about:blank#coilcoil-print-request", "_blank"); } catch {} }.bind(null);
  Object.defineProperty(print, "name", { value: "print" });
  Object.defineProperty(window, "print", { value: print, writable: true, enumerable: true, configurable: true });
})();`;

export interface PageRequestDeps {
  /** 用户刚在这张页面上按过鼠标、按过键吗（两秒以内）：是用户要的，才弹东西。 */
  userJustActed(tabId: string): boolean;
  /** 让用户挑文件：挂在 App 窗口上的系统面板。 */
  chooseFiles(multiple: boolean): Promise<string[] | undefined>;
  /** 用户要打印：把这张页面存成 PDF 交给系统打开。 */
  printAsPdf(contents: WebContents): Promise<void>;
}

/**
 * 网页要系统窗口的两件事：选文件、打印。
 *
 * 离屏页面没有自己的可见窗口，Electron 默认的做法都会伤到用户（实测）：选文件弹一个不
 * 挂在任何窗口上的系统面板，App 一下子失去焦点，Agent 在后台点到上传按钮也一样；打印
 * 更糟，系统打印框是模态的，整个主进程卡住，App 界面和 Agent 的其他页面全跟着停。
 *
 * 所以两件都先拦下来，再看是谁要的：
 * - 选文件：Page.setInterceptFileChooserDialog 让 Chromium 不弹面板，只报一个事件。用户刚
 *   点的，就在 App 窗口上弹选文件的面板（用户自己要的）；Agent 点的什么都不弹，它的工具
 *   （upload_file）直接往文件框里放文件。
 * - 打印：window.print 换成替身，请求经 setWindowOpenHandler 到 requestPrint。用户点的，
 *   存成 PDF 用系统查看器打开，在那里打印；Agent 点的什么都不做。
 */
export class PageRequests {
  constructor(private readonly deps: PageRequestDeps) {}

  /** 调试器挂上之后、页面加载真正的网址之前调用。失败不抛：拦不住顶多回到原来的样子。 */
  async install(tabId: string, contents: WebContents): Promise<void> {
    const debug = contents.debugger;
    debug.on("message", (_event, method, params: Record<string, unknown>) => {
      if (method === "Page.fileChooserOpened") void this.onFileChooser(tabId, contents, params);
    });
    try {
      await debug.sendCommand("Page.enable");
      await debug.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
      await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: PRINT_SCRIPT });
    } catch (error) {
      console.warn("[browser] 拦截选文件、打印失败", error instanceof Error ? error.message : error);
    }
  }

  private async onFileChooser(tabId: string, contents: WebContents, params: Record<string, unknown>): Promise<void> {
    const backendNodeId = params.backendNodeId;
    if (typeof backendNodeId !== "number" || !this.deps.userJustActed(tabId)) return;
    try {
      const files = await this.deps.chooseFiles(params.mode === "selectMultiple");
      if (!files?.length || contents.isDestroyed()) return;
      await contents.debugger.sendCommand("DOM.setFileInputFiles", { files, backendNodeId });
    } catch (error) {
      console.warn("[browser] 选文件失败", error instanceof Error ? error.message : error);
    }
  }

  /** 页面调了 print()（替身经 setWindowOpenHandler 报上来）。 */
  async requestPrint(tabId: string, contents: WebContents): Promise<void> {
    if (!this.deps.userJustActed(tabId) || contents.isDestroyed()) return;
    try {
      await this.deps.printAsPdf(contents);
    } catch (error) {
      console.warn("[browser] 打印失败", error instanceof Error ? error.message : error);
    }
  }
}
