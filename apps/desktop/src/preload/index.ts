import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeCommand, RuntimeEvent } from "@suocode/runtime-protocol";
import type {
  DesktopPlatform,
  FilePreviewDocument,
  OpenFilePreviewInput,
  ProjectSelection,
  RuntimeEventPayload,
  RuntimeRequestPayload,
  SuoCodeDesktopApi,
} from "../shared/desktop-api";

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const WINDOW_MINIMUM_WIDTH_CHANNEL = "window:minimum-width";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";
const PREVIEW_OPEN_CHANNEL = "preview:open";
const PREVIEW_GET_CHANNEL = "preview:get";
const PREVIEW_UPDATED_CHANNEL = "preview:updated";

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
  setWindowMinimumWidth: (width: number) =>
    ipcRenderer.invoke(WINDOW_MINIMUM_WIDTH_CHANNEL, width) as Promise<void>,
  openFilePreview: (input: OpenFilePreviewInput) =>
    ipcRenderer.invoke(PREVIEW_OPEN_CHANNEL, input) as Promise<{ opened: boolean }>,
  getFilePreview: (id: string) =>
    ipcRenderer.invoke(PREVIEW_GET_CHANNEL, id) as Promise<FilePreviewDocument>,
  onFilePreviewUpdated: (listener: (document: FilePreviewDocument) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, document: FilePreviewDocument): void => listener(document);
    ipcRenderer.on(PREVIEW_UPDATED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(PREVIEW_UPDATED_CHANNEL, handler);
  },
  request: <T>(command: RuntimeCommand, runtimeId?: string) =>
    ipcRenderer.invoke(RUNTIME_REQUEST_CHANNEL, { command, runtimeId } satisfies RuntimeRequestPayload) as Promise<T>,
  onRuntimeEvent: (listener: (event: RuntimeEvent, runtimeId?: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RuntimeEventPayload): void => listener(value.event, value.runtimeId);
    ipcRenderer.on(RUNTIME_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(RUNTIME_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("suocode", api);
