import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResponseEnvelope,
  RuntimeWireMessage,
  FileNode,
} from "@suocode/runtime-protocol";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { createRequire } from "node:module";
import type { BrowserViewBounds, FilePreviewDocument, OpenFilePreviewInput, ProjectFileActionInput, ProjectFileActionResult, ProjectSelection, RuntimeRequestPayload, RuntimeRequestResult } from "../shared/desktop-api";
import { BrowserRuntimeManager } from "./browser-runtime";
import { hardenGuestPreferences } from "./browser-webview-policy";
import { TerminalRuntimeManager } from "./terminal-runtime";

// This is deliberately opt-in and development-only. It lets the desktop smoke
// harness inspect the *running* renderer instead of proving layout solely with
// a synthetic DOM fixture. Electron otherwise does not expose the application
// WebContents through the scoped browser CDP bridge below.
const rendererDebugPort = process.env.SUOCODE_RENDERER_DEBUG_PORT;
if (!app.isPackaged && rendererDebugPort && /^\d{2,5}$/.test(rendererDebugPort)) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", rendererDebugPort);
}

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const PICK_DIRECTORY_CHANNEL = "dialog:pick-directory";
const WINDOW_MINIMUM_WIDTH_CHANNEL = "window:minimum-width";
const EXTERNAL_OPEN_CHANNEL = "external:open";
const CLIPBOARD_WRITE_CHANNEL = "clipboard:write";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";
const PREVIEW_OPEN_CHANNEL = "preview:open";
const PREVIEW_CLOSE_CHANNEL = "preview:close";
const PREVIEW_UPDATED_CHANNEL = "preview:updated";
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
const BROWSER_BOUNDS_CHANNEL = "browser:bounds";
const TERMINAL_STATE_CHANNEL = "terminal:state";
const TERMINAL_CREATE_CHANNEL = "terminal:create";
const TERMINAL_WRITE_CHANNEL = "terminal:write";
const TERMINAL_RESIZE_CHANNEL = "terminal:resize";
const TERMINAL_CLOSE_CHANNEL = "terminal:close";
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

function playwrightMcpEntry(): string {
  const packageJson = moduleRequire.resolve("@playwright/mcp/package.json");
  const resolved = join(dirname(packageJson), "cli.js");
  if (!app.isPackaged) return resolved;
  const unpacked = resolved.replace(`${join("app.asar", "node_modules")}`, `${join("app.asar.unpacked", "node_modules")}`);
  return existsSync(unpacked) ? unpacked : resolved;
}

function browserDebugMcpEntry(): string {
  const resolved = join(__dirname, "browser-debug-mcp.js");
  return resolved;
}

function playwrightMcpConfigPath(): string {
  const outputDir = join(app.getPath("userData"), "browser-artifacts", "playwright");
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, "mcp-config.json");
  writeFileSync(path, `${JSON.stringify({
    capabilities: ["core", "network", "storage", "testing", "vision", "pdf", "devtools"],
    allowUnrestrictedFileAccess: true,
    codegen: "none",
  }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function backgroundNodeExecutable(): string {
  const executableName = basename(process.execPath);
  const macHelperExecutable = join(dirname(dirname(process.execPath)), "Frameworks", `${executableName} Helper.app`, "Contents", "MacOS", `${executableName} Helper`);
  return process.platform === "darwin" && existsSync(macHelperExecutable) ? macHelperExecutable : process.execPath;
}

const TEXT_EXTENSIONS = new Set([
  "", ".txt", ".log", ".md", ".mdx", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less",
  ".py", ".pyi", ".rb", ".php", ".java", ".kt", ".kts", ".go", ".rs", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".sh", ".bash", ".zsh", ".fish", ".bat", ".cmd", ".ps1", ".sql", ".graphql", ".gql", ".env", ".ini", ".conf",
  ".dockerfile", ".gitignore", ".gitattributes", ".editorconfig", ".html", ".htm", ".svg",
]);

interface PreviewRecord {
  id: string;
  root: string;
  path: string;
  forceText: boolean;
  owner: Electron.WebContents;
  watcher?: FSWatcher;
  document?: FilePreviewDocument;
}

const previews = new Map<string, PreviewRecord>();

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

async function safePreviewPath(input: OpenFilePreviewInput): Promise<{ root: string; path: string }> {
  const target = await safeProjectPath(input);
  if (!(await stat(target.path)).isFile()) throw new Error("所选路径不是文件。");
  return target;
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
  const options = {
    type: "warning" as const,
    title: "移到废纸篓",
    message: `确定要将“${basename(target.path)}”移到废纸篓吗？`,
    buttons: ["取消", "移到废纸篓"],
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

function previewKind(path: string, forceText: boolean): FilePreviewDocument["kind"] | undefined {
  const extension = extname(path).toLowerCase();
  if (!forceText && extension === ".pdf") return "pdf";
  if (!forceText && [".md", ".mdx", ".markdown"].includes(extension)) return "markdown";
  if (!forceText && [".html", ".htm"].includes(extension)) return "html";
  if (forceText || TEXT_EXTENSIONS.has(extension) || ["dockerfile", "makefile", "license", "readme"].includes(basename(path).toLowerCase())) return "text";
  return undefined;
}

async function readPreview(record: PreviewRecord): Promise<FilePreviewDocument> {
  const kind = previewKind(record.path, record.forceText);
  if (!kind) throw new Error("此文件类型暂不支持预览。");
  const buffer = await readFile(record.path);
  const limit = kind === "pdf" ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
  const truncated = buffer.byteLength > limit;
  const content = kind === "pdf"
    ? `data:application/pdf;base64,${buffer.subarray(0, limit).toString("base64")}`
    : buffer.subarray(0, limit).toString("utf8");
  return { id: record.id, path: record.path, name: basename(record.path), kind, content, truncated, updatedAt: Date.now() };
}

async function updatePreview(record: PreviewRecord): Promise<void> {
  try {
    record.document = await readPreview(record);
    if (record.owner.isDestroyed()) {
      closePreviewRecord(record.id);
      return;
    }
    record.owner.send(PREVIEW_UPDATED_CHANNEL, record.document);
  } catch {
    // The file may be in the middle of an atomic replace; the next watch event retries it.
  }
}

function closePreviewRecord(id: string): void {
  const record = previews.get(id);
  if (!record) return;
  record.watcher?.close();
  previews.delete(id);
}

async function createPreviewRecord(event: Electron.IpcMainInvokeEvent, input: OpenFilePreviewInput): Promise<FilePreviewDocument> {
  const target = await safePreviewPath(input);
  const id = randomUUID();
  const record: PreviewRecord = {
    id,
    root: target.root,
    path: target.path,
    forceText: Boolean(input.forceText),
    owner: event.sender,
  };
  previews.set(id, record);
  try {
    record.document = await readPreview(record);
    record.watcher = watch(dirname(record.path), { persistent: false }, (_event, filename) => {
      if (!filename || filename.toString() === basename(record.path)) void updatePreview(record);
    });
    event.sender.once("destroyed", () => closePreviewRecord(id));
    return record.document;
  } catch (error) {
    closePreviewRecord(id);
    throw error;
  }
}

async function openFilePreview(event: Electron.IpcMainInvokeEvent, input: OpenFilePreviewInput): Promise<{ opened: boolean; document?: FilePreviewDocument; actions?: Array<"reveal" | "force-text" | "trash"> }> {
  const target = await safePreviewPath(input);
  if (previewKind(target.path, Boolean(input.forceText))) {
    return { opened: true, document: await createPreviewRecord(event, input) };
  }
  return { opened: false, actions: ["reveal", "force-text", "trash"] };
}

function isEventEnvelope(message: RuntimeWireMessage): message is RuntimeEventEnvelope {
  return "event" in message;
}

class RuntimeHost {
  private child?: ChildProcess;
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
        SUOCODE_AGENT_DIR: join(app.getPath("userData"), "agent"),
        SUOCODE_SESSION_DIR: join(app.getPath("userData"), "sessions"),
        SUOCODE_NODE_EXEC_PATH: nodeExecutable,
        ...(primaryBrowserRuntime ? {
          SUOCODE_BROWSER_MCP_COMMAND: nodeExecutable,
          SUOCODE_BROWSER_MCP_ARGS: JSON.stringify([
            playwrightMcpEntry(),
            "--config", playwrightMcpConfigPath(),
            "--cdp-endpoint", primaryBrowserRuntime.playwrightEndpoint(),
            "--cdp-header", `Authorization: Bearer ${primaryBrowserRuntime.token}`,
            "--output-dir", join(app.getPath("userData"), "browser-artifacts", "playwright"),
          ]),
          SUOCODE_BROWSER_MCP_ENV: JSON.stringify({
            ELECTRON_RUN_AS_NODE: "1",
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          }),
          SUOCODE_BROWSER_DEVTOOLS_MCP_COMMAND: nodeExecutable,
          SUOCODE_BROWSER_DEVTOOLS_MCP_ARGS: JSON.stringify([
            chromeDevtoolsMcpEntry(),
            "--wsEndpoint", primaryBrowserRuntime.endpoint(),
            "--wsHeaders", JSON.stringify({ Authorization: `Bearer ${primaryBrowserRuntime.token}` }),
            "--allow-unrestricted-paths",
            "--no-usage-statistics",
            "--no-performance-crux",
          ]),
          SUOCODE_BROWSER_DEVTOOLS_MCP_ENV: JSON.stringify({
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
            ELECTRON_RUN_AS_NODE: "1",
          }),
          SUOCODE_BROWSER_DEBUG_CDP_ENDPOINT: primaryBrowserRuntime.endpoint(),
          SUOCODE_BROWSER_DEBUG_CDP_TOKEN: primaryBrowserRuntime.token,
          SUOCODE_BROWSER_DEBUG_OUTPUT_DIR: join(app.getPath("userData"), "browser-artifacts", "debug"),
          SUOCODE_BROWSER_DEBUG_MCP_COMMAND: nodeExecutable,
          SUOCODE_BROWSER_DEBUG_MCP_ARGS: JSON.stringify([browserDebugMcpEntry()]),
          SUOCODE_BROWSER_DEBUG_MCP_ENV: JSON.stringify({
            ELECTRON_RUN_AS_NODE: "1",
            SUOCODE_BROWSER_DEBUG_CDP_ENDPOINT: primaryBrowserRuntime.endpoint(),
            SUOCODE_BROWSER_DEBUG_CDP_TOKEN: primaryBrowserRuntime.token,
            SUOCODE_BROWSER_DEBUG_OUTPUT_DIR: join(app.getPath("userData"), "browser-artifacts", "debug"),
          }),
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[runtime] ${chunk.toString()}`));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[runtime] ${chunk.toString()}`));
    child.on("message", (raw: RuntimeWireMessage) => this.handleMessage(raw));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      const reason = `SuoCode runtime exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
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
    if (!child?.connected) return Promise.reject(new Error("SuoCode 运行时不可用。"));
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
    for (const request of this.pending.values()) request.reject(new Error("SuoCode 正在关闭。"));
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

async function createWindow(): Promise<void> {
  const isMac = process.platform === "darwin";
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 395,
    minHeight: 500,
    show: false,
    backgroundColor: "#f8f8f6",
    title: "SuoCode",
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 18 },
          hasShadow: true,
        }
      : {}),
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
  // shape SuoCode allows, or refuses the attachment.
  webviewHostIds.add(mainWindow.webContents.id);
  mainWindow.once("closed", () => webviewHostIds.delete(mainWindow.webContents.id));
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
  });

  const browserRuntime = new BrowserRuntimeManager(mainWindow, (state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_STATE_CHANNEL, state);
  }, (scopeId) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_AGENT_ACTIVATED_CHANNEL, scopeId);
  });
  await browserRuntime.start();
  const terminalRuntime = new TerminalRuntimeManager((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(TERMINAL_STATE_CHANNEL, state);
  });
  if (process.env.SUOCODE_BROWSER_PROBE_LOG === "1") {
    console.error("[browser-probe]", JSON.stringify({
      devtoolsEndpoint: browserRuntime.endpoint(),
      playwrightEndpoint: browserRuntime.playwrightEndpoint(),
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

  mainWindow.on("ready-to-show", () => mainWindow.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
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
  ipcMain.handle(PREVIEW_OPEN_CHANNEL, (event, input: OpenFilePreviewInput) => openFilePreview(event, input));
  ipcMain.handle(PREVIEW_CLOSE_CHANNEL, (event, id: string): void => {
    const record = previews.get(id);
    if (!record || record.owner.id !== event.sender.id) return;
    closePreviewRecord(id);
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
  ipcMain.handle(BROWSER_BOUNDS_CHANNEL, (event, bounds: BrowserViewBounds): void => {
    // Renderer cleanup can race the native window's closed event during dev reload/quit.
    browserRuntimes.get(event.sender.id)?.setBounds(bounds);
  });
  const terminalFor = (event: Electron.IpcMainInvokeEvent): TerminalRuntimeManager => {
    const value = terminalRuntimes.get(event.sender.id);
    if (!value) throw new Error("终端运行时不可用。");
    return value;
  };
  ipcMain.handle(TERMINAL_CREATE_CHANNEL, (event, cwd: string) => terminalFor(event).create(cwd));
  ipcMain.handle(TERMINAL_WRITE_CHANNEL, (event, id: string, data: string): void => terminalFor(event).write(id, data));
  ipcMain.handle(TERMINAL_RESIZE_CHANNEL, (event, id: string, cols: number, rows: number): void => terminalFor(event).resize(id, cols, rows));
  ipcMain.handle(TERMINAL_CLOSE_CHANNEL, (event, id: string) => terminalFor(event).close(id));
  ipcMain.handle(RUNTIME_REQUEST_CHANNEL, async (_event, payload: RuntimeRequestPayload): Promise<RuntimeRequestResult> => {
    try {
      return { ok: true, value: await runtime.request(payload) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  await createWindow();
  runtime.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().then(() => runtime.start());
    }
  });
});

app.on("before-quit", async (event) => {
  if (isQuitting) return;
  const hasRunningTerminal = [...terminalRuntimes.values()].some((manager) => manager.hasRunning());
  if (hasRunningTerminal) {
    event.preventDefault();
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = owner
      ? await dialog.showMessageBox(owner, {
          type: "warning",
          title: "终端仍在运行",
          message: "关闭 SuoCode 会同时结束仍在运行的终端会话。",
          buttons: ["取消", "关闭并结束终端"],
          defaultId: 0,
          cancelId: 0,
        })
      : { response: 0 };
    if (result.response !== 1) return;
    isQuitting = true;
    app.quit();
    return;
  }
  isQuitting = true;
  for (const id of [...previews.keys()]) closePreviewRecord(id);
  for (const browser of browserRuntimes.values()) void browser.dispose().catch(() => {});
  for (const terminal of terminalRuntimes.values()) terminal.dispose();
  browserRuntimes.clear();
  terminalRuntimes.clear();
  runtime.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
