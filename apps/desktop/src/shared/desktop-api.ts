import type {
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

export interface SuoCodeDesktopApi {
  platform: DesktopPlatform;
  homeProject(): Promise<ProjectSelection>;
  selectProject(): Promise<ProjectSelection | null>;
  setWindowMinimumWidth(width: number): Promise<void>;
  openExternal(url: string): Promise<void>;
  openFilePreview(input: OpenFilePreviewInput): Promise<{ opened: boolean }>;
  getFilePreview(id: string): Promise<FilePreviewDocument>;
  onFilePreviewUpdated(listener: (document: FilePreviewDocument) => void): () => void;
  request<T = unknown>(command: RuntimeCommand, runtimeId?: string): Promise<T>;
  onRuntimeEvent(listener: (event: RuntimeEvent, runtimeId?: string) => void): () => void;
}


export interface RuntimeRequestPayload {
  command: RuntimeCommand;
  runtimeId?: string;
}

export type RuntimeEventPayload = ScopedRuntimeEvent;
