import { BrainCircuit, Files, Globe2, Terminal } from "lucide-react";
import type { ProjectSnapshot, SessionSnapshot } from "@suocode/runtime-protocol";
import { BrowserPanel } from "../browser/BrowserPanel";
import { FilesPanel } from "../files/FilesPanel";
import { RuntimePanel } from "../runtime/RuntimePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { InspectorPane } from "./InspectorPane";
import {
  fileInspectorTabId,
  type InspectorTabDefinition,
  type InspectorTabId,
} from "./useWorkspaceInspector";

export interface WorkspaceInspectorProps {
  tabs: InspectorTabDefinition[];
  activeTab?: InspectorTabDefinition;
  activeTabId?: InspectorTabId;
  selectedFilePath?: string;
  rightOpen: boolean;
  projectPath?: string;
  projectState: ProjectSnapshot;
  snapshot?: SessionSnapshot;
  onOpenFiles(): void;
  onOpenBrowser(): void;
  onOpenRuntime(): void;
  onOpenTerminal(): void;
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
  onOpenFiles,
  onOpenBrowser,
  onOpenRuntime,
  onOpenTerminal,
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
  const hasTerminal = tabs.some((item) => item.kind === "terminal");
  const addOptions = [
    { id: "files", label: "文件", icon: Files, disabled: tabs.some((item) => item.kind === "files") },
    { id: "browser", label: "浏览器", icon: Globe2, disabled: hasBrowser },
    { id: "runtime", label: "运行时", icon: BrainCircuit, disabled: hasRuntime },
    { id: "terminal", label: "终端", icon: Terminal, disabled: hasTerminal },
  ];
  return (
    <InspectorPane
      tabs={tabs.map((item) => ({ ...item, closable: true }))}
      activeTab={activeTabId ?? ""}
      onSelectTab={onSelectTab}
      onCloseTab={onCloseTab}
      onClose={onClose}
      addOptions={addOptions}
      onAddTab={onOpenOption}
      emptyState={(
        <>
          <div className="inspector-empty-icon"><Files size={18} strokeWidth={1.7} /></div>
          <strong>打开一个面板</strong>
          <p>选择文件、浏览器、运行时或终端，内容会按工作区独立保留。</p>
          <div className="inspector-empty-actions">
            <button type="button" onClick={onOpenFiles}><Files size={14} />文件</button>
            <button type="button" onClick={onOpenBrowser}><Globe2 size={14} />浏览器</button>
            <button type="button" onClick={onOpenRuntime}><BrainCircuit size={14} />运行时</button>
            <button type="button" onClick={onOpenTerminal}><Terminal size={14} />终端</button>
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
      {hasTerminal ? (
        <div className={`inspector-tab-panel terminal-tab-panel ${activeTab?.kind === "terminal" ? "active" : ""}`}>
          <TerminalPanel cwd={projectState.cwd} active={rightOpen && activeTab?.kind === "terminal"} />
        </div>
      ) : null}
    </InspectorPane>
  );
}
