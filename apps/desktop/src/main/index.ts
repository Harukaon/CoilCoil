import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResponseEnvelope,
  RuntimeWireMessage,
  FileNode,
} from "@coilcoil/runtime-protocol";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell } from "electron";
import { createRequire } from "node:module";
import type { DiagnosticLogBatch } from "@coilcoil/runtime-protocol";
import type { BrowserUiViewport, OpenFilePreviewInput, PathKind, ProjectFileActionInput, ProjectFileActionResult, ProjectSelection, RuntimeRequestPayload, RuntimeRequestResult } from "../shared/desktop-api";
import { appIconPath } from "./app-icon";
import { BrowserRuntimeManager } from "./browser-runtime";
import {
  browserContextMenuItems,
  runContextMenuAction,
  type GuestContextMenuParams,
} from "./browser-context-menu";
import { hardenGuestPreferences } from "./browser-webview-policy";
import { closeAllFilePreviews, closeFilePreview, openFilePreview } from "./file-preview";
import { installHostNavigationGuard } from "./host-navigation";
import { currentPlatform, trashLabel } from "../shared/platform-labels";
import { applicationMenuTemplate, windowChromeOptions } from "./window-chrome";
import { migrateLegacyUserData } from "./data-migration";
import {
  DIAGNOSTIC_LEVEL_ENV,
  DIAGNOSTIC_LOG_DIRECTORY,
  DiagnosticLog,
  installProcessErrorHandlers,
  levelFromEnvironment,
  processStartupData,
} from "@coilcoil/diagnostics";
import { TerminalRuntimeManager } from "./terminal-runtime";
import {
  checkForUpdate,
  UPDATE_FIRST_CHECK_MS,
  UPDATE_INTERVAL_MS,
  type UpdateAvailable,
} from "./update-check";

// This is deliberately opt-in and development-only. It lets the desktop smoke
// harness inspect the *running* renderer instead of proving layout solely with
// a synthetic DOM fixture. Electron otherwise does not expose the application
// WebContents through the scoped browser CDP bridge below.
const rendererDebugPort = process.env.COILCOIL_RENDERER_DEBUG_PORT;
if (!app.isPackaged && rendererDebugPort && /^\d{2,5}$/.test(rendererDebugPort)) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", rendererDebugPort);
}

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const APP_VERSION_CHANNEL = "app:version";
const PICK_DIRECTORY_CHANNEL = "dialog:pick-directory";
const WINDOW_MINIMUM_WIDTH_CHANNEL = "window:minimum-width";
const WINDOW_GROW_WIDTH_CHANNEL = "window:grow-width";
const WINDOW_BACKGROUND_CHANNEL = "window:background";
/** 首帧用的底色；窗口半透明时露出的就是这一层，之后由渲染进程按主题同步。 */
const WINDOW_BACKGROUND = { light: "#f8f8f7", dark: "#1f1f1f" } as const;
/** 只接受 CSS 颜色字面量，不接受任意字符串。 */
const CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/-]+\))$/i;
const EXTERNAL_OPEN_CHANNEL = "external:open";
const PATH_CLASSIFY_CHANNEL = "path:classify";
const PATH_REVEAL_CHANNEL = "path:reveal";
const CLIPBOARD_WRITE_CHANNEL = "clipboard:write";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";
const WINDOW_MINIMIZE_CHANNEL = "window:minimize";
const WINDOW_TOGGLE_MAXIMIZED_CHANNEL = "window:toggle-maximized";
const WINDOW_IS_MAXIMIZED_CHANNEL = "window:is-maximized";
const WINDOW_MAXIMIZED_CHANNEL = "window:maximized";
const WINDOW_CLOSE_CHANNEL = "window:close";
const DIAGNOSTIC_LOG_CHANNEL = "diagnostics:log";
const DIAGNOSTIC_REVEAL_CHANNEL = "diagnostics:reveal";
const PREVIEW_OPEN_CHANNEL = "preview:open";
const PREVIEW_CLOSE_CHANNEL = "preview:close";
const PROJECT_FILE_ACTION_CHANNEL = "project-file:action";
const PROJECT_DIRECTORY_LIST_CHANNEL = "project-directory:list";
const BROWSER_STATE_CHANNEL = "browser:state";
const BROWSER_AGENT_ACTIVATED_CHANNEL = "browser:agent-activated";
const BROWSER_GET_STATE_CHANNEL = "browser:get-state";
const BROWSER_SET_SCOPE_CHANNEL = "browser:set-scope";
const BROWSER_CREATE_TAB_CHANNEL = "browser:create-tab";
const BROWSER_SELECT_TAB_CHANNEL = "browser:select-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "browser:close-tab";
const BROWSER_NAVIGATE_CHANNEL = "browser:navigate";
const BROWSER_BACK_CHANNEL = "browser:back";
const BROWSER_FORWARD_CHANNEL = "browser:forward";
const BROWSER_RELOAD_CHANNEL = "browser:reload";
const BROWSER_UI_VIEWPORT_CHANNEL = "browser:ui-viewport";
const BROWSER_GUEST_ROSTER_CHANNEL = "browser:guest-roster";
const BROWSER_GUEST_LAYER_READY_CHANNEL = "browser:guest-layer-ready";
const BROWSER_REGISTER_GUEST_CHANNEL = "browser:register-guest";
const BROWSER_GUEST_FAILED_CHANNEL = "browser:guest-failed";
const TERMINAL_STATE_CHANNEL = "terminal:state";
const TERMINAL_DATA_CHANNEL = "terminal:data";
const TERMINAL_GET_CHANNEL = "terminal:get";
const TERMINAL_CREATE_CHANNEL = "terminal:create";
const TERMINAL_WRITE_CHANNEL = "terminal:write";
const TERMINAL_RESIZE_CHANNEL = "terminal:resize";
const TERMINAL_CLOSE_CHANNEL = "terminal:close";
const UPDATE_AVAILABLE_CHANNEL = "update:available";
let isQuitting = false;
const moduleRequire = createRequire(import.meta.url);
const browserRuntimes = new Map<number, BrowserRuntimeManager>();
/** WebContents ids allowed to host <webview> guests — app windows, never previews or guests. */
const webviewHostIds = new Set<number>();
const terminalRuntimes = new Map<number, TerminalRuntimeManager>();
let primaryBrowserRuntime: BrowserRuntimeManager | undefined;

function chromeDevtoolsMcpEntry(): string {
  const resolved = moduleRequire.resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
  if (!app.isPackaged) return resolved;
  const unpacked = resolved.replace(`${join("app.asar", "node_modules")}`, `${join("app.asar.unpacked", "node_modules")}`);
  return existsSync(unpacked) ? unpacked : resolved;
}

function backgroundNodeExecutable(): string {
  const executableName = basename(process.execPath);
  const macHelperExecutable = join(dirname(dirname(process.execPath)), "Frameworks", `${executableName} Helper.app`, "Contents", "MacOS", `${executableName} Helper`);
  return process.platform === "darwin" && existsSync(macHelperExecutable) ? macHelperExecutable : process.execPath;
}

async function safeProjectPath(input: Pick<OpenFilePreviewInput, "root" | "path">): Promise<{ root: string; path: string }> {
  const root = await realpath(input.root);
  const candidate = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const path = await realpath(candidate);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("所选文件不在当前项目中。");
  }
  return { root, path };
}

/**
 * Resolve a file to preview.
 *
 * Preview deliberately accepts a file the project does not contain. Agents cite
 * absolute paths outside the workspace all the time — a dependency's source, a
 * log, a config in the home directory — and refusing to open the very path the
 * reply just linked was the wrong answer. Only the single named file is
 * reachable this way: directory listing stays contained to the project, so an
 * outside path can be read but never browsed. This grants the agent nothing it
 * lacks, because its own read tool already reaches the whole filesystem.
 */
async function safePreviewPath(input: OpenFilePreviewInput): Promise<{ root: string; path: string }> {
  const root = await realpath(input.root);
  const candidate = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const path = await realpath(candidate);
  if (!(await stat(path)).isFile()) throw new Error("所选路径不是文件。");
  return { root, path };
}

async function safeProjectEntryPath(
  input: Pick<ProjectFileActionInput, "root" | "path">,
): Promise<{ root: string; path: string }> {
  const root = await realpath(input.root);
  const path = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(!rel ? "不能对工作区根目录执行此操作。" : "所选项目条目不在当前项目中。");
  }
  await lstat(path);
  return { root, path };
}

async function performProjectFileAction(
  event: Electron.IpcMainInvokeEvent,
  input: ProjectFileActionInput,
): Promise<ProjectFileActionResult> {
  const target = await safeProjectEntryPath(input);
  if (input.action === "reveal") {
    shell.showItemInFolder(target.path);
    return { completed: true };
  }
  if (input.action !== "trash") throw new Error("不支持的文件操作。");
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const trash = trashLabel(currentPlatform(process.platform));
  const options = {
    type: "warning" as const,
    title: `移到${trash}`,
    message: `确定要将“${basename(target.path)}”移到${trash}吗？`,
    buttons: ["取消", `移到${trash}`],
    defaultId: 0,
    cancelId: 0,
  };
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) return { completed: false, trashed: false };
  await shell.trashItem(target.path);
  return { completed: true, trashed: true };
}

async function listProjectDirectory(rootValue: string, relativePath = ""): Promise<FileNode[]> {
  const root = await realpath(rootValue);
  if (!(await stat(root)).isDirectory()) throw new Error("项目路径不是文件夹。");
  const candidate = resolve(root, relativePath || ".");
  const path = await realpath(candidate);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("目录不在当前项目中。");
  if (!(await stat(path)).isDirectory()) throw new Error("所选路径不是文件夹。");
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => ({
      name: entry.name,
      path: relative(root, join(path, entry.name)) || entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    } satisfies FileNode));
}

function isEventEnvelope(message: RuntimeWireMessage): message is RuntimeEventEnvelope {
  return "event" in message;
}


/**
 * How recently an agent must have driven the browser for a window activation to
 * be worth recording. Longer than a single command round trip, short enough that
 * a user clicking the dock a moment later is not blamed on the agent.
 */
const WINDOW_ACTIVATION_ATTRIBUTION_MS = 3_000;

/** How much of the runtime child's stderr to keep for its own obituary. */
const RUNTIME_STDERR_TAIL_LINES = 60;

let mainLog: DiagnosticLog | undefined;

/**
 * The main process's log, and the file the Renderer's entries land in too.
 *
 * Created on first use rather than at module load: it writes under `userData`,
 * which is only settled once Electron has resolved the app paths.
 */
function diagnosticLog(): DiagnosticLog {
  mainLog ??= new DiagnosticLog({
    directory: join(app.getPath("userData"), "agent", DIAGNOSTIC_LOG_DIRECTORY),
    process: "main",
    level: levelFromEnvironment(process.env[DIAGNOSTIC_LEVEL_ENV]),
    echo: !app.isPackaged,
  });
  return mainLog;
}

class RuntimeHost {
  private child?: ChildProcess;
  /**
   * The runtime child's recent stderr.
   *
   * Everything it prints went to this process's own stderr, which a packaged
   * app throws away — so the one place that said why it died was the one place
   * nobody could read. Keeping a tail means the exit entry can carry it.
   */
  private stderrTail: string[] = [];
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly onEvent: (runtimeId: string | undefined, event: RuntimeEventEnvelope["event"]) => void,
    private readonly onExit: () => void,
  ) {}

  start(): void {
    if (this.child?.connected) return;
    const runtimeEntry = join(__dirname, "runtime.js");
    const nodeExecutable = backgroundNodeExecutable();
    const child = fork(runtimeEntry, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        COILCOIL_AGENT_DIR: join(app.getPath("userData"), "agent"),
        COILCOIL_SESSION_DIR: join(app.getPath("userData"), "sessions"),
        COILCOIL_NODE_EXEC_PATH: nodeExecutable,
        ...(primaryBrowserRuntime ? {
          COILCOIL_BROWSER_MCP_COMMAND: nodeExecutable,
          COILCOIL_BROWSER_MCP_ARGS: JSON.stringify([
            chromeDevtoolsMcpEntry(),
            "--wsEndpoint", primaryBrowserRuntime.endpoint(),
            "--wsHeaders", JSON.stringify({ Authorization: `Bearer ${primaryBrowserRuntime.token}` }),
            "--allow-unrestricted-paths",
            "--no-usage-statistics",
            "--no-performance-crux",
            "--experimentalStructuredContent",
            "--experimentalPageIdRouting",
          ]),
          COILCOIL_BROWSER_MCP_ENV: JSON.stringify({
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
            ELECTRON_RUN_AS_NODE: "1",
          }),
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;

    this.stderrTail = [];
    diagnosticLog().info("runtime-host", "runtime_spawned", { pid: child.pid, entry: runtimeEntry });
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[runtime] ${chunk.toString()}`));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(`[runtime] ${text}`);
      for (const line of text.split("\n")) {
        if (line.trim()) this.stderrTail.push(line);
      }
      if (this.stderrTail.length > RUNTIME_STDERR_TAIL_LINES) {
        this.stderrTail = this.stderrTail.slice(-RUNTIME_STDERR_TAIL_LINES);
      }
    });
    child.on("message", (raw: RuntimeWireMessage) => this.handleMessage(raw));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      const reason = `CoilCoil runtime exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
      const unexpected = !isQuitting;
      diagnosticLog().log(unexpected ? "error" : "info", "runtime-host", "runtime_exited", {
        code,
        signal,
        quitting: isQuitting,
        pendingRequests: this.pending.size,
        stderrTail: this.stderrTail,
      });
      for (const request of this.pending.values()) request.reject(new Error(reason));
      this.pending.clear();
      this.onExit();
      if (!isQuitting) {
        this.onEvent(undefined, {
            type: "runtime_error",
            message: reason,
        });
      }
    });
  }

  private handleMessage(message: RuntimeWireMessage): void {
    if (isEventEnvelope(message)) {
      this.onEvent(message.runtimeId, message.event);
      return;
    }
    const response = message as RuntimeResponseEnvelope;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || "运行时请求失败。"));
  }

  request<T>(command: RuntimeCommand, runtimeId?: string): Promise<T> {
    this.start();
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error("CoilCoil 运行时不可用。"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      child.send({ id, runtimeId, command }, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.removeAllListeners("exit");
    if (child.connected) child.disconnect();
    child.kill("SIGTERM");
    for (const request of this.pending.values()) request.reject(new Error("CoilCoil 正在关闭。"));
    this.pending.clear();
  }
}

class RuntimeBridge {
  private host?: RuntimeHost;

  private broadcast = (runtimeId: string | undefined, event: RuntimeEventEnvelope["event"]): void => {
    if (runtimeId && event.type === "runtime_released") primaryBrowserRuntime?.releaseScope(runtimeId);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(RUNTIME_EVENT_CHANNEL, { runtimeId, event });
    }
  };

  private runtimeHost(): RuntimeHost {
    if (this.host) return this.host;
    const host = new RuntimeHost(this.broadcast, () => {
      if (this.host === host) this.host = undefined;
    });
    this.host = host;
    return host;
  }

  start(): void {
    this.runtimeHost().start();
  }

  request<T>(payload: RuntimeRequestPayload): Promise<T> {
    return this.runtimeHost().request<T>(payload.command, payload.runtimeId);
  }

  stop(): void {
    this.host?.stop();
    this.host = undefined;
  }
}

const runtime = new RuntimeBridge();

/**
 * Give a browser guest the right-click menu Electron does not provide.
 *
 * Chromium raises `context-menu` for every right-click but shows nothing on its
 * own, which is why the built-in browser appeared to have no menu at all.
 */
function installGuestContextMenu(guest: Electron.WebContents, window: BrowserWindow): void {
  guest.on("context-menu", (_event, params) => {
    if (guest.isDestroyed()) return;
    const menuParams: GuestContextMenuParams = {
      x: params.x,
      y: params.y,
      linkURL: params.linkURL,
      srcURL: params.srcURL,
      mediaType: params.mediaType,
      selectionText: params.selectionText,
      isEditable: params.isEditable,
      pageURL: params.pageURL,
      editFlags: {
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
    };
    const history = guest.navigationHistory;
    const items = browserContextMenuItems(menuParams, {
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    });
    const template = items.map((item) => item.type === "separator"
      ? { type: "separator" as const }
      : {
        label: item.label,
        enabled: item.enabled,
        click: () => {
          if (guest.isDestroyed() || !item.action) return;
          runContextMenuAction(item.action, menuParams, {
            copyToClipboard: (text) => clipboard.writeText(text),
            copyImageAt: (x, y) => guest.copyImageAt(x, y),
            cut: () => guest.cut(),
            copy: () => guest.copy(),
            paste: () => guest.paste(),
            selectAll: () => guest.selectAll(),
            goBack: () => { if (history.canGoBack()) history.goBack(); },
            goForward: () => { if (history.canGoForward()) history.goForward(); },
            reload: () => guest.reload(),
            inspectElement: (x, y) => guest.inspectElement(x, y),
          });
        },
      });
    if (window.isDestroyed()) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}

async function createWindow(): Promise<void> {
  const platform = currentPlatform(process.platform);
  const iconForCurrentTheme = () => nativeImage.createFromPath(appIconPath({
    dark: nativeTheme.shouldUseDarkColors,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDirectory: __dirname,
  }));
  const initialIcon = iconForCurrentTheme();
  const mainWindow = new BrowserWindow({
    width: 915,
    height: 700,
    minWidth: 395,
    minHeight: 500,
    show: false,
    backgroundColor: WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? "dark" : "light"],
    title: "CoilCoil",
    ...(platform !== "darwin" && !initialIcon.isEmpty() ? { icon: initialIcon } : {}),
    ...windowChromeOptions(platform),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // The built-in browser renders as <webview> guests so DOM overlays can paint
      // over it. This is the only window allowed to host them; every other
      // WebContents refuses attachment outright (see app.on("web-contents-created")).
      webviewTag: true,
    },
  });

  // Enabling webviewTag means any script in this renderer could mint a guest and
  // choose its own preferences. This is the gate that rewrites them into the only
  // shape CoilCoil allows, or refuses the attachment.
  if (platform !== "darwin") {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.autoHideMenuBar = true;
  }
  const updateAppIcon = (): void => {
    const icon = iconForCurrentTheme();
    if (icon.isEmpty()) return;
    if (platform === "darwin") app.dock?.setIcon(icon);
    else if (!mainWindow.isDestroyed()) mainWindow.setIcon(icon);
  };
  updateAppIcon();
  nativeTheme.on("updated", updateAppIcon);
  mainWindow.once("closed", () => nativeTheme.off("updated", updateAppIcon));
  // The Renderer draws the window buttons, so it has to know which one to show.
  const publishMaximized = (): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(WINDOW_MAXIMIZED_CHANNEL, mainWindow.isMaximized());
  };
  mainWindow.on("maximize", publishMaximized);
  mainWindow.on("unmaximize", publishMaximized);

  const webviewHostId = mainWindow.webContents.id;
  webviewHostIds.add(webviewHostId);
  // Capture the id up front: by the time "closed" fires the window is destroyed
  // and reading webContents throws.
  mainWindow.once("closed", () => webviewHostIds.delete(webviewHostId));
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const allowed = hardenGuestPreferences(
      webPreferences as unknown as Record<string, unknown>,
      params as unknown as Record<string, unknown>,
    );
    if (!allowed) event.preventDefault();
  });
  // Baseline until the tab record claims the guest and installs its own handler;
  // a guest must never be able to open an OS window.
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    installGuestContextMenu(guest, mainWindow);
  });

  const browserRuntime = new BrowserRuntimeManager(mainWindow, (state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_STATE_CHANNEL, state);
  }, (scopeId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_AGENT_ACTIVATED_CHANNEL, scopeId);
  }, (roster) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_GUEST_ROSTER_CHANNEL, roster);
  });
  const terminalRuntime = new TerminalRuntimeManager((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(TERMINAL_STATE_CHANNEL, state);
  }, (id, data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(TERMINAL_DATA_CHANNEL, { id, data });
  });
  installHostNavigationGuard(mainWindow, browserRuntime, (scopeId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_AGENT_ACTIVATED_CHANNEL, scopeId);
  });
  await browserRuntime.start();
  if (process.env.COILCOIL_BROWSER_PROBE_LOG === "1") {
    console.error("[browser-probe]", JSON.stringify({
      devtoolsEndpoint: browserRuntime.endpoint(),
      token: browserRuntime.token,
    }));
  }
  const ownerWebContentsId = mainWindow.webContents.id;
  browserRuntimes.set(ownerWebContentsId, browserRuntime);
  terminalRuntimes.set(ownerWebContentsId, terminalRuntime);
  primaryBrowserRuntime ??= browserRuntime;
  mainWindow.once("closed", () => {
    browserRuntimes.delete(ownerWebContentsId);
    terminalRuntimes.delete(ownerWebContentsId);
    if (primaryBrowserRuntime === browserRuntime) {
      runtime.stop();
      primaryBrowserRuntime = browserRuntimes.values().next().value;
      if (primaryBrowserRuntime && !isQuitting) runtime.start();
    }
    void browserRuntime.dispose().catch((error) => console.error("[browser] 关闭运行时失败", error));
    terminalRuntime.dispose();
  });

  // Diagnostic for the report that an agent driving the browser raises — and even
  // un-minimizes — the app window. Nothing in main calls focus/show/restore, so
  // the activation has to come from Chromium promoting a guest. Pair this with
  // COILCOIL_BROWSER_CDP_LOG=1 and read the last CDP command before the event.
  // The window coming forward while an agent works in the background is the
  // symptom; the command that provoked it is the answer. A stack trace cannot
  // give it — `focus` is a native event with no JS caller, which is why the
  // stderr-only probe this replaces never settled it — so record what the agent
  // had just asked the browser to do instead, and keep it where the user can
  // reach it rather than in a stream a packaged app throws away.
  const logActivation = (event: string) => () => {
    const recent = browserRuntime.recentCdpCommands();
    // Nothing from an agent recently means the user raised the window themselves.
    if (!recent.some((entry) => entry.msAgo < WINDOW_ACTIVATION_ATTRIBUTION_MS)) return;
    diagnosticLog().warn("window-activation", "window_activated_during_agent_browsing", {
      event,
      minimized: mainWindow.isMinimized(),
      recentCdp: recent,
    });
  };
  mainWindow.on("focus", logActivation("focus"));
  mainWindow.on("show", logActivation("show"));
  mainWindow.on("restore", logActivation("restore"));

  // `once`, not `on`. Electron re-emits this on the window every time a new
  // WebContents inside it becomes ready to display, and every <webview> the
  // built-in browser creates is one — so an Agent opening a page in the
  // background made the app show itself, raising it over whatever the user was
  // doing. Showing the window is a startup step; it happens exactly once.
  mainWindow.once("ready-to-show", () => mainWindow.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * Offer an update, once per build.
 *
 * Notify only: the macOS packages are unsigned, so nothing can install them for
 * the user. Re-offering the same version on every six-hour tick would turn a
 * helpful popup into a nuisance, so a declined version stays declined until a
 * newer one is published.
 */
let offeredUpdate: string | undefined;

function offerUpdate(update: UpdateAvailable): void {
  if (offeredUpdate === update.latest) return;
  offeredUpdate = update.latest;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(UPDATE_AVAILABLE_CHANNEL, update);
  }
}


function scheduleUpdateChecks(): void {
  // A failed check is not worth telling anyone about: the user did not ask for
  // it, and an offline machine would otherwise raise a dialog about GitHub.
  const run = (): void => {
    void checkForUpdate(app.getVersion())
      .then((update) => { if (update) return offerUpdate(update); })
      .catch(() => undefined);
  };
  const first = setTimeout(run, UPDATE_FIRST_CHECK_MS);
  const repeat = setInterval(run, UPDATE_INTERVAL_MS);
  first.unref?.();
  repeat.unref?.();
}

app.whenReady().then(async () => {
  const log = diagnosticLog();
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(currentPlatform(process.platform))));
  // Not fatal on purpose: taking the whole app down over one broken operation
  // is a worse outcome than carrying on with the failure written down.
  installProcessErrorHandlers(log, { exitOnUncaught: false });
  log.info("process", "app_started", processStartupData({
    version: app.getVersion(),
    packaged: app.isPackaged,
    locale: app.getLocale(),
  }));
  try {
    const migration = migrateLegacyUserData(app.getPath("userData"));
    if (migration.migrated) {
      console.info(`[migration] copied legacy data from ${migration.source} (${migration.copied.length} entries)`);
    }
  } catch (error) {
    console.error("[migration] legacy data migration failed; starting with current data", error);
  }
  // Only the main window may host <webview> guests, and only through the handler
  // installed in createWindow. Preview windows and anything added later refuse
  // attachment, so a future webPreferences default cannot widen the surface.
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") return;
    contents.on("will-attach-webview", (event) => {
      // Checked at attach time, not creation time: this fires while the window is
      // still being constructed, before createWindow can allowlist its id.
      if (webviewHostIds.has(contents.id)) return;
      event.preventDefault();
    });
  });

  ipcMain.handle(APP_VERSION_CHANNEL, (): string => app.getVersion());
  ipcMain.handle(PROJECT_HOME_CHANNEL, async (): Promise<ProjectSelection> => {
    const path = join(app.getPath("userData"), "Home");
    await mkdir(path, { recursive: true });
    return { name: "Home", path, kind: "home" };
  });
  ipcMain.handle(PROJECT_SELECT_CHANNEL, async (): Promise<ProjectSelection | null> => {
    const result = await dialog.showOpenDialog({
      title: "打开项目",
      properties: ["openDirectory"],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return { name: basename(path), path, kind: "workspace" };
  });
  ipcMain.handle(PICK_DIRECTORY_CHANNEL, async (_event, options?: { title?: string }): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: typeof options?.title === "string" && options.title.trim() ? options.title.trim() : "选择目录",
      properties: ["openDirectory"],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return path;
  });
  ipcMain.handle(WINDOW_MINIMUM_WIDTH_CHANNEL, (event, requestedWidth: number): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !Number.isFinite(requestedWidth)) return;
    const [, minimumHeight] = window.getMinimumSize();
    window.setMinimumSize(Math.max(315, Math.ceil(requestedWidth)), minimumHeight);
  });
  /**
   * Make room for a panel by widening the window rather than by squeezing the
   * conversation. Growth goes to the right; when that hits the edge of the
   * display the window slides left instead, and it never exceeds the work area.
   * A maximized or full-screen window has no room to give, so it is left alone.
   */
  // 渲染进程应用主题后同步窗口底色，否则暗色下缩放窗口会露出浅色画布。
  ipcMain.handle(WINDOW_BACKGROUND_CHANNEL, (event, color: string): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (typeof color !== "string" || !CSS_COLOR.test(color.trim())) return;
    window.setBackgroundColor(color.trim());
  });
  ipcMain.handle(WINDOW_GROW_WIDTH_CHANNEL, (event, byPixels: number): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    if (!Number.isFinite(byPixels) || byPixels <= 0) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(bounds.width + Math.ceil(byPixels), area.width);
    if (width <= bounds.width) return;
    const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
    window.setBounds({ ...bounds, x, width });
  });
  // What an absolute path in the transcript actually is, so a link can be drawn
  // and routed as the file or the folder it points at.
  ipcMain.handle(PATH_CLASSIFY_CHANNEL, async (_event, paths: string[]): Promise<Record<string, PathKind>> => {
    if (!Array.isArray(paths)) throw new Error("路径列表无效。");
    const entries = await Promise.all(paths.slice(0, 200).map(async (candidate): Promise<[string, PathKind]> => {
      if (typeof candidate !== "string" || !candidate.trim() || !isAbsolute(candidate)) return [String(candidate), "missing"];
      try {
        const stats = await stat(candidate);
        return [candidate, stats.isDirectory() ? "directory" : "file"];
      } catch {
        return [candidate, "missing"];
      }
    }));
    return Object.fromEntries(entries);
  });
  // A folder belongs to the file manager: the right-hand panel is the workspace
  // tree and single-file previews, not a second file browser.
  ipcMain.handle(PATH_REVEAL_CHANNEL, async (_event, rawPath: string): Promise<boolean> => {
    if (typeof rawPath !== "string" || !rawPath.trim() || !isAbsolute(rawPath)) throw new Error("路径无效。");
    const target = resolve(rawPath);
    const stats = await stat(target).catch(() => undefined);
    if (!stats) throw new Error("路径不存在或已被移动。");
    if (stats.isDirectory()) {
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return true;
    }
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle(EXTERNAL_OPEN_CHANNEL, async (_event, rawUrl: string): Promise<void> => {
    if (typeof rawUrl !== "string") throw new Error("授权地址无效。");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只允许打开 HTTP 或 HTTPS 授权地址。");
    await shell.openExternal(url.toString());
  });
  ipcMain.handle(CLIPBOARD_WRITE_CHANNEL, (_event, text: string): void => {
    if (typeof text !== "string" || text.length > 1_000_000) throw new Error("剪贴板内容无效。");
    clipboard.writeText(text);
  });
  ipcMain.handle(PREVIEW_OPEN_CHANNEL, (event, input: OpenFilePreviewInput) => openFilePreview(event, input, safePreviewPath));
  ipcMain.handle(PREVIEW_CLOSE_CHANNEL, (event, id: string): void => {
    closeFilePreview(event.sender.id, id);
  });
  ipcMain.handle(PROJECT_FILE_ACTION_CHANNEL, (event, input: ProjectFileActionInput) => performProjectFileAction(event, input));
  ipcMain.handle(PROJECT_DIRECTORY_LIST_CHANNEL, (_event, root: string, path?: string) => listProjectDirectory(root, path));
  const browserFor = (event: Electron.IpcMainInvokeEvent): BrowserRuntimeManager => {
    const value = browserRuntimes.get(event.sender.id);
    if (!value) throw new Error("内置浏览器运行时不可用。");
    return value;
  };
  ipcMain.handle(BROWSER_SET_SCOPE_CHANNEL, (event, scopeId: string) => browserFor(event).setUiScope(scopeId));
  ipcMain.handle(BROWSER_GET_STATE_CHANNEL, (event, scopeId: string) => browserFor(event).state(scopeId));
  ipcMain.handle(BROWSER_CREATE_TAB_CHANNEL, (event, scopeId: string, url?: string) => browserFor(event).createTab(url, true, scopeId));
  ipcMain.handle(BROWSER_SELECT_TAB_CHANNEL, (event, scopeId: string, id: string) => browserFor(event).selectTab(id, scopeId));
  ipcMain.handle(BROWSER_CLOSE_TAB_CHANNEL, (event, scopeId: string, id: string) => browserFor(event).closeTab(id, scopeId));
  ipcMain.handle(BROWSER_NAVIGATE_CHANNEL, (event, scopeId: string, url: string) => browserFor(event).navigate(url, scopeId));
  ipcMain.handle(BROWSER_BACK_CHANNEL, (event, scopeId: string) => browserFor(event).back(scopeId));
  ipcMain.handle(BROWSER_FORWARD_CHANNEL, (event, scopeId: string) => browserFor(event).forward(scopeId));
  ipcMain.handle(BROWSER_RELOAD_CHANNEL, (event, scopeId: string) => browserFor(event).reload(scopeId));
  ipcMain.handle(BROWSER_GUEST_LAYER_READY_CHANNEL, (event) => browserFor(event).markGuestLayerReady());
  ipcMain.handle(BROWSER_REGISTER_GUEST_CHANNEL, (event, tabId: string, nonce: string, webContentsId: number): void => {
    // Throws on any failed check so the renderer drops the element it created
    // rather than leaving a live guest that nothing owns.
    browserFor(event).registerGuest(tabId, nonce, webContentsId);
  });
  ipcMain.handle(BROWSER_GUEST_FAILED_CHANNEL, (event, tabId: string, nonce: string, reason: string): void => {
    browserRuntimes.get(event.sender.id)?.reportGuestFailure(tabId, nonce, String(reason).slice(0, 500));
  });
  ipcMain.handle(BROWSER_UI_VIEWPORT_CHANNEL, (event, viewport: BrowserUiViewport): void => {
    // Renderer cleanup can race the window's closed event during dev reload/quit.
    browserRuntimes.get(event.sender.id)?.setUiViewport(viewport);
  });
  const terminalFor = (event: Electron.IpcMainInvokeEvent): TerminalRuntimeManager => {
    const value = terminalRuntimes.get(event.sender.id);
    if (!value) throw new Error("终端运行时不可用。");
    return value;
  };
  ipcMain.handle(TERMINAL_GET_CHANNEL, (event) => terminalFor(event).state());
  ipcMain.handle(TERMINAL_CREATE_CHANNEL, (event, cwd: string) => terminalFor(event).create(cwd));
  ipcMain.handle(TERMINAL_WRITE_CHANNEL, (event, id: string, data: string): void => terminalFor(event).write(id, data));
  ipcMain.handle(TERMINAL_RESIZE_CHANNEL, (event, id: string, cols: number, rows: number): void => terminalFor(event).resize(id, cols, rows));
  ipcMain.handle(TERMINAL_CLOSE_CHANNEL, (event, id: string) => terminalFor(event).close(id));
  // The Renderer cannot write files. Its entries ride over here and join the
  // main process's own, so one file holds all three processes in time order.
  // The window buttons on Windows and Linux are drawn by the Renderer, so the
  // three things a title bar does have to be reachable from it.
  const senderWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && !window.isDestroyed() ? window : null;
  };
  ipcMain.on(WINDOW_MINIMIZE_CHANNEL, (event) => senderWindow(event)?.minimize());
  ipcMain.on(WINDOW_CLOSE_CHANNEL, (event) => senderWindow(event)?.close());
  ipcMain.on(WINDOW_TOGGLE_MAXIMIZED_CHANNEL, (event) => {
    const window = senderWindow(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(WINDOW_IS_MAXIMIZED_CHANNEL, (event) => senderWindow(event)?.isMaximized() ?? false);

  ipcMain.on(DIAGNOSTIC_LOG_CHANNEL, (_event, batch: DiagnosticLogBatch) => {
    if (!Array.isArray(batch?.entries)) return;
    diagnosticLog().writeEntries(batch.entries);
  });

  ipcMain.handle(DIAGNOSTIC_REVEAL_CHANNEL, async (): Promise<string> => {
    const log = diagnosticLog();
    shell.showItemInFolder(log.filePath);
    return log.filePath;
  });

  ipcMain.handle(RUNTIME_REQUEST_CHANNEL, async (_event, payload: RuntimeRequestPayload): Promise<RuntimeRequestResult> => {
    try {
      return { ok: true, value: await runtime.request(payload) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  await createWindow();
  scheduleUpdateChecks();
  runtime.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().then(() => runtime.start());
    }
  });
});

app.on("before-quit", () => {
  if (isQuitting) return;
  isQuitting = true;
  closeAllFilePreviews();
  for (const browser of browserRuntimes.values()) void browser.dispose().catch(() => {});
  for (const terminal of terminalRuntimes.values()) terminal.dispose();
  browserRuntimes.clear();
  terminalRuntimes.clear();
  runtime.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
