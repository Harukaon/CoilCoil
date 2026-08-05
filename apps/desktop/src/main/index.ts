import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResponseEnvelope,
  SessionSnapshot,
  RuntimeWireMessage,
} from "@suocode/runtime-protocol";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { FilePreviewDocument, OpenFilePreviewInput, ProjectSelection, RuntimeRequestPayload } from "../shared/desktop-api";

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";
const PREVIEW_OPEN_CHANNEL = "preview:open";
const PREVIEW_GET_CHANNEL = "preview:get";
const PREVIEW_UPDATED_CHANNEL = "preview:updated";
let isQuitting = false;

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
  window: BrowserWindow;
  watcher?: FSWatcher;
  document?: FilePreviewDocument;
}

const previews = new Map<string, PreviewRecord>();

async function safePreviewPath(input: OpenFilePreviewInput): Promise<{ root: string; path: string }> {
  const root = await realpath(input.root);
  const candidate = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const path = await realpath(candidate);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("所选文件不在当前项目中。");
  }
  if (!(await stat(path)).isFile()) throw new Error("所选路径不是文件。");
  return { root, path };
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
    if (!record.window.isDestroyed()) record.window.webContents.send(PREVIEW_UPDATED_CHANNEL, record.document);
  } catch {
    // The file may be in the middle of an atomic replace; the next watch event retries it.
  }
}

async function createPreviewWindow(input: OpenFilePreviewInput): Promise<void> {
  const target = await safePreviewPath(input);
  const id = randomUUID();
  const isMac = process.platform === "darwin";
  const window = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 420,
    minHeight: 320,
    show: false,
    title: basename(target.path),
    backgroundColor: "#f8f8f6",
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const record: PreviewRecord = { id, root: target.root, path: target.path, forceText: Boolean(input.forceText), window };
  previews.set(id, record);
  record.document = await readPreview(record);
  record.watcher = watch(dirname(record.path), { persistent: false }, (_event, filename) => {
    if (!filename || filename.toString() === basename(record.path)) void updatePreview(record);
  });
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    record.watcher?.close();
    previews.delete(id);
  });
  const query = `preview=${encodeURIComponent(id)}`;
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`);
  else void window.loadFile(join(__dirname, "../renderer/index.html"), { query: { preview: id } });
}

async function openPreviewOrMenu(event: Electron.IpcMainInvokeEvent, input: OpenFilePreviewInput): Promise<{ opened: boolean }> {
  const target = await safePreviewPath(input);
  if (previewKind(target.path, Boolean(input.forceText))) {
    await createPreviewWindow(input);
    return { opened: true };
  }
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  Menu.buildFromTemplate([
    { label: "在访达中显示", click: () => shell.showItemInFolder(target.path) },
    { label: "作为文本尝试预览", click: () => void createPreviewWindow({ ...input, forceText: true }) },
    { type: "separator" },
    { label: "移到废纸篓", role: "delete", click: () => void (async () => {
      const options = { type: "warning" as const, title: "移到废纸篓", message: `确定要将“${basename(target.path)}”移到废纸篓吗？`, buttons: ["取消", "移到废纸篓"], defaultId: 0, cancelId: 0 };
      const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      if (result.response === 1) await shell.trashItem(target.path);
    })() },
  ]).popup({ window: owner });
  return { opened: false };
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
    readonly id: string,
    private readonly onEvent: (runtimeId: string, event: RuntimeEventEnvelope["event"]) => void,
    private readonly onExit: (runtimeId: string) => void,
  ) {}

  start(): void {
    if (this.child?.connected) return;
    const runtimeEntry = join(__dirname, "runtime.js");
    const child = fork(runtimeEntry, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        SUOCODE_AGENT_DIR: join(app.getPath("userData"), "agent"),
        SUOCODE_SESSION_DIR: join(app.getPath("userData"), "sessions"),
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
      this.onExit(this.id);
      if (!isQuitting) {
        this.onEvent(this.id, {
            type: "runtime_error",
            message: reason,
        });
      }
    });
  }

  private handleMessage(message: RuntimeWireMessage): void {
    if (isEventEnvelope(message)) {
      this.onEvent(this.id, message.event);
      return;
    }
    const response = message as RuntimeResponseEnvelope;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || "运行时请求失败。"));
  }

  request<T>(command: RuntimeCommand): Promise<T> {
    this.start();
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error("SuoCode 运行时不可用。"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      child.send({ id, command }, (error) => {
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

class RuntimePool {
  private readonly controlId = "control";
  private readonly hosts = new Map<string, RuntimeHost>();
  private readonly sessions = new Map<string, string>();

  private broadcast = (runtimeId: string, event: RuntimeEventEnvelope["event"]): void => {
    const scopedId = runtimeId === this.controlId ? undefined : runtimeId;
    const scopedEvent = event.type === "session_snapshot"
      ? { ...event, snapshot: { ...event.snapshot, runtimeId: scopedId } }
      : event;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(RUNTIME_EVENT_CHANNEL, { runtimeId: scopedId, event: scopedEvent });
    }
  };

  private remove = (runtimeId: string): void => {
    this.hosts.delete(runtimeId);
    for (const [path, id] of this.sessions) if (id === runtimeId) this.sessions.delete(path);
  };

  private host(runtimeId: string = randomUUID()): RuntimeHost {
    const existing = this.hosts.get(runtimeId);
    if (existing) return existing;
    const host = new RuntimeHost(runtimeId, this.broadcast, this.remove);
    this.hosts.set(runtimeId, host);
    host.start();
    return host;
  }

  start(): void {
    this.host(this.controlId);
  }

  private decorate(runtimeId: string, snapshot: SessionSnapshot): SessionSnapshot {
    const decorated = { ...snapshot, runtimeId };
    if (snapshot.session.path) this.sessions.set(snapshot.session.path, runtimeId);
    return decorated;
  }

  async request<T>(payload: RuntimeRequestPayload): Promise<T> {
    const { command, runtimeId } = payload;
    if (command.type === "create_session") {
      const host = this.host();
      return this.decorate(host.id, await host.request<SessionSnapshot>(command)) as T;
    }
    if (command.type === "open_session") {
      const existingId = this.sessions.get(command.sessionPath);
      if (existingId) {
        const bootstrap = await this.host(existingId).request<{ activeSession?: SessionSnapshot }>({ type: "bootstrap" });
        if (bootstrap.activeSession) return this.decorate(existingId, bootstrap.activeSession) as T;
      }
      const host = this.host();
      return this.decorate(host.id, await host.request<SessionSnapshot>(command)) as T;
    }
    const sessionCommand = ["prompt", "rewind_prompt", "steer", "abort", "refresh_project", "list_directory", "read_file"].includes(command.type);
    if (sessionCommand && !runtimeId) throw new Error("当前会话缺少运行时标识。");
    const host = this.host(sessionCommand || runtimeId ? runtimeId ?? this.controlId : this.controlId);
    const result = await host.request<T>(command);
    if (result && typeof result === "object" && "session" in result) return this.decorate(host.id, result as unknown as SessionSnapshot) as T;
    return result;
  }

  stop(): void {
    for (const host of this.hosts.values()) host.stop();
    this.hosts.clear();
    this.sessions.clear();
  }
}

const runtime = new RuntimePool();

function createWindow(): void {
  const isMac = process.platform === "darwin";
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 395,
    minHeight: 500,
    show: false,
    backgroundColor: "#f7f7f5",
    title: "SuoCode",
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 18 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  runtime.start();
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
  ipcMain.handle(PREVIEW_OPEN_CHANNEL, (event, input: OpenFilePreviewInput) => openPreviewOrMenu(event, input));
  ipcMain.handle(PREVIEW_GET_CHANNEL, async (_event, id: string): Promise<FilePreviewDocument> => {
    const record = previews.get(id);
    if (!record) throw new Error("文件预览窗口已失效。");
    record.document = await readPreview(record);
    return record.document;
  });
  ipcMain.handle(RUNTIME_REQUEST_CHANNEL, (_event, payload: RuntimeRequestPayload) => runtime.request(payload));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  for (const preview of previews.values()) preview.watcher?.close();
  previews.clear();
  runtime.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
