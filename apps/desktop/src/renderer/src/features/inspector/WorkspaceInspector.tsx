import { BrainCircuit, Files, Globe2, Terminal } from "lucide-react";
import { useCallback } from "react";
import type { ProjectSnapshot, RuntimeConfiguration, SessionSnapshot } from "@coilcoil/runtime-protocol";
import { BrowserPanel } from "../browser/BrowserPanel";
import { FilesPanel } from "../files/FilesPanel";
import { RuntimePanel } from "../runtime/RuntimePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { openTerminalSession } from "../terminal/terminalSessions";
import { toastError } from "../../ui/toast";
import { InspectorPane } from "./InspectorPane";
import {
  fileInspectorTabId,
  type InspectorTabDefinition,
  type InspectorTabId,
} from "./useWorkspaceInspector";

const TERMINAL_ORDINALS = ["", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/**
 * Name a terminal tab by its place in the strip.
 *
 * The label is derived rather than stored so closing 终端 renames 终端二 to
 * 终端 instead of leaving a row that counts 终端二, 终端三 with no 终端.
 */
function terminalTabLabel(index: number): string {
  return `终端${TERMINAL_ORDINALS[index] ?? index + 1}`;
}

export interface WorkspaceInspectorProps {
  tabs: InspectorTabDefinition[];
  activeTab?: InspectorTabDefinition;
  activeTabId?: InspectorTabId;
  selectedFilePath?: string;
  rightOpen: boolean;
  projectPath?: string;
  projectState: ProjectSnapshot;
  snapshot?: SessionSnapshot;
  configuration?: RuntimeConfiguration;
  onOpenFiles(): void;
  onOpenBrowser(): void;
  onOpenRuntime(): void;
  onOpenTerminal(sessionId: string): void;
  onRebindTerminal(tabId: InspectorTabId, sessionId: string): void;
  onOpenFile: Parameters<typeof FilesPanel>[0]["onOpenFile"];
  onSelectTab(id: InspectorTabId): void;
  onCloseTab(id: InspectorTabId): void;
  onRemovePath(path: string): void;
  onOpenOption(id: InspectorTabId): void;
  onClose(): void;
}

export function WorkspaceInspector({
  tabs,
  activeTab,
  activeTabId,
  selectedFilePath,
  rightOpen,
  projectPath,
  projectState,
  snapshot,
  configuration,
  onOpenFiles,
  onOpenBrowser,
  onOpenRuntime,
  onOpenTerminal,
  onRebindTerminal,
  onOpenFile,
  onSelectTab,
  onCloseTab,
  onRemovePath,
  onOpenOption,
  onClose,
}: WorkspaceInspectorProps): React.JSX.Element {
  const filesVisible = activeTab?.kind === "files" || activeTab?.kind === "file";
  const hasFiles = tabs.some((item) => item.kind === "files" || item.kind === "file");
  const hasRuntime = tabs.some((item) => item.kind === "runtime");
  const hasBrowser = tabs.some((item) => item.kind === "browser");
  const terminalTabs = tabs.filter((item) => item.kind === "terminal");
  const openTerminal = useCallback(async (): Promise<void> => {
    try {
      const opened = await openTerminalSession(projectState.cwd);
      if (opened) onOpenTerminal(opened);
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    }
  }, [onOpenTerminal, projectState.cwd]);
  // Closing the tab is the only way a shell leaves the strip, so it has to be
  // the thing that kills it — a tab dropped on its own would leave a pty
  // running with nothing on screen able to reach it.
  const closeTab = useCallback((id: InspectorTabId): void => {
    const terminalId = tabs.find((item) => item.id === id)?.terminalId;
    if (terminalId) {
      void window.coilcoil.closeTerminal(terminalId).catch((error: unknown) => {
        toastError(error instanceof Error ? error.message : String(error));
      });
    }
    onCloseTab(id);
  }, [onCloseTab, tabs]);
  const addOptions = [
    { id: "files", label: "文件", icon: Files, disabled: tabs.some((item) => item.kind === "files") },
    { id: "browser", label: "浏览器", icon: Globe2, disabled: hasBrowser },
    { id: "runtime", label: "运行时", icon: BrainCircuit, disabled: hasRuntime },
    // Never disabled: picking it again is how a second shell is opened.
    { id: "terminal", label: "终端", icon: Terminal },
  ];
  return (
    <InspectorPane
      tabs={tabs.map((item) => ({
        ...item,
        label: item.kind === "terminal" ? terminalTabLabel(terminalTabs.indexOf(item)) : item.label,
        closable: true,
      }))}
      activeTab={activeTabId ?? ""}
      onSelectTab={onSelectTab}
      onCloseTab={closeTab}
      onClose={onClose}
      addOptions={addOptions}
      onAddTab={(id) => { if (id === "terminal") void openTerminal(); else onOpenOption(id); }}
      emptyState={(
        <>
          <div className="inspector-empty-icon"><Files size={18} strokeWidth={1.7} /></div>
          <strong>打开一个面板</strong>
          <p>选择文件、浏览器、运行时或终端，内容会按工作区独立保留。</p>
          <div className="inspector-empty-actions">
            <button type="button" onClick={onOpenFiles}><Files size={14} />文件</button>
            <button type="button" onClick={onOpenBrowser}><Globe2 size={14} />浏览器</button>
            <button type="button" onClick={onOpenRuntime}><BrainCircuit size={14} />运行时</button>
            <button type="button" onClick={() => void openTerminal()}><Terminal size={14} />终端</button>
          </div>
        </>
      )}
    >
      {hasFiles ? (
        <div className={`inspector-tab-panel files-tab-panel ${filesVisible ? "active" : ""}`}>
          <FilesPanel
            key={`agent-files:${projectState.cwd}`}
            project={projectState}
            runtimeId={snapshot?.runtimeId}
            activeFilePath={selectedFilePath}
            onOpenFile={onOpenFile}
            onCloseFile={(path) => onCloseTab(fileInspectorTabId(path))}
            onRemovePath={onRemovePath}
          />
        </div>
      ) : null}
      {hasRuntime ? (
        <div className={`inspector-tab-panel runtime-tab-panel ${activeTab?.kind === "runtime" ? "active" : ""}`}>
          <RuntimePanel
            inspection={snapshot?.runtimeInspection}
            contextUsage={snapshot?.contextUsage}
            tokenUsage={snapshot?.tokenUsage}
            runtimeId={snapshot?.runtimeId}
            cwd={projectPath}
            configuration={configuration}
          />
        </div>
      ) : null}
      {hasBrowser ? (
        <div className={`inspector-tab-panel browser-tab-panel ${activeTab?.kind === "browser" ? "active" : ""}`}>
          <BrowserPanel
            active={rightOpen && activeTab?.kind === "browser"}
            scopeId={snapshot?.runtimeId ?? projectPath ?? "default"}
          />
        </div>
      ) : null}
      {/* Every shell stays mounted so switching tabs keeps its xterm buffer. */}
      {terminalTabs.map((tab) => (
        <div className={`inspector-tab-panel terminal-tab-panel ${activeTabId === tab.id ? "active" : ""}`} key={tab.id}>
          <TerminalPanel
            sessionId={tab.terminalId ?? ""}
            cwd={projectState.cwd}
            active={rightOpen && activeTabId === tab.id}
            onSessionOpened={(sessionId) => onRebindTerminal(tab.id, sessionId)}
          />
        </div>
      ))}
    </InspectorPane>
  );
}
