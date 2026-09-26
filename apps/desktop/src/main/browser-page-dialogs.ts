import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { BrowserPageDialog } from "../shared/desktop-api";

/** Electron 发给我们的网页对话框（内部事件 `-run-dialog`）。 */
interface RunDialogInfo {
  frame?: { url?: string };
  dialogType?: string;
  messageText?: string;
  defaultPromptText?: string;
}

type Reply = (success: boolean, userInput: string) => void;

/**
 * 网页自己弹的 alert / confirm / prompt，改在面板里回答，不弹系统对话框。
 *
 * Electron 默认给离屏页面弹一个不挂在任何窗口上的系统对话框：它会一下子把用户的键盘
 * 焦点抢走，Agent 在后台点到一个会弹 alert 的按钮，用户正在打的字就打进了对话框里。
 * 这里把 Electron 的处理换掉（`-run-dialog` 是 Electron 内部事件，升级时要回归），
 * 对话框挂在那张标签页上：面板显示一张卡片，用户点了再回答；Agent 照样可以用 CDP
 * （Page.handleJavaScriptDialog）回答，谁先答算谁的，另一边的卡片随之消失。
 *
 * 一张页面同一时刻只有一个对话框：它弹着的时候页面脚本是停住的。
 */
export class PageDialogs {
  private readonly pending = new Map<string, BrowserPageDialog & { reply: Reply }>();

  /** 某张标签页的对话框出现或消失了，界面要刷新。 */
  constructor(private readonly changed: (tabId: string) => void) {}

  install(tabId: string, contents: WebContents): void {
    // Electron 的 WebContents 本身就是事件发射器，内部事件没有类型，只能这样挂。
    const emitter = contents as unknown as NodeJS.EventEmitter;
    emitter.removeAllListeners("-run-dialog");
    emitter.on("-run-dialog", (info: RunDialogInfo, reply: Reply) => this.open(tabId, info, reply));
    // 页面跳走、Chromium 自己取消了对话框（比如 Agent 用 CDP 答了），卡片都要收起来。
    emitter.on("-cancel-dialogs", () => this.drop(tabId));
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.drop(tabId);
    });
    contents.debugger.on("message", (_event, method) => {
      if (method === "Page.javascriptDialogClosed") this.drop(tabId);
    });
    contents.once("destroyed", () => this.drop(tabId));
  }

  /** 页面对话框关掉的事件要靠调试器的 Page 域报上来；Agent 没连着时也要开着。 */
  async watch(contents: WebContents): Promise<void> {
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
    await contents.debugger.sendCommand("Page.enable").catch(() => undefined);
  }

  snapshot(tabId: string): BrowserPageDialog | undefined {
    const dialog = this.pending.get(tabId);
    if (!dialog) return undefined;
    const { reply: _reply, ...visible } = dialog;
    return visible;
  }

  /** 用户在面板里答了。id 对不上（卡片过时了、已经被 Agent 答过）就什么都不做。 */
  reply(tabId: string, dialogId: string, accept: boolean, text: string): boolean {
    const dialog = this.pending.get(tabId);
    if (!dialog || dialog.id !== dialogId) return false;
    this.pending.delete(tabId);
    dialog.reply(dialog.type === "alert" ? true : accept, dialog.type === "prompt" && accept ? text.slice(0, 10_000) : "");
    this.changed(tabId);
    return true;
  }

  private open(tabId: string, info: RunDialogInfo, reply: Reply): void {
    const type = info.dialogType === "confirm" || info.dialogType === "prompt" ? info.dialogType : "alert";
    // 同一张页面上一个还没答的对话框已经不作数了（页面脚本不会同时等两个）。
    this.pending.get(tabId)?.reply(false, "");
    this.pending.set(tabId, {
      id: randomUUID(),
      type,
      message: String(info.messageText ?? "").slice(0, 10_000),
      defaultPrompt: type === "prompt" ? String(info.defaultPromptText ?? "").slice(0, 10_000) : "",
      origin: originOf(info.frame?.url),
      reply,
    });
    this.changed(tabId);
  }

  private drop(tabId: string): void {
    if (this.pending.delete(tabId)) this.changed(tabId);
  }
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host || new URL(url).origin : "";
  } catch {
    return "";
  }
}
