import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeCommand, RuntimeEvent } from "@suocode/runtime-protocol";
import type { FileNode } from "@suocode/runtime-protocol";
import type {
  DesktopPlatform,
  BrowserGuestRoster,
  BrowserStateSnapshot,
  BrowserUiViewport,
  FilePreviewDocument,
  OpenFilePreviewInput,
  OpenFilePreviewResult,
  ProjectFileActionInput,
  ProjectFileActionResult,
  ProjectSelection,
  RuntimeEventPayload,
  RuntimeRequestPayload,
  RuntimeRequestResult,
  SuoCodeDesktopApi,
  TerminalSessionSnapshot,
} from "../shared/desktop-api";

const PROJECT_SELECT_CHANNEL = "project:select";
const PROJECT_HOME_CHANNEL = "project:home";
const PICK_DIRECTORY_CHANNEL = "dialog:pick-directory";
const WINDOW_MINIMUM_WIDTH_CHANNEL = "window:minimum-width";
const EXTERNAL_OPEN_CHANNEL = "external:open";
const CLIPBOARD_WRITE_CHANNEL = "clipboard:write";
const RUNTIME_REQUEST_CHANNEL = "runtime:request";
const RUNTIME_EVENT_CHANNEL = "runtime:event";
const PREVIEW_OPEN_CHANNEL = "preview:open";
const PREVIEW_CLOSE_CHANNEL = "preview:close";
const PREVIEW_UPDATED_CHANNEL = "preview:updated";
const PROJECT_FILE_ACTION_CHANNEL = "project-file:action";
const PROJECT_DIRECTORY_LIST_CHANNEL = "project-directory:list";
const BROWSER_STATE_CHANNEL = "browser:state";
const BROWSER_AGENT_ACTIVATED_CHANNEL = "browser:agent-activated";
const BROWSER_GET_STATE_CHANNEL = "browser:get-state";
const BROWSER_SET_SCOPE_CHANNEL = "browser:set-scope";
const BROWSER_CREATE_TAB_CHANNEL = "browser:create-tab";
const BROWSER_SELECT_TAB_CHANNEL = "browser:select-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "browser:close-tab";
const BROWSER_NAVIGATE_CHANNEL = "browser:navigate";
const BROWSER_BACK_CHANNEL = "browser:back";
const BROWSER_FORWARD_CHANNEL = "browser:forward";
const BROWSER_RELOAD_CHANNEL = "browser:reload";
const BROWSER_UI_VIEWPORT_CHANNEL = "browser:ui-viewport";
const BROWSER_GUEST_ROSTER_CHANNEL = "browser:guest-roster";
const BROWSER_GUEST_LAYER_READY_CHANNEL = "browser:guest-layer-ready";
const BROWSER_REGISTER_GUEST_CHANNEL = "browser:register-guest";
const BROWSER_GUEST_FAILED_CHANNEL = "browser:guest-failed";
const TERMINAL_STATE_CHANNEL = "terminal:state";
const TERMINAL_CREATE_CHANNEL = "terminal:create";
const TERMINAL_WRITE_CHANNEL = "terminal:write";
const TERMINAL_RESIZE_CHANNEL = "terminal:resize";
const TERMINAL_CLOSE_CHANNEL = "terminal:close";

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
  pickDirectory: (options?: { title?: string }) =>
    ipcRenderer.invoke(PICK_DIRECTORY_CHANNEL, options) as Promise<string | null>,
  setWindowMinimumWidth: (width: number) =>
    ipcRenderer.invoke(WINDOW_MINIMUM_WIDTH_CHANNEL, width) as Promise<void>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(EXTERNAL_OPEN_CHANNEL, url) as Promise<void>,
  copyText: (text: string) =>
    ipcRenderer.invoke(CLIPBOARD_WRITE_CHANNEL, text) as Promise<void>,
  openFilePreview: (input: OpenFilePreviewInput) =>
    ipcRenderer.invoke(PREVIEW_OPEN_CHANNEL, input) as Promise<OpenFilePreviewResult>,
  closeFilePreview: (id: string) =>
    ipcRenderer.invoke(PREVIEW_CLOSE_CHANNEL, id) as Promise<void>,
  performProjectFileAction: (input: ProjectFileActionInput) =>
    ipcRenderer.invoke(PROJECT_FILE_ACTION_CHANNEL, input) as Promise<ProjectFileActionResult>,
  onFilePreviewUpdated: (listener: (document: FilePreviewDocument) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, document: FilePreviewDocument): void => listener(document);
    ipcRenderer.on(PREVIEW_UPDATED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(PREVIEW_UPDATED_CHANNEL, handler);
  },
  listProjectDirectory: (root: string, path?: string) => ipcRenderer.invoke(PROJECT_DIRECTORY_LIST_CHANNEL, root, path) as Promise<FileNode[]>,
  setBrowserScope: (scopeId: string) => ipcRenderer.invoke(BROWSER_SET_SCOPE_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  getBrowserState: (scopeId: string) => ipcRenderer.invoke(BROWSER_GET_STATE_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  createBrowserTab: (scopeId: string, url?: string) => ipcRenderer.invoke(BROWSER_CREATE_TAB_CHANNEL, scopeId, url) as Promise<BrowserStateSnapshot>,
  selectBrowserTab: (scopeId: string, id: string) => ipcRenderer.invoke(BROWSER_SELECT_TAB_CHANNEL, scopeId, id) as Promise<BrowserStateSnapshot>,
  closeBrowserTab: (scopeId: string, id: string) => ipcRenderer.invoke(BROWSER_CLOSE_TAB_CHANNEL, scopeId, id) as Promise<BrowserStateSnapshot>,
  navigateBrowser: (scopeId: string, url: string) => ipcRenderer.invoke(BROWSER_NAVIGATE_CHANNEL, scopeId, url) as Promise<BrowserStateSnapshot>,
  browserBack: (scopeId: string) => ipcRenderer.invoke(BROWSER_BACK_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  browserForward: (scopeId: string) => ipcRenderer.invoke(BROWSER_FORWARD_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  reloadBrowser: (scopeId: string) => ipcRenderer.invoke(BROWSER_RELOAD_CHANNEL, scopeId) as Promise<BrowserStateSnapshot>,
  setBrowserUiViewport: (viewport: BrowserUiViewport) => ipcRenderer.invoke(BROWSER_UI_VIEWPORT_CHANNEL, viewport) as Promise<void>,
  browserGuestLayerReady: () => ipcRenderer.invoke(BROWSER_GUEST_LAYER_READY_CHANNEL) as Promise<BrowserGuestRoster>,
  registerBrowserGuest: (tabId: string, nonce: string, webContentsId: number) =>
    ipcRenderer.invoke(BROWSER_REGISTER_GUEST_CHANNEL, tabId, nonce, webContentsId) as Promise<void>,
  reportBrowserGuestFailure: (tabId: string, nonce: string, reason: string) =>
    ipcRenderer.invoke(BROWSER_GUEST_FAILED_CHANNEL, tabId, nonce, reason) as Promise<void>,
  onBrowserGuestRoster: (listener: (roster: BrowserGuestRoster) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, roster: BrowserGuestRoster): void => listener(roster);
    ipcRenderer.on(BROWSER_GUEST_ROSTER_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BROWSER_GUEST_ROSTER_CHANNEL, handler);
  },
  onBrowserStateUpdated: (listener: (state: BrowserStateSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserStateSnapshot): void => listener(state);
    ipcRenderer.on(BROWSER_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BROWSER_STATE_CHANNEL, handler);
  },
  onBrowserAgentActivated: (listener: (scopeId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scopeId: string): void => listener(scopeId);
    ipcRenderer.on(BROWSER_AGENT_ACTIVATED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BROWSER_AGENT_ACTIVATED_CHANNEL, handler);
  },
  createTerminal: (cwd: string) => ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, cwd) as Promise<TerminalSessionSnapshot[]>,
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke(TERMINAL_WRITE_CHANNEL, id, data) as Promise<void>,
  resizeTerminal: (id: string, cols: number, rows: number) => ipcRenderer.invoke(TERMINAL_RESIZE_CHANNEL, id, cols, rows) as Promise<void>,
  closeTerminal: (id: string) => ipcRenderer.invoke(TERMINAL_CLOSE_CHANNEL, id) as Promise<TerminalSessionSnapshot[]>,
  onTerminalStateUpdated: (listener: (state: TerminalSessionSnapshot[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TerminalSessionSnapshot[]): void => listener(state);
    ipcRenderer.on(TERMINAL_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(TERMINAL_STATE_CHANNEL, handler);
  },
  request: async <T>(command: RuntimeCommand, runtimeId?: string): Promise<T> => {
    const result = await ipcRenderer.invoke(
      RUNTIME_REQUEST_CHANNEL,
      { command, runtimeId } satisfies RuntimeRequestPayload,
    ) as RuntimeRequestResult;
    if (!result.ok) throw new Error(result.error);
    return result.value as T;
  },
  onRuntimeEvent: (listener: (event: RuntimeEvent, runtimeId?: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RuntimeEventPayload): void => listener(value.event, value.runtimeId);
    ipcRenderer.on(RUNTIME_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(RUNTIME_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("suocode", api);
