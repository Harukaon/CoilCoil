import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme } from "electron";
import type { BubbleSessionTarget, BubbleShortcutState } from "../shared/desktop-api";

export const BUBBLE_HIDE_CHANNEL = "bubble:hide";
export const BUBBLE_OPEN_MAIN_CHANNEL = "bubble:open-main";
export const BUBBLE_OPEN_SESSION_CHANNEL = "bubble:open-session";
export const BUBBLE_GET_SHORTCUT_CHANNEL = "bubble:get-shortcut";
export const BUBBLE_SET_SHORTCUT_CHANNEL = "bubble:set-shortcut";

/**
 * A suggestion, not a default.
 *
 * Nothing is registered until the user asks for it: a global shortcut is taken
 * from every other application on the machine, and claiming one uninvited is
 * how an app silently breaks something the user already relies on.
 */
export const SUGGESTED_BUBBLE_SHORTCUT = "CommandOrControl+Shift+Space";

/**
 * 快速提问气泡整条功能暂时停用（#39）。
 *
 * 用户把 Ctrl+E 设成了呼出这个气泡，但这个功能本身还没做完、也没什么用，所以停的
 * 不只是那一个组合键，而是整条入口：不注册全局快捷键、不挂 IPC、也不建那扇窗；
 * 设置里的「快捷键」栏目同步撤掉了（见 SettingsDialog.tsx），所以也没有地方能再设
 * 一次。让出来的 Ctrl+E 就回到它原本该去的地方，比如终端里的「跳到行尾」。
 *
 * 只是停用，不是删除。这个文件、气泡的界面、设置页面都原样留着：把这里改回 true、
 * 再把设置里那个栏目按钮放回去，功能就回来了。用户以前存下的组合键还躺在
 * userData/bubble-shortcut.json 里，没有被动过，所以那个设置也会跟着一起回来。
 *
 * 类型标成 boolean 而不是让它收窄成字面量 false，免得下面整段被当成不可达代码。
 */
const BUBBLE_ENABLED: boolean = false;

const BUBBLE_WIDTH = 680;
const BUBBLE_HEIGHT = 460;

export interface BubbleHost {
  preloadPath: string;
  /** Load the renderer into the bubble's window; the caller knows dev URL from packaged file. */
  loadRenderer(window: BrowserWindow): void;
  /** Bring the main window forward, optionally on a particular session. */
  revealMainWindow(target?: BubbleSessionTarget): void;
}

let bubbleWindow: BrowserWindow | undefined;
let activeShortcut: string | undefined;

function shortcutFilePath(): string {
  return join(app.getPath("userData"), "bubble-shortcut.json");
}

function readStoredShortcut(): string | undefined {
  try {
    const path = shortcutFilePath();
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as { accelerator?: unknown }).accelerator;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredShortcut(accelerator: string | undefined): void {
  try {
    const path = shortcutFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ accelerator: accelerator ?? null }, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("[bubble] could not persist the shortcut", error);
  }
}

function createBubbleWindow(host: BubbleHost): BrowserWindow {
  const window = new BrowserWindow({
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    show: false,
    frame: false,
    // The page paints its own rounded card and animates it in; a window
    // background would show as a square behind that.
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "CoilCoil",
    webPreferences: {
      preload: host.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Visible over full-screen apps, which is most of the point of a bubble.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once("ready-to-show", () => {
    window.center();
    window.show();
    window.focus();
  });
  // Hidden rather than closed: the conversation, and whatever is still streaming
  // into it, has to survive being dismissed and called back.
  window.on("blur", () => {
    if (!window.isDestroyed() && window.isVisible()) window.hide();
  });
  window.on("close", (event) => {
    if (window.isDestroyed()) return;
    event.preventDefault();
    window.hide();
  });
  host.loadRenderer(window);
  return window;
}

function showBubble(host: BubbleHost): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    bubbleWindow = createBubbleWindow(host);
    return;
  }
  bubbleWindow.center();
  bubbleWindow.show();
  bubbleWindow.focus();
}

export function toggleBubble(host: BubbleHost): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible() && bubbleWindow.isFocused()) {
    bubbleWindow.hide();
    return;
  }
  showBubble(host);
}

function hideBubble(): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.hide();
}

/**
 * Claim an accelerator, or release the current one when given nothing.
 *
 * Registration is the only honest test of whether a combination is available:
 * Electron reports failure when the system or another application already owns
 * it, and that answer goes straight back to the settings page.
 */
function applyShortcut(host: BubbleHost, accelerator: string | undefined): BubbleShortcutState {
  if (activeShortcut) {
    globalShortcut.unregister(activeShortcut);
    activeShortcut = undefined;
  }
  const wanted = accelerator?.trim();
  if (!wanted) return { accelerator: undefined, registered: false };
  let registered = false;
  try {
    registered = globalShortcut.register(wanted, () => toggleBubble(host));
  } catch (error) {
    return { accelerator: wanted, registered: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!registered) return { accelerator: wanted, registered: false, error: "这个快捷键已被系统或其他应用占用。" };
  activeShortcut = wanted;
  return { accelerator: wanted, registered: true };
}

export function setupBubbleWindow(host: BubbleHost): () => void {
  // 停用期间什么都不挂上去，收尾也就没什么要做的。
  if (!BUBBLE_ENABLED) return () => undefined;

  const stored = readStoredShortcut();
  if (stored) {
    const state = applyShortcut(host, stored);
    if (!state.registered) console.warn(`[bubble] ${stored} could not be registered: ${state.error ?? "unavailable"}`);
  }

  ipcMain.handle(BUBBLE_GET_SHORTCUT_CHANNEL, (): BubbleShortcutState => ({
    accelerator: activeShortcut ?? stored,
    registered: Boolean(activeShortcut),
    suggestion: SUGGESTED_BUBBLE_SHORTCUT,
  }));
  ipcMain.handle(BUBBLE_SET_SHORTCUT_CHANNEL, (_event, accelerator: string | undefined): BubbleShortcutState => {
    const state = applyShortcut(host, accelerator);
    // A combination that would not register is not written down: reopening the
    // page must not offer back a shortcut that never worked.
    if (state.registered || !accelerator?.trim()) writeStoredShortcut(state.registered ? state.accelerator : undefined);
    return { ...state, suggestion: SUGGESTED_BUBBLE_SHORTCUT };
  });
  ipcMain.handle(BUBBLE_HIDE_CHANNEL, (): void => hideBubble());
  ipcMain.handle(BUBBLE_OPEN_MAIN_CHANNEL, (_event, target?: BubbleSessionTarget): void => {
    hideBubble();
    host.revealMainWindow(target);
  });

  // The card is painted from the theme, so a system theme change while the
  // bubble is hidden must still reach it.
  const publishTheme = (): void => {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.webContents.send("bubble:theme", nativeTheme.shouldUseDarkColors ? "dark" : "light");
    }
  };
  nativeTheme.on("updated", publishTheme);

  return () => {
    nativeTheme.off("updated", publishTheme);
    if (activeShortcut) globalShortcut.unregister(activeShortcut);
    activeShortcut = undefined;
    ipcMain.removeHandler(BUBBLE_GET_SHORTCUT_CHANNEL);
    ipcMain.removeHandler(BUBBLE_SET_SHORTCUT_CHANNEL);
    ipcMain.removeHandler(BUBBLE_HIDE_CHANNEL);
    ipcMain.removeHandler(BUBBLE_OPEN_MAIN_CHANNEL);
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.destroy();
    bubbleWindow = undefined;
  };
}
