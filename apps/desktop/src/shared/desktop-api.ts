import type {
  DiagnosticLogBatch,
  FileNode,
  ProjectSelection,
  RuntimeCommand,
  RuntimeEvent,
  ScopedRuntimeEvent,
} from "@coilcoil/runtime-protocol";

export type { ProjectSelection } from "@coilcoil/runtime-protocol";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export type PreviewKind = "text" | "markdown" | "html" | "pdf" | "image";

export interface FilePreviewDocument {
  id: string;
  path: string;
  name: string;
  kind: PreviewKind;
  content: string;
  truncated: boolean;
  updatedAt: number;
}

export interface OpenFilePreviewInput {
  root: string;
  path: string;
  forceText?: boolean;
}

export type FileFallbackAction = "reveal" | "force-text" | "trash";

export interface OpenFilePreviewResult {
  opened: boolean;
  document?: FilePreviewDocument;
  actions?: FileFallbackAction[];
}

export type ProjectFileAction = "reveal" | "trash";

/** What an absolute path in the transcript points at. */
export type PathKind = "file" | "directory" | "missing";

export interface ProjectFileActionInput {
  root: string;
  path: string;
  action: ProjectFileAction;
}

export interface ProjectFileActionResult {
  completed: boolean;
  trashed?: boolean;
}

export interface BrowserTabSnapshot {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserStateSnapshot {
  scopeId: string;
  tabs: BrowserTabSnapshot[];
  activeTabId?: string;
}

/**
 * One `<webview>` the renderer must keep mounted. Deliberately carries no URL and
 * no scope id: the app document never holds one agent's browsing state, and there
 * is no scope value in the renderer for a bug to mis-associate.
 */
export interface BrowserGuestSlot {
  tabId: string;
  nonce: string;
}

export interface BrowserGuestRoster {
  tabs: BrowserGuestSlot[];
}

/** Visible size of the browser panel, so agents see the viewport the user sees. */
export interface BrowserUiViewport {
  width: number;
  height: number;
}

export interface TerminalSessionSnapshot {
  id: string;
  cwd: string;
  output: string;
  status: "running" | "exited";
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface UpdateAvailable {
  current: string;
  latest: string;
  url: string;
}

export interface CoilCoilDesktopApi {
  platform: DesktopPlatform;
  /** The running build's version, as packaged. */
  appVersion(): Promise<string>;
  homeProject(): Promise<ProjectSelection>;
  selectProject(): Promise<ProjectSelection | null>;
  pickDirectory(options?: { title?: string }): Promise<string | null>;
  setWindowMinimumWidth(width: number): Promise<void>;
  /** Widen the window by this many pixels so an opening panel need not shrink the conversation. */
  growWindowWidth(byPixels: number): Promise<void>;
  /** 同步窗口底色（CSS 颜色字面量），避免暗色主题下窗口画布仍是浅色。 */
  setWindowBackground(color: string): Promise<void>;
  /** 从系统拖入的文件解析出绝对路径；渲染进程自己拿不到。 */
  filePath(file: File): string;
  openExternal(url: string): Promise<void>;
  /** Classify absolute paths so a link can be drawn and routed correctly. */
  classifyPaths(paths: string[]): Promise<Record<string, PathKind>>;
  /** Show the path in the operating system's file manager. */
  revealPath(path: string): Promise<boolean>;
  copyText(text: string): Promise<void>;
  openFilePreview(input: OpenFilePreviewInput): Promise<OpenFilePreviewResult>;
  closeFilePreview(id: string): Promise<void>;
  performProjectFileAction(input: ProjectFileActionInput): Promise<ProjectFileActionResult>;
  onFilePreviewUpdated(listener: (document: FilePreviewDocument) => void): () => void;
  listProjectDirectory(root: string, path?: string): Promise<FileNode[]>;
  setBrowserScope(scopeId: string): Promise<BrowserStateSnapshot>;
  getBrowserState(scopeId: string): Promise<BrowserStateSnapshot>;
  createBrowserTab(scopeId: string, url?: string): Promise<BrowserStateSnapshot>;
  selectBrowserTab(scopeId: string, id: string): Promise<BrowserStateSnapshot>;
  closeBrowserTab(scopeId: string, id: string): Promise<BrowserStateSnapshot>;
  navigateBrowser(scopeId: string, url: string): Promise<BrowserStateSnapshot>;
  browserBack(scopeId: string): Promise<BrowserStateSnapshot>;
  browserForward(scopeId: string): Promise<BrowserStateSnapshot>;
  reloadBrowser(scopeId: string): Promise<BrowserStateSnapshot>;
  setBrowserUiViewport(viewport: BrowserUiViewport): Promise<void>;
  /** The guest layer has mounted; returns the roster it must reconcile against. */
  browserGuestLayerReady(): Promise<BrowserGuestRoster>;
  /** Report the guest created for a roster slot. Rejects rather than rebinding. */
  registerBrowserGuest(tabId: string, nonce: string, webContentsId: number): Promise<void>;
  /** The element could not be created or died before registering. */
  reportBrowserGuestFailure(tabId: string, nonce: string, reason: string): Promise<void>;
  onBrowserGuestRoster(listener: (roster: BrowserGuestRoster) => void): () => void;
  onBrowserStateUpdated(listener: (state: BrowserStateSnapshot) => void): () => void;
  onBrowserAgentActivated(listener: (scopeId: string) => void): () => void;
  getTerminalSessions(): Promise<TerminalSessionSnapshot[]>;
  /** Always opens another shell: each one gets its own inspector tab. */
  createTerminal(cwd: string): Promise<TerminalSessionSnapshot[]>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<TerminalSessionSnapshot[]>;
  onTerminalStateUpdated(listener: (state: TerminalSessionSnapshot[]) => void): () => void;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  request<T = unknown>(command: RuntimeCommand, runtimeId?: string): Promise<T>;
  onRuntimeEvent(listener: (event: RuntimeEvent, runtimeId?: string) => void): () => void;
  onUpdateAvailable(listener: (update: UpdateAvailable) => void): () => void;
  /** The three things a title bar does, for the buttons the Renderer draws. */
  minimizeWindow(): void;
  toggleWindowMaximized(): void;
  closeWindow(): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximizedChange(listener: (maximized: boolean) => void): () => void;
  /** Hand Renderer entries to the process that owns the log file. */
  writeDiagnostics(batch: DiagnosticLogBatch): void;
  /** Show the log in the file manager and return its path. */
  revealDiagnostics(): Promise<string>;
}


export interface RuntimeRequestPayload {
  command: RuntimeCommand;
  runtimeId?: string;
}

export type RuntimeRequestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type RuntimeEventPayload = ScopedRuntimeEvent;
