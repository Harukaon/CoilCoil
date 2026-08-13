import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResponseEnvelope,
  RuntimeWireMessage,
  FileNode,
} from "@suocode/runtime-protocol";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { createRequire } from "node:module";
import type { BrowserViewBounds, FilePreviewDocument, OpenFilePreviewInput, ProjectFileActionInput, ProjectFileActionResult, ProjectSelection, RuntimeRequestPayload, RuntimeRequestResult } from "../shared/desktop-api";
import { BrowserRuntimeManager } from "./browser-runtime";

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
const BROWSER_CREATE_TAB_CHANNEL = "browser:create-tab";
const BROWSER_SELECT_TAB_CHANNEL = "browser:select-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "browser:close-tab";
const BROWSER_NAVIGATE_CHANNEL = "browser:navigate";
const BROWSER_BACK_CHANNEL = "browser:back";
const BROWSER_FORWARD_CHANNEL = "browser:forward";
const BROWSER_RELOAD_CHANNEL = "browser:reload";
const BROWSER_BOUNDS_CHANNEL = "browser:bounds";
let isQuitting = false;
const moduleRequire = createRequire(import.meta.url);
const browserRuntimes = new Map<number, BrowserRuntimeManager>();
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

async function openPreviewOrMenu(event: Electron.IpcMainInvokeEvent, input: OpenFilePreviewInput): Promise<{ opened: boolean; document?: FilePreviewDocument; actions?: Array<"reveal" | "force-text" | "trash"> }> {
  const target = await safePreviewPath(input);
  if (previewKind(target.path, Boolean(input.forceText))) {
    return { opened: true, document: await createPreviewRecord(event, input) };
  }
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  Menu.buildFromTemplate([
    { label: "在访达中显示", click: () => shell.showItemInFolder(target.path) },
    { label: "作为文本尝试预览", click: () => void createPreviewRecord(event, { ...input, forceText: true }).then((document) => {
      if (!event.sender.isDestroyed()) event.sender.send(PREVIEW_UPDATED_CHANNEL, document);
    }).catch((error) => console.error("Unable to open file as text preview", error)) },
    { type: "separator" },
    { label: "移到废纸篓", role: "delete", click: () => void (async () => {
      const options = { type: "warning" as const, title: "移到废纸篓", message: `确定要将“${basename(target.path)}”移到废纸篓吗？`, buttons: ["取消", "移到废纸篓"], defaultId: 0, cancelId: 0 };
      const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      if (result.response === 1) await shell.trashItem(target.path);
    })() },
  ]).popup({ window: owner });
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
            chromeDevtoolsMcpEntry(),
            "--wsEndpoint", primaryBrowserRuntime.endpoint(),
            "--wsHeaders", JSON.stringify({ Authorization: `Bearer ${primaryBrowserRuntime.token}` }),
            "--no-usage-statistics",
            "--no-performance-crux",
          ]),
          SUOCODE_BROWSER_MCP_ENV: JSON.stringify({
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
            ELECTRON_RUN_AS_NODE: "1",
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
    },
  });

  const browserRuntime = new BrowserRuntimeManager(mainWindow, (state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_STATE_CHANNEL, state);
  }, () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_AGENT_ACTIVATED_CHANNEL);
  });
  await browserRuntime.start();
  const ownerWebContentsId = mainWindow.webContents.id;
  browserRuntimes.set(ownerWebContentsId, browserRuntime);
  primaryBrowserRuntime ??= browserRuntime;
  mainWindow.once("closed", () => {
    browserRuntimes.delete(ownerWebContentsId);
    if (primaryBrowserRuntime === browserRuntime) {
      runtime.stop();
      primaryBrowserRuntime = browserRuntimes.values().next().value;
      if (primaryBrowserRuntime && !isQuitting) runtime.start();
    }
    void browserRuntime.dispose().catch((error) => console.error("[browser] 关闭运行时失败", error));
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
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
  ipcMain.handle(PREVIEW_OPEN_CHANNEL, (event, input: OpenFilePreviewInput) => openPreviewOrMenu(event, input));
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
  ipcMain.handle(BROWSER_GET_STATE_CHANNEL, (event) => browserFor(event).state());
  ipcMain.handle(BROWSER_CREATE_TAB_CHANNEL, (event, url?: string) => browserFor(event).createTab(url));
  ipcMain.handle(BROWSER_SELECT_TAB_CHANNEL, (event, id: string) => browserFor(event).selectTab(id));
  ipcMain.handle(BROWSER_CLOSE_TAB_CHANNEL, (event, id: string) => browserFor(event).closeTab(id));
  ipcMain.handle(BROWSER_NAVIGATE_CHANNEL, (event, url: string) => browserFor(event).navigate(url));
  ipcMain.handle(BROWSER_BACK_CHANNEL, (event) => browserFor(event).back());
  ipcMain.handle(BROWSER_FORWARD_CHANNEL, (event) => browserFor(event).forward());
  ipcMain.handle(BROWSER_RELOAD_CHANNEL, (event) => browserFor(event).reload());
  ipcMain.handle(BROWSER_BOUNDS_CHANNEL, (event, bounds: BrowserViewBounds): void => {
    // Renderer cleanup can race the native window's closed event during dev reload/quit.
    browserRuntimes.get(event.sender.id)?.setBounds(bounds);
  });
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

app.on("before-quit", () => {
  isQuitting = true;
  for (const id of [...previews.keys()]) closePreviewRecord(id);
  for (const browser of browserRuntimes.values()) void browser.dispose().catch(() => {});
  browserRuntimes.clear();
  runtime.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
