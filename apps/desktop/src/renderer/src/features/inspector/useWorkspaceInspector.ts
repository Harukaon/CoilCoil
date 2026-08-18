import { BrainCircuit, Files, FileText, Globe2, Terminal } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { FileNode } from "@suocode/runtime-protocol";
import type { LucideIcon } from "lucide-react";

export type InspectorTabKind = "files" | "browser" | "runtime" | "terminal" | "file";
export type InspectorTabId = string;

export interface InspectorTabDefinition {
  id: InspectorTabId;
  kind: InspectorTabKind;
  label: string;
  icon: LucideIcon;
  path?: string;
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
  };
}

export function useWorkspaceInspector(workspacePath?: string): {
  state: WorkspaceInspectorState;
  activeTab?: InspectorTabDefinition;
  setRightOpen(open: boolean): void;
  openFilesTab(): void;
  openBrowserTab(): void;
  openRuntimeTab(): void;
  openTerminalTab(): void;
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
  const openTerminalTab = useCallback(() => openTab({ id: "terminal", kind: "terminal", label: "终端", icon: Terminal }), [openTab]);
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
  const openOption = useCallback((id: InspectorTabId): void => {
    if (id === "files") openFilesTab();
    else if (id === "browser") openBrowserTab();
    else if (id === "runtime") openRuntimeTab();
    else if (id === "terminal") openTerminalTab();
  }, [openBrowserTab, openFilesTab, openRuntimeTab, openTerminalTab]);
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
    openTerminalTab,
    openFileTab,
    openFilePath,
    openOption,
    selectTab,
    closeTab,
    removePath,
  };
}
