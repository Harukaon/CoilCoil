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

export interface SuoCodeDesktopApi {
  platform: DesktopPlatform;
  homeProject(): Promise<ProjectSelection>;
  selectProject(): Promise<ProjectSelection | null>;
  pickDirectory(options?: { title?: string }): Promise<string | null>;
  setWindowMinimumWidth(width: number): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  openFilePreview(input: OpenFilePreviewInput): Promise<OpenFilePreviewResult>;
  performProjectFileAction(input: ProjectFileActionInput): Promise<ProjectFileActionResult>;
  getFilePreview(id: string): Promise<FilePreviewDocument>;
  onFilePreviewUpdated(listener: (document: FilePreviewDocument) => void): () => void;
  listProjectDirectory(root: string, path?: string): Promise<FileNode[]>;
  request<T = unknown>(command: RuntimeCommand, runtimeId?: string): Promise<T>;
  onRuntimeEvent(listener: (event: RuntimeEvent, runtimeId?: string) => void): () => void;
}


export interface RuntimeRequestPayload {
  command: RuntimeCommand;
  runtimeId?: string;
}

export type RuntimeEventPayload = ScopedRuntimeEvent;
