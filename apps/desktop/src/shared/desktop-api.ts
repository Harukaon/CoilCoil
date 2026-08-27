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

/** The bubble's global shortcut: nothing is claimed until the user picks one. */
export interface BubbleShortcutState {
  accelerator?: string;
  registered: boolean;
  error?: string;
  /** Offered in the settings page as a starting point, never applied on its own. */
  suggestion?: string;
}

export interface McpConnectionTestInput {
  url: string;
  headers?: Record<string, string>;
}

/** What an MCP server answered when asked to shake hands. */
export type McpConnectionTest =
  | { ok: true; status: number; statusText: string; body: string }
  | { ok: false; error: string };

/** Which conversation the bubble was on when it handed over to the main window. */
export interface BubbleSessionTarget {
  cwd: string;
  sessionPath: string;
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

/** A browser CoilCoil can import an existing signed-in state from. */
export type ImportableBrowserId =
  | "chrome"
  | "chrome-beta"
  | "chrome-canary"
  | "chromium"
  | "edge"
  | "brave"
  | "vivaldi"
  | "arc"
  | "safari";

/**
 * One profile of one installed browser. Chrome keeps a separate persona per
 * profile directory, so the user must be able to say which one to take.
 */
export interface ImportableProfile {
  browser: ImportableBrowserId;
  browserName: string;
  /** Profile directory name, or "default" for browsers without profiles. */
  id: string;
  name: string;
  email?: string;
  /** Absent when the count could not be read without asking for credentials. */
  cookieCount?: number;
  passwordCount?: number;
  available: boolean;
  /** Why it cannot be imported right now, when `available` is false. */
  problem?: string;
}

export interface ImportBrowserCookiesInput {
  browser: ImportableBrowserId;
  profile: string;
  /** Saved logins are a separate decision from sessions, so they are opt-in. */
  includePasswords?: boolean;
}

export interface BrowserImportSummary {
  imported: number;
  /** Expired or malformed records that were never worth writing. */
  skipped: number;
  /** Records the built-in browser refused. */
  failed: number;
  /** Records that could not be decrypted or parsed at the source. */
  unreadable: number;
  /** Distinct sites now carrying a session. */
  hosts: number;
  /** Saved logins written into CoilCoil's own encrypted store. */
  passwords: number;
  /** Something was skipped but the import itself succeeded. */
  note?: string;
  error?: string;
}

/** What the built-in browser currently remembers. */
export interface BrowserDataStats {
  cookies: number;
  hosts: number;
  savedLogins: number;
}

/** A saved login as it may be shown on screen: never the password itself. */
export interface SavedLoginSummary {
  origin: string;
  username: string;
  importedAt: number;
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

/** How the phone reaches this Mac from outside the local network. */
export type RemoteTunnelMode = "reverse-proxy" | "tailscale";

export interface RemotePairedDevice {
  name: string;
  pairedAt: number;
  lastSeenAt: number;
}

export interface RemoteAccessState {
  enabled: boolean;
  /** False while enabled means the entry point failed to start; see `error`. */
  running: boolean;
  port: number;
  host: string;
  mode: RemoteTunnelMode;
  publicUrl?: string;
  keepAwake: boolean;
  keepAwakeActive: boolean;
  /** Skip the login screen for connections from the user's own tailnet or LAN. */
  trustLocalNetwork: boolean;
  /** The account that can sign in without a pairing code, when one is set. */
  username?: string;
  /** This Mac's tailnet address, when Tailscale is running. */
  tailscaleAddress?: string;
  /** Present only while running: a code means nothing with nothing listening. */
  pairingCode?: string;
  devices: RemotePairedDevice[];
  connectedClients: number;
  error?: string;
}

export interface RemoteAccessInput {
  enabled?: boolean;
  port?: number;
  host?: string;
  mode?: RemoteTunnelMode;
  publicUrl?: string;
  keepAwake?: boolean;
  trustLocalNetwork?: boolean;
}

export interface CoilCoilDesktopApi {
  /**
   * Set only by the browser-side bridge a phone loads. The renderer uses it to
   * pick the phone layout, which must never be chosen from window width alone:
   * a desktop window dragged narrow is still a desktop window.
   */
  isRemote?: boolean;
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
  /** Dismiss the floating bubble window; its conversation stays alive. */
  /** Shake hands with an HTTP MCP server and report what it said. */
  testMcpConnection(input: McpConnectionTestInput): Promise<McpConnectionTest>;
  getBubbleShortcut(): Promise<BubbleShortcutState>;
  /** Claim an accelerator, or release the current one when given nothing. */
  setBubbleShortcut(accelerator?: string): Promise<BubbleShortcutState>;
  hideBubble(): Promise<void>;
  /** Hand the bubble's conversation to the main window and dismiss the bubble. */
  openMainWindow(target?: BubbleSessionTarget): Promise<void>;
  /** The main window listens for a conversation handed over from the bubble. */
  onOpenBubbleSession(listener: (target: BubbleSessionTarget) => void): () => void;
  listProjectDirectory(root: string, path?: string): Promise<FileNode[]>;
  setBrowserScope(scopeId: string): Promise<BrowserStateSnapshot>;
  getBrowserState(scopeId: string): Promise<BrowserStateSnapshot>;
  /**
   * A JPEG data URL of the built-in browser's current page, or undefined when
   * no tab can be captured. Used by the remote client, which cannot host the
   * `<webview>` the desktop window renders the page into.
   */
  captureBrowserTab(scopeId: string): Promise<string | undefined>;
  createBrowserTab(scopeId: string, url?: string): Promise<BrowserStateSnapshot>;
  selectBrowserTab(scopeId: string, id: string): Promise<BrowserStateSnapshot>;
  closeBrowserTab(scopeId: string, id: string): Promise<BrowserStateSnapshot>;
  navigateBrowser(scopeId: string, url: string): Promise<BrowserStateSnapshot>;
  browserBack(scopeId: string): Promise<BrowserStateSnapshot>;
  browserForward(scopeId: string): Promise<BrowserStateSnapshot>;
  reloadBrowser(scopeId: string): Promise<BrowserStateSnapshot>;
  setBrowserUiViewport(viewport: BrowserUiViewport): Promise<void>;
  /** Browsers installed on this Mac whose signed-in state can be taken over. */
  listImportableBrowsers(): Promise<ImportableProfile[]>;
  /** Copy one profile's cookies into the built-in browser. May prompt for the keychain. */
  importBrowserCookies(input: ImportBrowserCookiesInput): Promise<BrowserImportSummary>;
  getBrowserDataStats(): Promise<BrowserDataStats>;
  /** Origins and usernames of the imported logins; the passwords never leave main. */
  listSavedLogins(): Promise<SavedLoginSummary[]>;
  /** Sign the built-in browser out of everything, including saved logins. */
  clearBrowserData(): Promise<BrowserDataStats>;
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
  getRemoteAccess(): Promise<RemoteAccessState>;
  saveRemoteAccess(input: RemoteAccessInput): Promise<RemoteAccessState>;
  regenerateRemotePairingCode(): Promise<RemoteAccessState>;
  setRemoteAccount(username: string, password: string): Promise<RemoteAccessState>;
  revokeRemoteDevices(): Promise<RemoteAccessState>;
  onRemoteAccessChanged(listener: (state: RemoteAccessState) => void): () => void;
}


export interface RuntimeRequestPayload {
  command: RuntimeCommand;
  runtimeId?: string;
}

export type RuntimeRequestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type RuntimeEventPayload = ScopedRuntimeEvent;
