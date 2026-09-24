import { BrainCircuit, Files, FileText, GitBranch, Globe2, Terminal } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { FileNode } from "@coilcoil/runtime-protocol";
import type { LucideIcon } from "lucide-react";

export type InspectorTabKind = "files" | "browser" | "runtime" | "git" | "terminal" | "file";
export type InspectorTabId = string;

export interface InspectorTabDefinition {
  id: InspectorTabId;
  kind: InspectorTabKind;
  label: string;
  icon: LucideIcon;
  path?: string;
  /**
   * The shell a terminal tab shows.
   *
   * Terminals are one tab per shell rather than one panel holding its own
   * strip: opening a second shell belongs in the same row as 文件 and 浏览器,
   * not in a second row of chrome nested under a single 终端 tab.
   */
  terminalId?: string;
}

export interface WorkspaceInspectorState {
  tabs: InspectorTabDefinition[];
  activeTabId?: InspectorTabId;
  selectedFilePath?: string;
  rightOpen: boolean;
}

export const EMPTY_WORKSPACE_INSPECTOR: WorkspaceInspectorState = {
  tabs: [],
  rightOpen: false,
};

export function updateWorkspaceInspectorState(
  states: Record<string, WorkspaceInspectorState>,
  workspaceKey: string,
  change: (current: WorkspaceInspectorState) => WorkspaceInspectorState,
): Record<string, WorkspaceInspectorState> {
  return {
    ...states,
    [workspaceKey]: change(states[workspaceKey] ?? EMPTY_WORKSPACE_INSPECTOR),
  };
}

export function fileInspectorTabId(path: string): string {
  return `file:${path}`;
}

export function terminalInspectorTabId(sessionId: string): string {
  return `terminal:${sessionId}`;
}

function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

function selectedFileForTab(tab: InspectorTabDefinition | undefined): string | undefined {
  return tab?.kind === "file" ? tab.path : undefined;
}

export function openWorkspaceInspectorTab(
  state: WorkspaceInspectorState,
  tab: InspectorTabDefinition,
): WorkspaceInspectorState {
  return {
    tabs: state.tabs.some((item) => item.id === tab.id) ? state.tabs : [...state.tabs, tab],
    activeTabId: tab.id,
    selectedFilePath: selectedFileForTab(tab),
    rightOpen: true,
  };
}

export function selectWorkspaceInspectorTab(
  state: WorkspaceInspectorState,
  id: InspectorTabId,
): WorkspaceInspectorState {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return state;
  return {
    ...state,
    activeTabId: id,
    selectedFilePath: selectedFileForTab(tab),
    rightOpen: true,
  };
}

export function closeWorkspaceInspectorTab(
  state: WorkspaceInspectorState,
  id: InspectorTabId,
): WorkspaceInspectorState {
  const tabs = state.tabs.filter((item) => item.id !== id);
  const activeTabId = state.activeTabId === id
    ? tabs.at(-1)?.id
    : state.activeTabId && tabs.some((item) => item.id === state.activeTabId)
      ? state.activeTabId
      : tabs.at(-1)?.id;
  const active = tabs.find((item) => item.id === activeTabId);
  return {
    ...state,
    tabs,
    activeTabId,
    selectedFilePath: selectedFileForTab(active),
    // 关闭最后一个标签页时自动收回右侧面板，而不是留一个空面板。
    rightOpen: tabs.length > 0 ? state.rightOpen : false,
  };
}

/**
 * Point a terminal tab at a different shell.
 *
 * A shell can die under its tab — the user types `exit`, or the app is asked
 * to reopen one that main no longer has. Rebinding keeps the tab where it sits
 * in the strip instead of making the user close it and open a replacement that
 * lands at the far end of the row.
 */
export function rebindWorkspaceTerminalTab(
  state: WorkspaceInspectorState,
  tabId: InspectorTabId,
  sessionId: string,
): WorkspaceInspectorState {
  const target = state.tabs.find((item) => item.id === tabId);
  if (target?.kind !== "terminal") return state;
  const id = terminalInspectorTabId(sessionId);
  return {
    ...state,
    tabs: state.tabs.map((item) => item.id === tabId ? { ...item, id, terminalId: sessionId } : item),
    activeTabId: state.activeTabId === tabId ? id : state.activeTabId,
  };
}

export function removeWorkspaceInspectorPath(
  state: WorkspaceInspectorState,
  path: string,
): WorkspaceInspectorState {
  const belongsToPath = (value?: string): boolean => Boolean(
    value && (value === path || value.startsWith(`${path}/`) || value.startsWith(`${path}\\`)),
  );
  const tabs = state.tabs.filter((tab) => tab.kind !== "file" || !belongsToPath(tab.path));
  const activeTabId = state.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : tabs.at(-1)?.id;
  return {
    ...state,
    tabs,
    activeTabId,
    selectedFilePath: selectedFileForTab(tabs.find((tab) => tab.id === activeTabId)),
    // 移除路径清空所有标签页时同样收回右侧面板。
    rightOpen: tabs.length > 0 ? state.rightOpen : false,
  };
}

export function useWorkspaceInspector(workspacePath?: string): {
  state: WorkspaceInspectorState;
  activeTab?: InspectorTabDefinition;
  setRightOpen(open: boolean): void;
  openFilesTab(): void;
  openBrowserTab(): void;
  openRuntimeTab(): void;
  openGitTab(): void;
  openTerminalTab(sessionId: string): void;
  rebindTerminalTab(tabId: InspectorTabId, sessionId: string): void;
  openFileTab(node: FileNode): void;
  openFilePath(path: string): void;
  openOption(id: InspectorTabId): void;
  selectTab(id: InspectorTabId): void;
  closeTab(id: InspectorTabId): void;
  removePath(path: string): void;
} {
  const workspaceKey = workspacePath ?? "__no_workspace__";
  const [states, setStates] = useState<Record<string, WorkspaceInspectorState>>({});
  const state = states[workspaceKey] ?? EMPTY_WORKSPACE_INSPECTOR;
  const update = useCallback((change: (current: WorkspaceInspectorState) => WorkspaceInspectorState): void => {
    setStates((current) => updateWorkspaceInspectorState(current, workspaceKey, change));
  }, [workspaceKey]);
  const openTab = useCallback((tab: InspectorTabDefinition): void => {
    update((current) => openWorkspaceInspectorTab(current, tab));
  }, [update]);
  const openFilesTab = useCallback(() => openTab({ id: "files", kind: "files", label: "文件", icon: Files }), [openTab]);
  const openBrowserTab = useCallback(() => openTab({ id: "browser", kind: "browser", label: "浏览器", icon: Globe2 }), [openTab]);
  const openRuntimeTab = useCallback(() => openTab({ id: "runtime", kind: "runtime", label: "运行时", icon: BrainCircuit }), [openTab]);
  const openGitTab = useCallback(() => openTab({ id: "git", kind: "git", label: "Git", icon: GitBranch }), [openTab]);
  const openTerminalTab = useCallback((sessionId: string) => openTab({
    id: terminalInspectorTabId(sessionId),
    kind: "terminal",
    label: "终端",
    icon: Terminal,
    terminalId: sessionId,
  }), [openTab]);
  const openFileTab = useCallback((node: FileNode) => openTab({
    id: fileInspectorTabId(node.path),
    kind: "file",
    label: node.name,
    icon: FileText,
    path: node.path,
  }), [openTab]);
  const openFilePath = useCallback((path: string) => openFileTab({
    name: fileName(path),
    path,
    kind: "file",
  }), [openFileTab]);
  // 终端 is deliberately absent: a terminal tab is bound to a shell, and the
  // shell has to be spawned before the tab exists. Its caller opens it.
  const openOption = useCallback((id: InspectorTabId): void => {
    if (id === "files") openFilesTab();
    else if (id === "browser") openBrowserTab();
    else if (id === "runtime") openRuntimeTab();
    else if (id === "git") openGitTab();
  }, [openBrowserTab, openFilesTab, openGitTab, openRuntimeTab]);
  const activeTab = useMemo(
    () => state.tabs.find((item) => item.id === state.activeTabId),
    [state.activeTabId, state.tabs],
  );
  const setRightOpen = useCallback((open: boolean): void => {
    update((current) => ({ ...current, rightOpen: open }));
  }, [update]);
  const selectTab = useCallback((id: InspectorTabId): void => {
    update((current) => selectWorkspaceInspectorTab(current, id));
  }, [update]);
  const rebindTerminalTab = useCallback((tabId: InspectorTabId, sessionId: string): void => {
    update((current) => rebindWorkspaceTerminalTab(current, tabId, sessionId));
  }, [update]);
  const closeTab = useCallback((id: InspectorTabId): void => {
    update((current) => closeWorkspaceInspectorTab(current, id));
  }, [update]);
  const removePath = useCallback((path: string): void => {
    update((current) => removeWorkspaceInspectorPath(current, path));
  }, [update]);
  return {
    state,
    activeTab,
    setRightOpen,
    openFilesTab,
    openBrowserTab,
    openRuntimeTab,
    openGitTab,
    openTerminalTab,
    rebindTerminalTab,
    openFileTab,
    openFilePath,
    openOption,
    selectTab,
    closeTab,
    removePath,
  };
}
