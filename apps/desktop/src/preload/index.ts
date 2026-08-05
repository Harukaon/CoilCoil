import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopPlatform,
  ProjectSelection,
  SuoCodeDesktopApi,
} from "../shared/desktop-api";

const PROJECT_SELECT_CHANNEL = "project:select";

const platform = ((): DesktopPlatform => {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
})();

const api: SuoCodeDesktopApi = {
  platform,
  selectProject: () =>
    ipcRenderer.invoke(PROJECT_SELECT_CHANNEL) as Promise<ProjectSelection | null>,
};

contextBridge.exposeInMainWorld("suocode", api);

