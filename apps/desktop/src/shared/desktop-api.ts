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

export type TerminalLaunchKind = "shell" | "claude" | "codex" | "pi";

export interface DesktopTerminalSession {
  id: string;
  cwd: string;
  title: string;
  kind: TerminalLaunchKind;
  pid: number;
  running: boolean;
  exitCode?: number;
  signal?: number;
  createdAt: number;
  buffer: string;
}

export interface CreateTerminalInput {
  cwd: string;
  kind: TerminalLaunchKind;
  cols?: number;
  rows?: number;
}

export type DesktopTerminalEvent =
  | { type: "created"; session: DesktopTerminalSession }
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number; signal?: number }
  | { type: "closed"; id: string };

export interface SuoCodeDesktopApi {
  platform: DesktopPlatform;
  homeProject(): Promise<ProjectSelection>;
  selectProject(): Promise<ProjectSelection | null>;
  setWindowMinimumWidth(width: number): Promise<void>;
  openExternal(url: string): Promise<void>;
  openFilePreview(input: OpenFilePreviewInput): Promise<{ opened: boolean }>;
  getFilePreview(id: string): Promise<FilePreviewDocument>;
  onFilePreviewUpdated(listener: (document: FilePreviewDocument) => void): () => void;
  listTerminals(): Promise<DesktopTerminalSession[]>;
  createTerminal(input: CreateTerminalInput): Promise<DesktopTerminalSession>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminalEvent(listener: (event: DesktopTerminalEvent) => void): () => void;
  listProjectDirectory(root: string, path?: string): Promise<FileNode[]>;
  request<T = unknown>(command: RuntimeCommand, runtimeId?: string): Promise<T>;
  onRuntimeEvent(listener: (event: RuntimeEvent, runtimeId?: string) => void): () => void;
}


export interface RuntimeRequestPayload {
  command: RuntimeCommand;
  runtimeId?: string;
}

export type RuntimeEventPayload = ScopedRuntimeEvent;
