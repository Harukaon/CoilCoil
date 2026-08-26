import { BrowserWindow, globalShortcut, ipcMain, nativeTheme } from "electron";
import type { BubbleSessionTarget } from "../shared/desktop-api";

export const BUBBLE_HIDE_CHANNEL = "bubble:hide";
export const BUBBLE_OPEN_MAIN_CHANNEL = "bubble:open-main";
export const BUBBLE_OPEN_SESSION_CHANNEL = "bubble:open-session";

/**
 * Spotlight's chord is taken on macOS and Windows search owns Win+S, so this
 * adds Shift to a combination both platforms leave free.
 */
export const DEFAULT_BUBBLE_SHORTCUT = "CommandOrControl+Shift+Space";

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

export function setupBubbleWindow(host: BubbleHost): () => void {
  const registered = globalShortcut.register(DEFAULT_BUBBLE_SHORTCUT, () => toggleBubble(host));
  if (!registered) {
    console.warn(`[bubble] ${DEFAULT_BUBBLE_SHORTCUT} is taken by another application; the bubble has no shortcut.`);
  }

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
    globalShortcut.unregister(DEFAULT_BUBBLE_SHORTCUT);
    ipcMain.removeHandler(BUBBLE_HIDE_CHANNEL);
    ipcMain.removeHandler(BUBBLE_OPEN_MAIN_CHANNEL);
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.destroy();
    bubbleWindow = undefined;
  };
}
