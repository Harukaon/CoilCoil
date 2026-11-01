import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentMode,
  ChatMessage,
  MoveSessionResult,
  PlanApprovalState,
  PlanExecutionTarget,
  ProjectSelection,
  ProjectSnapshot,
  PromptDocument,
  RuntimeBootstrap,
  RuntimeConfiguration,
  PromptImage,
  SessionSnapshot,
  SessionSummary,
  SubagentActivity,
  WorkspaceSnapshot,
  ToolRun,
} from "@coilcoil/runtime-protocol";
import { SESSION_OPEN_SUPERSEDED_ERROR } from "@coilcoil/runtime-protocol";
import { createPromptSubmissionHandler } from "./features/conversation/submitConversationPrompt";
import { SessionRestoreController } from "./features/conversation/sessionRestore";
import { buildConversationTimeline } from "./features/conversation/buildConversationTimeline";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { AppView } from "./AppView";
import {
  conversationMessagesReducer,
  EMPTY_CONVERSATION_MESSAGES,
  selectConversationMessages,
  selectQueuedPrompts,
} from "./features/conversation/conversationMessages";
import { useBubbleHandoff } from "./hooks/useBubbleHandoff";
import type { SessionActivityState } from "./features/workspaces/WorkspaceSidebar";
import { upsertSessionSummary } from "./features/workspaces/sessionList";
import { useDockBadge } from "./features/workspaces/useDockBadge";
import { useSessionControls } from "./hooks/useSessionControls";
import { useConversationActions } from "./features/workspaces/useConversationActions";
import { useWorkspaceInspector } from "./features/inspector/useWorkspaceInspector";
import { useComposerController } from "./features/composer/useComposerController";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { diagnostics } from "./diagnostics";
import { useBufferedRuntimeEvents } from "./hooks/useBufferedRuntimeEvents";
import { useRuntimeEventHandler } from "./hooks/useRuntimeEventHandler";
import { useAgentActivityLine } from "./hooks/useAgentActivityLine";
import { useConversationViewport } from "./hooks/useConversationViewport";
import { useFilePathDrop } from "./hooks/useFilePathDrop";
import { toastError } from "./ui/toast";
import { rendererPlatform } from "./platform";
import type { AgentPhase } from "./features/conversation/agentActivity";
import {
  ACTIVE_PROJECT_STORAGE_KEY,
  EMPTY_PROJECT,
  loadOnboarding,
  loadStoredProjects,
  saveMountedProjects,
  uniqueProjects,
} from "./appState";
import { OnboardingScreen } from "./features/onboarding/OnboardingScreen";
import { useOnboarding } from "./features/onboarding/useOnboarding";

type WorkspaceSurface = "conversation" | "skills" | "memory";

export default function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSelection[]>([]);
  const [project, setProject] = useState<ProjectSelection | null>(null);
  const projectRef = useRef<ProjectSelection | null>(project);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, SessionSummary[]>>({});
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [conversationMessages, dispatchConversationMessages] = useReducer(
    conversationMessagesReducer,
    EMPTY_CONVERSATION_MESSAGES,
  );
  const messages = useMemo(() => selectConversationMessages(conversationMessages), [conversationMessages]);
  const queuedPrompts = useMemo(() => selectQueuedPrompts(conversationMessages), [conversationMessages]);
  // The composer is created before the send helpers exist; refs keep its
  // keyboard handler pointed at the current queue and promotion helper.
  const queuedPromptsRef = useRef(queuedPrompts);
  queuedPromptsRef.current = queuedPrompts;
  const promoteQueuedPromptRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [subagents, setSubagents] = useState<SubagentActivity[]>([]);
  const [projectState, setProjectState] = useState<ProjectSnapshot>(EMPTY_PROJECT);
  const [configuration, setConfiguration] = useState<RuntimeConfiguration>();
  const inspector = useWorkspaceInspector(project?.path);
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivityState>>({});
  const [pendingProjectPath, setPendingProjectPath] = useState<string>();
  const [pendingAgentMode, setPendingAgentMode] = useState<AgentMode>("standard");
  const [expandedSessionLimits, setExpandedSessionLimits] = useState<Record<string, number>>({});
  const [startingSession, setStartingSession] = useState(false);
  const [restoringSession, setRestoringSession] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const { leftOpen, leftWidth, rightWidth, setLeftOpen, beginResize } = usePanelLayout({
    rightOpen: inspector.state.rightOpen,
    onRightOpenChange: inspector.setRightOpen,
  });
  const rightOpen = inspector.state.rightOpen;

  const [agentPhase, setAgentPhase] = useState<AgentPhase>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 没走过引导就先走引导。它在的时候工作区一概不渲染。
  const onboarding = useOnboarding();
  const [settingsSection, setSettingsSection] = useState<"models" | "mcp" | "skills" | "appearance">("models");
  const [workspaceSurface, setWorkspaceSurface] = useState<WorkspaceSurface>("conversation");
  const [loading, setLoading] = useState(true);
  const composerSessionKey = snapshot?.session.path
    ?? (pendingProjectPath ? `pending:${pendingProjectPath}` : project?.path ? `pending:${project.path}` : "pending:empty");
  const composer = useComposerController({
    sessionKey: composerSessionKey,
    configuration,
    runtimeId: snapshot?.runtimeId,
    sessionThinkingLevel: snapshot?.pendingModel?.thinkingLevel ?? snapshot?.thinkingLevel ?? configuration?.thinkingLevel,
    onConfigurationChange: setConfiguration,
    // Enter queues; a second Enter on the now-empty composer interjects that
    // message into the running turn instead of waiting for it to finish.
    onEmptyEnter: () => {
      const latest = queuedPromptsRef.current.at(-1);
      if (!latest) return false;
      void promoteQueuedPromptRef.current(latest.id);
      return true;
    },
    onError: (message) => { if (message) toastError(message); },
  });
  const {
    draft,
    document: draftDocument,
    images: draftImages,
    inputRef,
    modelMenuOpen,
    modelChanging,
    restoreDraft,
    restoreDocument,
    restoreSubmission,
    setModelMenuOpen,
    reset: resetComposer,
    focus: focusComposer,
    insertPaths: insertComposerPaths,
  } = composer;
  const timelineRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const snapshotRef = useRef<SessionSnapshot | undefined>(undefined);
  const snapshotCacheRef = useRef(new Map<string, SessionSnapshot>());
  const runtimeSessionRef = useRef(new Map<string, string>());
  const optimisticSessionsRef = useRef(new Map<string, SessionSummary>());
  const selectionRequestRef = useRef(0);
  const sessionRestoreRef = useRef<SessionRestoreController>(undefined);
  useEffect(() => window.coilcoil.onBrowserAgentActivated((scopeId) => {
    if (scopeId !== snapshotRef.current?.session.id) return; // 浏览器作用域就是会话 id
    inspector.openBrowserTab();
  }), [inspector.openBrowserTab]);
  const { fileDragActive, handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop } = useFilePathDrop({
    onInsertPaths: insertComposerPaths,
    onError: (message) => { if (message) toastError(message); },
  });

  const applySnapshot = useCallback((next: SessionSnapshot): void => {
    // The transcript is replaced wholesale here, so a message that appears,
    // disappears, or arrives in the wrong order is either this or the reducer.
    diagnostics.info("snapshot", "snapshot_applied", {
      sessionPath: next.session.path,
      revision: next.messageRevision,
      messages: next.messages.length,
      queued: next.promptQueue?.length ?? 0,
      running: next.running,
      aborting: next.aborting,
    });
    snapshotRef.current = next;
    if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
    if (next.runtimeId && next.session.path) runtimeSessionRef.current.set(next.runtimeId, next.session.path);
    setSnapshot(next);
    dispatchConversationMessages({
      type: "snapshot",
      sessionPath: next.session.path,
      messages: next.messages,
      promptQueue: next.promptQueue, steering: next.steering,
      revision: next.messageRevision ?? 0, runtimeId: next.runtimeId,
    });
    setTools(next.tools);
    setSubagents(next.subagents);
    setProjectState(next.project);
    if (next.session.path) {
      setSessionActivity((current) => ({
        ...current,
        [next.session.path]: { runtimeId: next.runtimeId, running: next.running, unread: false },
      }));
    }
  }, []);

  const startPendingConversation = useCallback((selection: ProjectSelection): void => {
    sessionRestoreRef.current?.cancel();
    setRestoringSession(false);
    selectionRequestRef.current += 1;
    projectRef.current = selection;
    setProject(selection);
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, selection.path);
    setExpandedProjects((current) => new Set(current).add(selection.path));
    setPendingProjectPath(selection.path);
    setWorkspaceSurface("conversation");
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    dispatchConversationMessages({ type: "reset" });
    setTools([]);
    setSubagents([]);
    setProjectState({ ...EMPTY_PROJECT, cwd: selection.path });
    setPendingAgentMode("standard");
    resetComposer();
    setLoading(false);
    shouldAutoScrollRef.current = true;
    focusComposer();
  }, [focusComposer, resetComposer]);

  const applyRuntimeEvent = useRuntimeEventHandler({
    snapshotRef,
    snapshotCacheRef,
    runtimeSessionRef,
    optimisticSessionsRef,
    applySnapshot,
    dispatchConversationMessages,
    restoreDraft,
    restoreDocument,
    setSnapshot,
    setSessionActivity,
    setConfiguration,
    setSessionsByProject,
    setAgentPhase,
    setTools,
    setProjectState,
    setSubagents,
  });
  // Streaming arrives token by token; applying it token by token is what used to
  // starve the renderer in long conversations. See useBufferedRuntimeEvents.
  const runtimeEventHandlerRef = useRef(applyRuntimeEvent);
  runtimeEventHandlerRef.current = applyRuntimeEvent;
  sessionRestoreRef.current ??= new SessionRestoreController(
    ({ event, runtimeId, deltaParts }) => runtimeEventHandlerRef.current(event, runtimeId, deltaParts),
    (runtimeId) => runtimeSessionRef.current.get(runtimeId),
  );
  const handleRuntimeEvent = useBufferedRuntimeEvents(useCallback((event, runtimeId, deltaParts) => {
    sessionRestoreRef.current!.handle({ event, runtimeId, deltaParts });
  }, []));

  const activateProject = useCallback(async (selection: ProjectSelection): Promise<void> => {
    sessionRestoreRef.current?.cancel();
    setRestoringSession(false);
    const requestId = ++selectionRequestRef.current;
    projectRef.current = selection;
    setProject(selection);
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, selection.path);
    setExpandedProjects((current) => new Set(current).add(selection.path));
    setPendingProjectPath(undefined);
    setLoading(true);
    setPendingProjectPath(undefined);
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    dispatchConversationMessages({ type: "reset" });
    setTools([]);
    setSubagents([]);
    setProjectState({ ...EMPTY_PROJECT, cwd: selection.path });
    try {
      const { sessions, snapshot } = await window.coilcoil.request<WorkspaceSnapshot>({ type: "open_workspace", cwd: selection.path });
      if (requestId !== selectionRequestRef.current) return;
      setSessionsByProject((current) => ({ ...current, [selection.path]: sessions }));
      if (snapshot) {
        applySnapshot(snapshot);
      } else {
        // Keep the project open with a blank composer. The first prompt will
        // create a session; restoring a workspace must not pick a pinned tab.
        setPendingProjectPath(selection.path);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (requestId === selectionRequestRef.current && message !== SESSION_OPEN_SUPERSEDED_ERROR) toastError(message);
    } finally {
      if (requestId === selectionRequestRef.current) {
        setLoading(false);
        focusComposer();
      }
    }
  }, [applySnapshot, focusComposer]);

  useEffect(() => {
    document.documentElement.dataset.platform = rendererPlatform();
    const unsubscribe = window.coilcoil.onRuntimeEvent(handleRuntimeEvent);
    void (async () => {
      try {
        const bootstrapPromise = window.coilcoil.request<RuntimeBootstrap>({ type: "bootstrap" }).then((bootstrap) => {
          setConfiguration(bootstrap.configuration);
          return bootstrap;
        });
        const home = await window.coilcoil.homeProject();
        const mounted = uniqueProjects([home, ...loadStoredProjects()]);
        setProjects(mounted);
        const activePath = window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
        const activeProject = mounted.find((item) => item.path === activePath) ?? home;
        setExpandedProjects(new Set([activeProject.path]));
        const backgroundProjects = mounted.filter((item) => item.path !== activeProject.path);
        void Promise.allSettled(backgroundProjects.map(async (item) => {
          const listed = await window.coilcoil.request<SessionSummary[]>({ type: "list_sessions", cwd: item.path });
          setSessionsByProject((current) => ({ ...current, [item.path]: listed }));
        }));
        const [bootstrap] = await Promise.all([bootstrapPromise, activateProject(activeProject)]);
        // 一个模型都没配就直接把设置推到脸上——这是引导出现之前的老做法。引导自己
        // 有配置模型那一步，正在走引导的时候不要抢。
        if (!bootstrap.configuration.configuredProviders.length && loadOnboarding() !== undefined) setSettingsOpen(true);
      } catch (caught) {
        toastError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      }
    })();
    return () => { unsubscribe(); sessionRestoreRef.current?.cancel(false); };
  }, [activateProject, handleRuntimeEvent]);

  const activityLine = useAgentActivityLine(snapshot?.running ?? false, agentPhase);
  const { handleTimelineScroll } = useConversationViewport({
    timelineRef,
    shouldAutoScrollRef,
    messages,
    tools,
    running: snapshot?.running ?? false,
    settingsOpen,
    conversationVisible: workspaceSurface === "conversation",
    conversationKey: snapshot?.session.path ?? pendingProjectPath ?? project?.path,
    loading,
  });

  useEffect(() => {
    const runtimeId = snapshot?.runtimeId;
    if (settingsOpen || workspaceSurface !== "conversation" || inspector.state.activeTabId !== "runtime" || !runtimeId) return;
    let cancelled = false;
    void window.coilcoil.request<SessionSnapshot["runtimeInspection"]>({ type: "get_runtime_inspection" }, runtimeId)
      .then((inspection) => {
        if (cancelled) return;
        setSnapshot((current) => {
          if (!current || current.runtimeId !== runtimeId) return current;
          const next = { ...current, runtimeInspection: inspection };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
      })
      .catch((caught) => {
        if (!cancelled) toastError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => { cancelled = true; };
  }, [inspector.state.activeTabId, settingsOpen, snapshot?.runtimeId, workspaceSurface]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (projectRef.current) void startNewConversation();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  useDockBadge(sessionActivity);

  const activeConversation = snapshot?.session;
  const running = snapshot?.running ?? false;
  const sessionModel = snapshot?.pendingModel ?? snapshot?.model;
  const selectedModel = configuration?.models.find((model) => sessionModel
    ? model.provider === sessionModel.provider && model.id === sessionModel.id
    : model.provider === configuration.provider && model.id === configuration.modelId);
  const modelConfigured = Boolean(
    selectedModel && configuration?.configuredProviders.includes(selectedModel.provider),
  );
  const timeline = useMemo(
    () => buildConversationTimeline(messages, tools, subagents, projectState.planApproval, snapshot?.runtimeInspection),
    [messages, projectState.planApproval, snapshot?.runtimeInspection, subagents, tools],
  );

  const openProject = async (): Promise<void> => {
    const selection = await window.coilcoil.selectProject();
    if (!selection) return;
    const next = uniqueProjects([...projects, selection]);
    setProjects(next);
    saveMountedProjects(next);
    setSessionsByProject((current) => ({ ...current, [selection.path]: current[selection.path] ?? [] }));
    startPendingConversation(selection);
    void window.coilcoil.request<SessionSummary[]>({ type: "list_sessions", cwd: selection.path })
      .then((sessions) => setSessionsByProject((current) => ({ ...current, [selection.path]: sessions })))
      .catch((caught) => toastError(caught instanceof Error ? caught.message : String(caught)));
  };

  const removeProject = (target: ProjectSelection): void => {
    if (target.kind === "home") return;
    setProjects((current) => {
      const next = current.filter((item) => item.path !== target.path);
      saveMountedProjects(next);
      return next;
    });
    setExpandedProjects((current) => { const next = new Set(current); next.delete(target.path); return next; });
  };

  const startNewConversation = (owner = projectRef.current): void => {
    if (!owner) return;
    startPendingConversation(owner);
  };

  const openConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    shouldAutoScrollRef.current = true;
    setWorkspaceSurface("conversation");
    sessionRestoreRef.current?.cancel();
    const requestId = ++selectionRequestRef.current;
    const cached = snapshotCacheRef.current.get(session.path);
    setLoading(!cached);
    setRestoringSession(true);
    setPendingProjectPath(undefined);
    shouldAutoScrollRef.current = true;
    try {
      projectRef.current = owner;
      setProject(owner);
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, owner.path);
      if (cached) applySnapshot(cached);
      else {
        snapshotRef.current = undefined;
        setSnapshot(undefined);
        dispatchConversationMessages({ type: "reset" });
        setTools([]);
        setSubagents([]);
        setProjectState({ ...EMPTY_PROJECT, cwd: owner.path });
      }
      await sessionRestoreRef.current!.restore(session.path, cached?.runtimeId,
        () => window.coilcoil.request<SessionSnapshot>({ type: "open_session", cwd: owner.path, sessionPath: session.path }),
        (opened) => { if (requestId === selectionRequestRef.current) applySnapshot(opened); });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (requestId === selectionRequestRef.current && message !== SESSION_OPEN_SUPERSEDED_ERROR) toastError(message);
    } finally {
      if (requestId === selectionRequestRef.current) { setLoading(false); setRestoringSession(false); }
    }
  };
  // The bubble hands its conversation over by path; the runtime is already shared.
  useBubbleHandoff({ projects, sessionsByProject, openConversation, onError: toastError });

  const {
    archiveConversation, deleteConversation, deleteWorkspaceData,
    renameConversation, pinConversation, forkConversation, moveConversation, reorderProjects,
  } = useConversationActions({
    projects, sessionsByProject, sessionActivity, projectRef, snapshotRef, snapshotCacheRef,
    runtimeSessionRef, optimisticSessionsRef, setProjects, setSessionsByProject, setSessionActivity,
    setExpandedProjects, startPendingConversation, openConversation, removeProject,
  });

  const {
    cancelQueuedPrompt, promoteQueuedPrompt, abortRun, stopSubagent, resumeSubagent,
  } = useSessionControls(snapshot?.runtimeId);
  promoteQueuedPromptRef.current = promoteQueuedPrompt;

  const rewindPrompt = async (message: ChatMessage, text: string, images: PromptImage[], promptDocument: PromptDocument, restoreCode: boolean): Promise<void> => {
    if (!message.entryId || !snapshot?.runtimeId) return;
    const previousConversationMessages = conversationMessages;
    const previousTools = tools;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const pendingMessage: ChatMessage = {
      id: clientMessageId,
      order: message.order,
      role: "user",
      text,
      promptDocument,
      images,
      timestamp: Date.now(),
      status: "running",
    };
    dispatchConversationMessages({ type: "truncate", order: message.order });
    dispatchConversationMessages({ type: "queue", message: pendingMessage, sessionPath: snapshot.session.path });
    setTools((current) => current.filter((item) => item.order < message.order));
    shouldAutoScrollRef.current = true;
    try {
      await window.coilcoil.request({ type: "rewind_prompt", entryId: message.entryId, text, promptDocument, images, clientMessageId, restoreCode }, snapshot.runtimeId);
    } catch (caught) {
      dispatchConversationMessages({ type: "restore", state: previousConversationMessages });
      setTools(previousTools);
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const approvePlan = async (planId: string, target: PlanExecutionTarget, agent?: string): Promise<PlanApprovalState> => {
    if (!snapshot?.runtimeId) throw new Error("当前会话尚未准备好。");
    const plan = await window.coilcoil.request<PlanApprovalState>({ type: "approve_plan", planId, target, agent }, snapshot.runtimeId);
    setProjectState((current) => ({ ...current, planApproval: plan }));
    return plan;
  };

  const rejectPlan = async (planId: string): Promise<PlanApprovalState> => {
    if (!snapshot?.runtimeId) throw new Error("当前会话尚未准备好。");
    const plan = await window.coilcoil.request<PlanApprovalState>({ type: "reject_plan", planId }, snapshot.runtimeId);
    setProjectState((current) => ({ ...current, planApproval: plan }));
    return plan;
  };

  const submitPrompt = createPromptSubmissionHandler({
    project, pendingProjectPath, pendingAgentMode, startingSession, loading: loading || restoringSession, modelConfigured,
    configuration, selectedModel, draft, draftDocument, draftImages, composerSessionKey,
    snapshotRef, selectionRequestRef,
  }, {
    request: (command, runtimeId) => window.coilcoil.request(command, runtimeId),
    resetComposer, restoreSubmission, setSettingsOpen, setStartingSession,
    openRuntimeTab: () => inspector.openRuntimeTab(),
    scrollToBottom: () => { shouldAutoScrollRef.current = true; },
    queue: (message, sessionPath) => dispatchConversationMessages({ type: "queue", message, sessionPath }),
    reject: (id) => dispatchConversationMessages({ type: "reject", id }),
    created: (created, summary, clientMessageId, selected) => {
      const path = summary.path;
      if (path) {
        snapshotCacheRef.current.set(path, created);
        optimisticSessionsRef.current.set(path, summary);
        if (created.runtimeId) runtimeSessionRef.current.set(created.runtimeId, path);
        setSessionActivity((current) => ({ ...current, [path]: { runtimeId: created.runtimeId, running: true, unread: false } }));
      }
      setSessionsByProject((current) => ({ ...current, [summary.cwd]: upsertSessionSummary(current[summary.cwd] ?? [], summary) }));
      if (!selected) return;
      dispatchConversationMessages({ type: "bind_session", id: clientMessageId, sessionPath: path });
      snapshotRef.current = created;
      setSnapshot(created);
      setTools(created.tools);
      setSubagents(created.subagents);
      setProjectState(created.project);
      setPendingProjectPath(undefined);
    },
    creationFailed: (path) => setSessionActivity((current) => ({
      ...current, [path]: { ...current[path], running: false, unread: false },
    })),
    error: toastError,
  });

  if (onboarding.active) {
    return <OnboardingScreen
      configuration={configuration} onConfigurationSaved={setConfiguration}
      runtimeId={snapshot?.runtimeId} cwd={project?.path} projects={projects}
      onOpenProject={() => { void openProject(); }} onDone={onboarding.finish}
    />;
  }

  if (settingsOpen) {
    return <SettingsDialog
      configuration={configuration} open onSaved={setConfiguration}
      runtimeId={snapshot?.runtimeId} cwd={project?.path} initialSection={settingsSection}
      onReplayOnboarding={() => { setSettingsOpen(false); onboarding.replay(); }}
      onClose={() => { shouldAutoScrollRef.current = true; setSettingsOpen(false); }}
    />;
  }

  return (
    <AppView
      controller={{
        projects, project, activeConversation, pendingProjectPath, sessionsByProject,
        sessionActivity, expandedProjects, expandedSessionLimits, snapshot,
        leftOpen, leftWidth, rightOpen, rightWidth, workspaceSurface, loading,
        timeline, queuedPrompts, running, activityLine, projectState, subagents,
        startingSession: startingSession || restoringSession, configuration, selectedModel, fileDragActive, timelineRef,
        agentMode: snapshot?.agentMode ?? pendingAgentMode, agentModeLocked: Boolean(snapshot) || startingSession, setPendingAgentMode,
        shouldAutoScrollRef, composer, inspector, setExpandedProjects,
        setExpandedSessionLimits, setSessionsByProject, setWorkspaceSurface,
        setSettingsOpen, setSettingsSection, setLeftOpen, beginResize,
        startNewConversation, openProject, removeProject, openConversation,
        archiveConversation, deleteConversation, deleteWorkspaceData, renameConversation,
        pinConversation, forkConversation, moveConversation, reorderProjects,
        rewindPrompt, cancelQueuedPrompt, promoteQueuedPrompt, abortRun, stopSubagent, resumeSubagent,
        approvePlan, rejectPlan, submitPrompt, handleTimelineScroll,
        handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop,
      }}
    />
  );
}
