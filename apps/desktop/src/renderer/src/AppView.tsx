import { PanelLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { isRemoteClient, MOBILE_DECK_QUERY } from "./hooks/useMobileRemote";

import type {
  ComponentProps,
  Dispatch,
  FormEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import type {
  ChatMessage,
  PlanApprovalState,
  PlanExecutionTarget,
  ProjectSelection,
  ProjectSnapshot,
  PromptImage,
  RuntimeConfiguration,
  SessionSnapshot,
  SessionSummary,
  SubagentActivity,
} from "@coilcoil/runtime-protocol";
import { useInAppBrowserLinks } from "./features/browser/useInAppBrowserLinks";
import { ConversationPane } from "./features/conversation/ConversationPane";
import { IssueBoard } from "./features/issues/IssueBoard";
import { requestIssueRun, useIssueBoard } from "./features/issues/useIssueBoard";
import { MemoryWorkspace } from "./features/memory/MemoryWorkspace";
import { SkillsWorkspace } from "./features/settings/SkillsWorkspace";
import { WorkspaceInspector } from "./features/inspector/WorkspaceInspector";
import { useWorkspaceInspector } from "./features/inspector/useWorkspaceInspector";
import {
  WorkspaceSidebar,
  type SessionActivityState,
} from "./features/workspaces/WorkspaceSidebar";
import type { useComposerController } from "./features/composer/useComposerController";
import type { usePanelLayout } from "./hooks/usePanelLayout";
import { toastError } from "./ui/toast";

type WorkspaceSurface = "conversation" | "skills" | "memory" | "issues";
type ConversationProps = ComponentProps<typeof ConversationPane>;


export interface AppViewController {
  projects: ProjectSelection[];
  project: ProjectSelection | null;
  activeConversation?: SessionSummary;
  pendingProjectPath?: string;
  sessionsByProject: Record<string, SessionSummary[]>;
  sessionActivity: Record<string, SessionActivityState>;
  expandedProjects: Set<string>;
  expandedSessionLimits: Record<string, number>;
  snapshot?: SessionSnapshot;
  leftOpen: boolean;
  leftWidth: number;
  rightOpen: boolean;
  rightWidth: number;
  workspaceSurface: WorkspaceSurface;
  loading: boolean;
  timeline: ConversationProps["timeline"];
  queuedPrompts: ChatMessage[];
  running: boolean;
  activityLine: string;
  projectState: ProjectSnapshot;
  subagents: SubagentActivity[];
  startingSession: boolean;
  configuration?: RuntimeConfiguration;
  selectedModel: ConversationProps["selectedModel"];
  fileDragActive: boolean;
  timelineRef: ConversationProps["timelineRef"];
  shouldAutoScrollRef: MutableRefObject<boolean>;
  composer: ReturnType<typeof useComposerController>;
  inspector: ReturnType<typeof useWorkspaceInspector>;
  setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
  setExpandedSessionLimits: Dispatch<SetStateAction<Record<string, number>>>;
  setSessionsByProject: Dispatch<SetStateAction<Record<string, SessionSummary[]>>>;
  setWorkspaceSurface: Dispatch<SetStateAction<WorkspaceSurface>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsSection: Dispatch<SetStateAction<"models" | "mcp" | "skills" | "appearance">>;
  setLeftOpen(open: boolean): void;
  beginResize: ReturnType<typeof usePanelLayout>["beginResize"];
  startNewConversation(owner?: ProjectSelection): void;
  openProject(): Promise<void>;
  removeProject(owner: ProjectSelection): void;
  openConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  archiveConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  renameConversation(owner: ProjectSelection, session: SessionSummary, name: string): Promise<void>;
  pinConversation(owner: ProjectSelection, session: SessionSummary, pinned: boolean): Promise<void>;
  forkConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  moveConversation(owner: ProjectSelection, session: SessionSummary, target: ProjectSelection): Promise<void>;
  reorderProjects(fromPath: string, toPath: string): void;
  rewindPrompt(message: ChatMessage, text: string, images: PromptImage[]): Promise<void>;
  cancelQueuedPrompt(id: string): Promise<void>;
  promoteQueuedPrompt(id: string): Promise<void>;
  abortRun(): Promise<void>;
  stopSubagent(activity: SubagentActivity): Promise<void>;
  resumeSubagent(activity: SubagentActivity): Promise<void>;
  approvePlan(planId: string, target: PlanExecutionTarget, agent?: string): Promise<PlanApprovalState>;
  rejectPlan(planId: string): Promise<PlanApprovalState>;
  submitPrompt(event?: FormEvent, intent?: "queue" | "steer", override?: string, overrideImages?: PromptImage[]): Promise<void>;
  handleTimelineScroll(): void;
  handleFileDragEnter: ConversationProps["onDragEnter"];
  handleFileDragOver: ConversationProps["onDragOver"];
  handleFileDragLeave: ConversationProps["onDragLeave"];
  handleFileDrop: ConversationProps["onDrop"];
}

export function AppView({ controller }: { controller: AppViewController }): React.JSX.Element {
  const {
    projects, project, activeConversation, pendingProjectPath, sessionsByProject,
    sessionActivity, expandedProjects, expandedSessionLimits, snapshot,
    leftOpen, leftWidth, rightOpen, rightWidth, workspaceSurface, loading,
    timeline, queuedPrompts, running, activityLine, projectState, subagents,
    startingSession, configuration, selectedModel, fileDragActive, timelineRef,
    shouldAutoScrollRef, composer, inspector, setExpandedProjects,
    setExpandedSessionLimits, setSessionsByProject, setWorkspaceSurface,
    setSettingsOpen, setSettingsSection, setLeftOpen, beginResize,
    startNewConversation, openProject, removeProject, openConversation,
    archiveConversation, renameConversation, pinConversation, forkConversation,
    moveConversation, reorderProjects,
    rewindPrompt, cancelQueuedPrompt, promoteQueuedPrompt, abortRun, stopSubagent, resumeSubagent,
    approvePlan, rejectPlan, submitPrompt, handleTimelineScroll,
    handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop,
  } = controller;
  const {
    draft, images: draftImages, inputRef, modelMenuOpen, modelChanging,
    setDraft, setImages: setDraftImages, setModelMenuOpen,
  } = composer;
  const shellRef = useRef<HTMLElement | null>(null);
  // On a phone the three panes are one horizontal snap track, and its natural
  // resting place is the first pane — the sidebar. The conversation is what the
  // app opens on, so the track starts one pane in, leaving the sidebar a swipe
  // to the left and the inspector a swipe to the right.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !isRemoteClient() || !window.matchMedia(MOBILE_DECK_QUERY).matches) return;
    const frame = window.requestAnimationFrame(() => {
      shell.scrollLeft = shell.clientWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  /* 任务面板。任务跑在后台自己的运行时里，和这一层的对话没有任何关系——它不新建
     对话、不发消息、也不看哪个对话跑完没有，所以这里只剩工作区路径这一个输入。 */
  const board = useIssueBoard({ cwd: project?.path, runIssue: requestIssueRun });

  useInAppBrowserLinks({
    scopeId: snapshot?.runtimeId ?? project?.path ?? "default",
    openBrowser: inspector.openBrowserTab,
    openFile: inspector.openFilePath,
    reportError: toastError,
  });

  return (
    <main
      ref={shellRef}
      className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`}
      style={{ "--sidebar-width": `${leftWidth}px`, "--inspector-width": `${rightWidth}px` } as React.CSSProperties}
    >
      <WorkspaceSidebar
        projects={projects}
        activeProject={project}
        activeSessionId={activeConversation?.id}
        pendingProjectPath={pendingProjectPath}
        sessionsByProject={sessionsByProject}
        sessionActivity={sessionActivity}
        expandedProjects={expandedProjects}
        expandedSessionLimits={expandedSessionLimits}
        modelLabel={snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.name}` : "本地 Agent"}
        onNewConversation={startNewConversation}
        onOpenProject={() => { void openProject(); }}
        onToggleProject={(path) => setExpandedProjects((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path); else next.add(path);
          return next;
        })}
        onShowMoreSessions={(path, limit) => setExpandedSessionLimits((current) => ({ ...current, [path]: limit }))}
        onOpenConversation={(owner, session) => { void openConversation(owner, session); }}
        onArchiveConversation={(owner, session) => { void archiveConversation(owner, session); }}
        onRenameConversation={renameConversation}
        onPinConversation={(owner, session, pinned) => { void pinConversation(owner, session, pinned); }}
        onForkConversation={(owner, session) => { void forkConversation(owner, session); }}
        onMoveConversation={(owner, session, target) => { void moveConversation(owner, session, target); }}
        onReorderProjects={reorderProjects}
        onRestoreSessions={(owner, sessions) => setSessionsByProject((current) => ({ ...current, [owner.path]: sessions }))}
        onFocusPending={() => {
          setWorkspaceSurface("conversation");
          window.requestAnimationFrame(() => inputRef.current?.focus());
        }}
        boardOpen={workspaceSurface === "issues"}
        onOpenBoard={(owner) => { setModelMenuOpen(false); setWorkspaceSurface("issues"); if (owner.path !== project?.path) startNewConversation(owner); }}
        skillsOpen={workspaceSurface === "skills"}
        onOpenSkills={() => { setModelMenuOpen(false); setWorkspaceSurface("skills"); }}
        memoryOpen={workspaceSurface === "memory"}
        onOpenMemory={() => { setModelMenuOpen(false); setWorkspaceSurface("memory"); }}
        onOpenSettings={() => { setSettingsSection("models"); setSettingsOpen(true); }}
        onRemoveProject={removeProject}
        onError={(message) => { if (message) toastError(message); }}
      />
      {leftOpen ? (
        <button className="sidebar-toggle" type="button" aria-label="收起侧栏" onClick={() => setLeftOpen(false)}>
          <span><PanelLeft size={17} /></span>
        </button>
      ) : null}
      {leftOpen ? <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("left", event)} /> : null}

      {workspaceSurface === "issues" ? (
        <IssueBoard
          workspaceName={project?.name}
          issues={board.issues}
          loading={board.loading}
          run={board.run}
          leftOpen={leftOpen}
          onOpenLeft={() => setLeftOpen(true)}
          onClose={() => { shouldAutoScrollRef.current = true; setWorkspaceSurface("conversation"); }}
          onChange={board.update}
          onStart={board.start}
          onStop={board.stop}
        />
      ) : workspaceSurface === "skills" ? (
        <SkillsWorkspace
          runtimeId={snapshot?.runtimeId}
          cwd={project?.path}
          leftOpen={leftOpen}
          onOpenLeft={() => setLeftOpen(true)}
          onClose={() => { shouldAutoScrollRef.current = true; setWorkspaceSurface("conversation"); }}
        />
      ) : workspaceSurface === "memory" ? (
        <MemoryWorkspace
          runtimeId={snapshot?.runtimeId}
          cwd={project?.path}
          leftOpen={leftOpen}
          onOpenLeft={() => setLeftOpen(true)}
          onClose={() => { shouldAutoScrollRef.current = true; setWorkspaceSurface("conversation"); }}
        />
      ) : (
        <>
          <ConversationPane
            fileDragActive={fileDragActive}
            leftOpen={leftOpen}
            rightOpen={rightOpen}
            pendingProjectPath={pendingProjectPath}
            activeConversation={activeConversation}
            project={project}
            loading={loading}
            timeline={timeline}
            queuedPrompts={queuedPrompts}
            onCancelQueuedPrompt={(id) => { void cancelQueuedPrompt(id); }}
            onPromoteQueuedPrompt={(id) => { void promoteQueuedPrompt(id); }}
            onStopSubagent={(activity) => { void stopSubagent(activity); }}
            onResumeSubagent={(activity) => { void resumeSubagent(activity); }}
            running={running}
            timelineRef={timelineRef}
            activityLine={activityLine}
            projectState={projectState}
            subagents={subagents}
            snapshot={snapshot}
            startingSession={startingSession}
            draft={draft}
            draftImages={draftImages}
            inputRef={inputRef}
            configuration={configuration}
            selectedModel={selectedModel}
            modelMenuOpen={modelMenuOpen}
            modelChanging={modelChanging}
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            onOpenLeft={() => setLeftOpen(true)}
            onOpenRight={() => inspector.setRightOpen(true)}
            onTimelineScroll={handleTimelineScroll}
            onRewind={rewindPrompt}
            onError={(message) => { if (message) toastError(message); }}
            onSubmit={(event) => { void submitPrompt(event); }}
            onDraftChange={setDraft}
            onImagesChange={setDraftImages}
            onPaste={composer.handlePaste}
            onCompositionStart={composer.handleCompositionStart}
            onCompositionEnd={composer.handleCompositionEnd}
            onKeyDown={composer.handleKeyDown}
            onModelMenuOpenChange={setModelMenuOpen}
            onSelectModel={(model) => { void composer.selectModel(model); }}
            onConfigureModelOptions={composer.configureModelOptions}
            onFastChange={composer.setFast}
            onOpenSettings={(section) => {
              setModelMenuOpen(false);
              setSettingsSection(section ?? "models");
              setSettingsOpen(true);
            }}
            onAbort={() => { void abortRun(); }}
            onStopGoal={() => { void window.coilcoil.request({ type: "stop_goal" }, snapshot?.runtimeId); }}
            onApprovePlan={approvePlan}
            onRejectPlan={rejectPlan}
          />
          <WorkspaceInspector
            tabs={inspector.state.tabs}
            activeTab={inspector.activeTab}
            activeTabId={inspector.state.activeTabId}
            selectedFilePath={inspector.state.selectedFilePath}
            rightOpen={rightOpen}
            projectPath={project?.path}
            projectState={projectState}
            snapshot={snapshot}
            configuration={configuration}
            onOpenFiles={inspector.openFilesTab}
            onOpenBrowser={inspector.openBrowserTab}
            onOpenRuntime={inspector.openRuntimeTab}
            onOpenTerminal={inspector.openTerminalTab}
            onRebindTerminal={inspector.rebindTerminalTab}
            onOpenFile={inspector.openFileTab}
            onSelectTab={inspector.selectTab}
            onCloseTab={inspector.closeTab}
            onRemovePath={inspector.removePath}
            onOpenOption={inspector.openOption}
            onClose={() => inspector.setRightOpen(false)}
          />
          {rightOpen ? <div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("right", event)} /> : null}
        </>
      )}
    </main>
  );
}
