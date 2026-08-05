export interface ProjectSelection {
  name: string;
  path: string;
}

export type DesktopPlatform = "darwin" | "linux" | "win32";

export interface SuoCodeDesktopApi {
  platform: DesktopPlatform;
  selectProject(): Promise<ProjectSelection | null>;
}

