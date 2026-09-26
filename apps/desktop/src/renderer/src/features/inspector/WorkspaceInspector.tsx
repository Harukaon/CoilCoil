import { Bot, BrainCircuit, Files, GitBranch, Globe2, LoaderCircle, Terminal } from "lucide-react";
import { useCallback } from "react";
import type { ProjectSnapshot, RuntimeConfiguration, SessionSnapshot } from "@coilcoil/runtime-protocol";
import type { BrowserElementSelection } from "../../../../shared/desktop-api";
import { BrowserPanel } from "../browser/BrowserPanel";
import { browserScopeId, useBrowserTabs } from "../browser/useBrowserTabs";
import { FilesPanel } from "../files/FilesPanel";
import { GitPanel } from "../git/GitPanel";
import { RuntimePanel } from "../runtime/RuntimePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { openTerminalSession } from "../terminal/terminalSessions";
import { toastError } from "../../ui/toast";
import { InspectorPane, type InspectorTab } from "./InspectorPane";
import {
  activeBrowserPaneTabId,
  browserPaneTabs,
  browserTabIdFromPaneId,
  shouldCloseBrowserEntry,
} from "./inspectorTabs";
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
  onBrowserElementPicked(selection: BrowserElementSelection): void;
  addControlTarget: HTMLElement | null;
  showAddControl: boolean;
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
  onBrowserElementPicked,
  addControlTarget,
  showAddControl,
}: WorkspaceInspectorProps): React.JSX.Element {
  const filesVisible = activeTab?.kind === "files" || activeTab?.kind === "file";
  const hasFiles = tabs.some((item) => item.kind === "files" || item.kind === "file");
  const hasRuntime = tabs.some((item) => item.kind === "runtime");
  const hasBrowser = tabs.some((item) => item.kind === "browser");
  const hasGit = tabs.some((item) => item.kind === "git");
  const terminalTabs = tabs.filter((item) => item.kind === "terminal");
  // 浏览器的网页标签由主进程按 scope 拥有，agent 也会开关它们，所以这份列表订阅
  // 主进程而不是存在右侧栏状态里；tabs 里那条 browser 记录只表示「开着浏览器」。
  // 浏览器按会话分：一个会话一批标签页，换会话就换一批，页面不会在会话之间窜。
  // cookie 仍按工作区分（workspacePath）。取会话 id 而不是 runtimeId：同一个会话
  // 重新打开会换运行时，标签页不能因此丢。还没有会话时先落在工作区这一份上。
  const scopeId = browserScopeId(snapshot, projectPath);
  const browser = useBrowserTabs({ scopeId, workspacePath: projectPath, open: hasBrowser });
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
  /** 新开一个网页标签；浏览器还没开的时候先把它放进右侧栏，第一个标签由 hook 补建。 */
  const openBrowserPage = useCallback((): void => {
    if (!hasBrowser) {
      onOpenBrowser();
      return;
    }
    onSelectTab("browser");
    void window.coilcoil.createBrowserTab(scopeId).then(browser.setState).catch((error: unknown) => {
      toastError(error instanceof Error ? error.message : String(error));
    });
  }, [browser.setState, hasBrowser, onOpenBrowser, onSelectTab, scopeId]);
  // 标签条上的 id 不等于右侧栏状态里的 id：网页标签是 `browser:<主进程 tab id>`。
  const selectPaneTab = useCallback((id: string): void => {
    const pageId = browserTabIdFromPaneId(id);
    if (!pageId) {
      onSelectTab(id);
      return;
    }
    onSelectTab("browser");
    void window.coilcoil.selectBrowserTab(scopeId, pageId).then(browser.setState).catch((error: unknown) => {
      toastError(error instanceof Error ? error.message : String(error));
    });
  }, [browser.setState, onSelectTab, scopeId]);
  // 关掉最后一个网页标签，浏览器这一项也就从右侧栏消失——和关掉最后一个终端一样。
  const closePaneTab = useCallback((id: string): void => {
    const pageId = browserTabIdFromPaneId(id);
    if (!pageId) {
      closeTab(id);
      return;
    }
    void window.coilcoil.closeBrowserTab(scopeId, pageId).then((next) => {
      browser.setState(next);
      if (shouldCloseBrowserEntry(next)) onCloseTab("browser");
    }).catch((error: unknown) => {
      toastError(error instanceof Error ? error.message : String(error));
    });
  }, [browser.setState, closeTab, onCloseTab, scopeId]);
  // 标签条上真正画出来的那一排：浏览器那一条摊成每个网页一个标签，其余原样。
  const paneTabs: InspectorTab<InspectorTabId>[] = tabs.flatMap((item) => item.kind === "browser"
    ? browserPaneTabs(browser.state).map((page) => ({
      id: page.id,
      label: page.label,
      // Agent 开的换成 Agent 图标：同一排标签里一眼分得出哪几张是 Agent 开的、哪几张是
      // 自己开的。哪一张两边都能直接用。
      icon: page.loading ? LoaderCircle : page.agent || page.foreign ? Bot : Globe2,
      hint: page.agent ? `${page.label}（Agent 开的）` : undefined,
      spinning: page.loading,
      closable: true,
    }))
    : [{
      id: item.id,
      label: item.kind === "terminal" ? terminalTabLabel(terminalTabs.indexOf(item)) : item.label,
      icon: item.icon,
      closable: true,
    }]);
  const addOptions = [
    { id: "files", label: "文件", icon: Files, disabled: tabs.some((item) => item.kind === "files") },
    // 浏览器和终端一样不置灰：再点一次就是多开一个网页标签。
    { id: "browser", label: "浏览器", icon: Globe2 },
    { id: "runtime", label: "运行时", icon: BrainCircuit, disabled: hasRuntime },
    { id: "git", label: "Git", icon: GitBranch, disabled: hasGit },
    // Never disabled: picking it again is how a second shell is opened.
    { id: "terminal", label: "终端", icon: Terminal },
  ];
  return (
    <InspectorPane
      tabs={paneTabs}
      activeTab={activeTab?.kind === "browser" ? activeBrowserPaneTabId(browser.state) : activeTabId ?? ""}
      onSelectTab={selectPaneTab}
      onCloseTab={closePaneTab}
      addControlTarget={addControlTarget}
      showAddControl={showAddControl}
      addOptions={addOptions}
      onAddTab={(id) => {
        if (id === "terminal") void openTerminal();
        else if (id === "browser") openBrowserPage();
        else onOpenOption(id);
      }}
      emptyState={(
        <>
          <div className="inspector-empty-icon"><Files size={18} strokeWidth={1.7} /></div>
          <strong>打开一个面板</strong>
          <p>选择文件、浏览器、运行时、Git 或终端，内容会按工作区独立保留。</p>
          <div className="inspector-empty-actions">
            <button type="button" onClick={onOpenFiles}><Files size={14} />文件</button>
            <button type="button" onClick={openBrowserPage}><Globe2 size={14} />浏览器</button>
            <button type="button" onClick={onOpenRuntime}><BrainCircuit size={14} />运行时</button>
            <button type="button" onClick={() => onOpenOption("git")}><GitBranch size={14} />Git</button>
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
      {hasGit ? (
        <div className={`inspector-tab-panel git-tab-panel ${activeTab?.kind === "git" ? "active" : ""}`}>
          <GitPanel cwd={projectState.cwd || projectPath} active={rightOpen && activeTab?.kind === "git"} />
        </div>
      ) : null}
      {hasBrowser ? (
        <div className={`inspector-tab-panel browser-tab-panel ${activeTab?.kind === "browser" ? "active" : ""}`}>
          <BrowserPanel
            active={rightOpen && activeTab?.kind === "browser"}
            scopeId={scopeId}
            state={browser.state}
            onState={browser.setState}
            onElementPicked={onBrowserElementPicked}
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
