import type {
  FileNode,
  ProjectSelection,
  RuntimeCommand,
  RuntimeEvent,
  ScopedRuntimeEvent,
} from "@suocode/runtime-protocol";

export type { ProjectSelection } from "@suocode/runtime-protocol";

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

export interface SuoCodeDesktopApi {
  platform: DesktopPlatform;
  homeProject(): Promise<ProjectSelection>;
  selectProject(): Promise<ProjectSelection | null>;
  pickDirectory(options?: { title?: string }): Promise<string | null>;
  setWindowMinimumWidth(width: number): Promise<void>;
  openExternal(url: string): Promise<void>;
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
}


export interface RuntimeRequestPayload {
  command: RuntimeCommand;
  runtimeId?: string;
}

export type RuntimeRequestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type RuntimeEventPayload = ScopedRuntimeEvent;
