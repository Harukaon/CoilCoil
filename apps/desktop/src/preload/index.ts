import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeCommand, RuntimeEvent } from "@suocode/runtime-protocol";
import type {
  DesktopPlatform,
  ProjectSelection,
  SuoCodeDesktopApi,
} from "../shared/desktop-api";

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";

const platform = ((): DesktopPlatform => {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
})();

const api: SuoCodeDesktopApi = {
  platform,
  homeProject: () =>
    ipcRenderer.invoke(PROJECT_HOME_CHANNEL) as Promise<ProjectSelection>,
  selectProject: () =>
    ipcRenderer.invoke(PROJECT_SELECT_CHANNEL) as Promise<ProjectSelection | null>,
  request: <T>(command: RuntimeCommand) =>
    ipcRenderer.invoke(RUNTIME_REQUEST_CHANNEL, command) as Promise<T>,
  onRuntimeEvent: (listener: (event: RuntimeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RuntimeEvent): void => listener(value);
    ipcRenderer.on(RUNTIME_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(RUNTIME_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("suocode", api);
