import type {
  ProjectSelection,
  RuntimeCommand,
  RuntimeEvent,
} from "@suocode/runtime-protocol";

export type { ProjectSelection } from "@suocode/runtime-protocol";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export interface SuoCodeDesktopApi {
  platform: DesktopPlatform;
  selectProject(): Promise<ProjectSelection | null>;
  request<T = unknown>(command: RuntimeCommand): Promise<T>;
  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
}
