import type {
  FileNode,
  ProjectSelection,
  RuntimeCommand,
  RuntimeEvent,
  ScopedRuntimeEvent,
} from "@suocode/runtime-protocol";

export type { ProjectSelection } from "@suocode/runtime-protocol";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export type PreviewKind = "text" | "markdown" | "html" | "pdf";

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
  tabs: BrowserTabSnapshot[];
  activeTabId?: string;
}

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
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
  getBrowserState(): Promise<BrowserStateSnapshot>;
  createBrowserTab(url?: string): Promise<BrowserStateSnapshot>;
  selectBrowserTab(id: string): Promise<BrowserStateSnapshot>;
  closeBrowserTab(id: string): Promise<BrowserStateSnapshot>;
  navigateBrowser(url: string): Promise<BrowserStateSnapshot>;
  browserBack(): Promise<BrowserStateSnapshot>;
  browserForward(): Promise<BrowserStateSnapshot>;
  reloadBrowser(): Promise<BrowserStateSnapshot>;
  setBrowserViewBounds(bounds: BrowserViewBounds): Promise<void>;
  onBrowserStateUpdated(listener: (state: BrowserStateSnapshot) => void): () => void;
  onBrowserAgentActivated(listener: () => void): () => void;
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
