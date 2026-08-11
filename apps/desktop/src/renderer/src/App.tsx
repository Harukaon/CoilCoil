import {
  BrainCircuit,
  Files,
  PanelLeft,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import type {
  ChatMessage,
  PlanApprovalState,
  PlanExecutionTarget,
  ProjectSelection,
  ProjectSnapshot,
  RuntimeBootstrap,
  RuntimeConfiguration,
  RuntimeEvent,
  PromptImage,
  SessionSnapshot,
  SessionSummary,
  SubagentActivity,
  WorkspaceSnapshot,
  ToolRun,
} from "@suocode/runtime-protocol";
import { SESSION_OPEN_SUPERSEDED_ERROR } from "@suocode/runtime-protocol";
import { buildConversationTimeline } from "./features/conversation/buildConversationTimeline";
import { ConversationPane } from "./features/conversation/ConversationPane";
import {
  conversationMessagesReducer,
  EMPTY_CONVERSATION_MESSAGES,
  selectConversationMessages,
} from "./features/conversation/conversationMessages";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { SkillsWorkspace } from "./features/settings/SkillsWorkspace";
import { WorkspaceSidebar, type SessionActivityState } from "./features/workspaces/WorkspaceSidebar";
import { titleFromPrompt, upsertSessionSummary } from "./features/workspaces/sessionList";
import { FilesPanel } from "./features/files/FilesPanel";
import { InspectorPane } from "./features/inspector/InspectorPane";
import { RuntimePanel } from "./features/runtime/RuntimePanel";
import { useComposerController } from "./features/composer/useComposerController";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { useFilePathDrop } from "./hooks/useFilePathDrop";
import { toastError, toastInfo, toastSuccess } from "./ui/toast";

type InspectorView = "files" | "runtime";
type WorkspaceSurface = "conversation" | "skills";

const LEGACY_PROJECT_STORAGE_KEY = "suocode.selected-workspace";
const PROJECTS_STORAGE_KEY = "suocode.mounted-projects";
const ACTIVE_PROJECT_STORAGE_KEY = "suocode.active-project";
const AGENT_ACTIVITY_PHRASES = ["工作中…", "整理线索…", "翻找文件…", "冲浪中…", "组织思路…", "沿着思路前进…", "快收尾了…"];
const EMPTY_PROJECT: ProjectSnapshot = {
  cwd: "",
  files: [],
  changes: [],
  terminals: [],
  plan: [],
  refreshedAt: 0,
};

function isWorkspace(value: Partial<ProjectSelection>): value is ProjectSelection {
  return typeof value.name === "string" && typeof value.path === "string" && value.kind === "workspace";
}

function loadStoredProjects(): ProjectSelection[] {
  try {
    const stored = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Array<Partial<ProjectSelection>>;
      if (Array.isArray(parsed)) return parsed.filter(isWorkspace);
    }
    const legacy = window.localStorage.getItem(LEGACY_PROJECT_STORAGE_KEY);
    if (!legacy) return [];
    const parsed = JSON.parse(legacy) as Partial<ProjectSelection>;
    return isWorkspace(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function uniqueProjects(projects: ProjectSelection[]): ProjectSelection[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    if (seen.has(project.path)) return false;
    seen.add(project.path);
    return true;
  });
}


function upsertTool(tools: ToolRun[], tool: ToolRun): ToolRun[] {
  const index = tools.findIndex((item) => item.id === tool.id);
  if (index < 0) return [...tools, tool];
  const next = [...tools];
  next[index] = tool;
  return next;
}

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
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [subagents, setSubagents] = useState<SubagentActivity[]>([]);
  const [projectState, setProjectState] = useState<ProjectSnapshot>(EMPTY_PROJECT);
  const [configuration, setConfiguration] = useState<RuntimeConfiguration>();
  const [inspectorView, setInspectorView] = useState<InspectorView>("files");
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivityState>>({});
  const [pendingProjectPath, setPendingProjectPath] = useState<string>();
  const [expandedSessionLists, setExpandedSessionLists] = useState<Set<string>>(new Set());
  const [startingSession, setStartingSession] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const { leftOpen, rightOpen, leftWidth, rightWidth, setLeftOpen, setRightOpen, beginResize } = usePanelLayout();
  const [agentPhase, setAgentPhase] = useState<"思考" | "回复" | "工具">();
  const [activityPhraseIndex, setActivityPhraseIndex] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"models" | "mcp" | "skills">("models");
  const [workspaceSurface, setWorkspaceSurface] = useState<WorkspaceSurface>("conversation");
  const [loading, setLoading] = useState(true);
  const composer = useComposerController({
    configuration,
    runtimeId: snapshot?.runtimeId,
    onConfigurationChange: setConfiguration,
    onError: (message) => { if (message) toastError(message); },
  });
  const {
    draft,
    images: draftImages,
    inputRef,
    modelMenuOpen,
    modelChanging,
    setDraft,
    setImages: setDraftImages,
    setModelMenuOpen,
    reset: resetComposer,
    focus: focusComposer,
    insertPath: insertComposerPath,
  } = composer;
  const timelineRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const snapshotRef = useRef<SessionSnapshot | undefined>(undefined);
  const snapshotCacheRef = useRef(new Map<string, SessionSnapshot>());
  const runtimeSessionRef = useRef(new Map<string, string>());
  const optimisticSessionsRef = useRef(new Map<string, SessionSummary>());
  const selectionRequestRef = useRef(0);
  const { fileDragActive, handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop } = useFilePathDrop({
    onInsertPath: insertComposerPath,
    onError: (message) => { if (message) toastError(message); },
  });

  const applySnapshot = useCallback((next: SessionSnapshot): void => {
    snapshotRef.current = next;
    if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
    if (next.runtimeId && next.session.path) runtimeSessionRef.current.set(next.runtimeId, next.session.path);
    setSnapshot(next);
    dispatchConversationMessages({
      type: "snapshot",
      sessionPath: next.session.path,
      messages: next.messages,
      revision: next.messageRevision ?? 0,
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
    resetComposer();
    setLoading(false);
    shouldAutoScrollRef.current = true;
    focusComposer();
  }, [focusComposer, resetComposer]);

  const handleRuntimeEvent = useCallback((event: RuntimeEvent, runtimeId?: string): void => {
    if (event.type === "session_snapshot") {
      const path = event.snapshot.session.path;
      if (path) snapshotCacheRef.current.set(path, event.snapshot);
      if (runtimeId && path) runtimeSessionRef.current.set(runtimeId, path);
      if (path) {
        setSessionActivity((current) => {
          const active = snapshotRef.current?.runtimeId === runtimeId;
          return { ...current, [path]: { runtimeId, running: event.snapshot.running, unread: active ? false : current[path]?.unread ?? false } };
        });
      }
      if (runtimeId !== snapshotRef.current?.runtimeId) return;
    } else if (event.type === "run_state" && runtimeId) {
      const path = runtimeSessionRef.current.get(runtimeId);
      if (path) {
        setSessionActivity((current) => {
          const active = snapshotRef.current?.runtimeId === runtimeId;
          return { ...current, [path]: { runtimeId, running: event.running, unread: !event.running && !active ? true : active ? false : current[path]?.unread ?? false } };
        });
      }
      if (runtimeId !== snapshotRef.current?.runtimeId) return;
    } else if (runtimeId && runtimeId !== snapshotRef.current?.runtimeId && event.type !== "sessions_updated" && event.type !== "configuration_updated") {
      return;
    }
    switch (event.type) {
      case "runtime_ready":
      case "configuration_updated":
        setConfiguration(event.configuration);
        break;
      case "sessions_updated":
        setSessionsByProject((current) => {
          let sessions = event.sessions;
          const confirmedPaths = new Set(event.sessions.map((session) => session.path));
          for (const [path, optimistic] of optimisticSessionsRef.current) {
            if (confirmedPaths.has(path)) {
              optimisticSessionsRef.current.delete(path);
            } else if (optimistic.cwd === event.cwd) {
              sessions = upsertSessionSummary(sessions, optimistic);
            }
          }
          return { ...current, [event.cwd]: sessions };
        });
        break;
      case "session_snapshot":
        applySnapshot(event.snapshot);
        break;
      case "message_started":
      case "message_finished":
        dispatchConversationMessages({ type: "runtime_message", message: event.message, revision: event.revision });
        break;
      case "message_delta":
        setAgentPhase(event.field === "thinking" ? "思考" : "回复");
        dispatchConversationMessages({ ...event, timestamp: Date.now() });
        break;
      case "message_rejected":
        dispatchConversationMessages({ type: "reject", id: event.id, revision: event.revision });
        break;
      case "tool_started":
        setAgentPhase("工具");
        setTools((current) => upsertTool(current, event.tool));
        break;
      case "tool_updated":
      case "tool_finished":
        setTools((current) => upsertTool(current, event.tool));
        if (event.type === "tool_finished") setAgentPhase("思考");
        break;
      case "plan_updated":
        setProjectState((current) => ({ ...current, plan: event.plan }));
        break;
      case "plan_approval_updated":
        setProjectState((current) => ({ ...current, planApproval: event.plan }));
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, project: { ...current.project, planApproval: event.plan } };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "subagents_updated":
        setSubagents(event.subagents);
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, subagents: event.subagents };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "project_updated":
        setProjectState(event.project);
        break;
      case "metrics_updated":
        setSnapshot((current) => current ? {
          ...current,
          responseMetrics: event.responseMetrics,
          responseMetricsHistory: event.responseMetricsHistory,
          contextUsage: event.contextUsage,
          tokenUsage: event.tokenUsage,
        } : current);
        break;
      case "runtime_inspection_updated":
        setSnapshot((current) => {
          if (!current) return current;
          const next = { ...current, runtimeInspection: event.inspection };
          snapshotRef.current = next;
          if (next.session.path) snapshotCacheRef.current.set(next.session.path, next);
          return next;
        });
        break;
      case "runtime_notice":
        if (event.level === "error") toastError(event.message);
        else if (event.level === "success") toastSuccess(event.message);
        else toastInfo(event.message);
        break;
      case "run_state":
        setSnapshot((current) => current ? { ...current, running: event.running } : current);
        setAgentPhase(event.running ? "思考" : undefined);
        break;
      case "runtime_error":
        toastError(event.message);
        break;
      default:
        break;
    }
  }, [applySnapshot]);

  const activateProject = useCallback(async (selection: ProjectSelection): Promise<void> => {
    const requestId = ++selectionRequestRef.current;
    projectRef.current = selection;
    setProject(selection);
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, selection.path);
    setExpandedProjects((current) => new Set(current).add(selection.path));
    setPendingProjectPath(undefined);
    setDraftImages([]);
    setLoading(true);
    dispatchConversationMessages({ type: "reset" });
    setTools([]);
    setSubagents([]);
    setProjectState({ ...EMPTY_PROJECT, cwd: selection.path });
    try {
      const { sessions, snapshot } = await window.suocode.request<WorkspaceSnapshot>({ type: "open_workspace", cwd: selection.path });
      if (requestId !== selectionRequestRef.current) return;
      setSessionsByProject((current) => ({ ...current, [selection.path]: sessions }));
      applySnapshot(snapshot);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (requestId === selectionRequestRef.current && message !== SESSION_OPEN_SUPERSEDED_ERROR) toastError(message);
    } finally {
      if (requestId === selectionRequestRef.current) {
        setLoading(false);
        focusComposer();
      }
    }
  }, [applySnapshot, focusComposer, setDraftImages]);

  useEffect(() => {
    document.documentElement.dataset.platform = window.suocode.platform;
    const unsubscribe = window.suocode.onRuntimeEvent(handleRuntimeEvent);
    void (async () => {
      try {
        const bootstrapPromise = window.suocode.request<RuntimeBootstrap>({ type: "bootstrap" }).then((bootstrap) => {
          setConfiguration(bootstrap.configuration);
          return bootstrap;
        });
        const home = await window.suocode.homeProject();
        const mounted = uniqueProjects([home, ...loadStoredProjects()]);
        setProjects(mounted);
        const activePath = window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
        const activeProject = mounted.find((item) => item.path === activePath) ?? home;
        setExpandedProjects(new Set([activeProject.path]));
        const backgroundProjects = mounted.filter((item) => item.path !== activeProject.path);
        void Promise.allSettled(backgroundProjects.map(async (item) => {
          const listed = await window.suocode.request<SessionSummary[]>({ type: "list_sessions", cwd: item.path });
          setSessionsByProject((current) => ({ ...current, [item.path]: listed }));
        }));
        const [bootstrap] = await Promise.all([bootstrapPromise, activateProject(activeProject)]);
        if (!bootstrap.configuration.configuredProviders.length) setSettingsOpen(true);
      } catch (caught) {
        toastError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      }
    })();
    return unsubscribe;
  }, [activateProject, handleRuntimeEvent]);

  useLayoutEffect(() => {
    const viewport = timelineRef.current;
    if (viewport && shouldAutoScrollRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, tools, snapshot?.running]);

  useLayoutEffect(() => {
    if (settingsOpen || workspaceSurface !== "conversation") return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = timelineRef.current;
      if (viewport && shouldAutoScrollRef.current) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [settingsOpen, workspaceSurface]);

  useEffect(() => {
    const runtimeId = snapshot?.runtimeId;
    if (settingsOpen || workspaceSurface !== "conversation" || inspectorView !== "runtime" || !runtimeId) return;
    let cancelled = false;
    void window.suocode.request<SessionSnapshot["runtimeInspection"]>({ type: "get_runtime_inspection" }, runtimeId)
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
  }, [inspectorView, settingsOpen, snapshot?.runtimeId, workspaceSurface]);

  useEffect(() => {
    if (!snapshot?.running) return;
    const timer = window.setInterval(() => setActivityPhraseIndex((current) => current + 1), 2_300);
    return () => window.clearInterval(timer);
  }, [snapshot?.running]);

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

  const activeConversation = snapshot?.session;
  const running = snapshot?.running ?? false;
  const selectedModel = configuration?.models.find((model) => snapshot?.model
    ? model.provider === snapshot.model.provider && model.id === snapshot.model.id
    : model.provider === configuration.provider && model.id === configuration.modelId);
  const modelConfigured = Boolean(
    selectedModel && configuration?.configuredProviders.includes(selectedModel.provider),
  );
  const timeline = useMemo(
    () => buildConversationTimeline(messages, tools, subagents, projectState.planApproval),
    [messages, projectState.planApproval, subagents, tools],
  );

  const openProject = async (): Promise<void> => {
    const selection = await window.suocode.selectProject();
    if (!selection) return;
    const next = uniqueProjects([...projects, selection]);
    setProjects(next);
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next.filter((item) => item.kind === "workspace")));
    setSessionsByProject((current) => ({ ...current, [selection.path]: current[selection.path] ?? [] }));
    startPendingConversation(selection);
    void window.suocode.request<SessionSummary[]>({ type: "list_sessions", cwd: selection.path })
      .then((sessions) => setSessionsByProject((current) => ({ ...current, [selection.path]: sessions })))
      .catch((caught) => toastError(caught instanceof Error ? caught.message : String(caught)));
  };

  const removeProject = (target: ProjectSelection): void => {
    if (target.kind === "home") return;
    setProjects((current) => {
      const next = current.filter((item) => item.path !== target.path);
      window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(next.filter((item) => item.kind === "workspace")));
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
    if (owner.path === project?.path && session.id === activeConversation?.id) return;
    const requestId = ++selectionRequestRef.current;
    const cached = snapshotCacheRef.current.get(session.path);
    setLoading(!cached);
    setPendingProjectPath(undefined);
    resetComposer();
    shouldAutoScrollRef.current = true;
    try {
      projectRef.current = owner;
      setProject(owner);
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, owner.path);
      if (cached) applySnapshot(cached);
      const opened = await window.suocode.request<SessionSnapshot>({ type: "open_session", cwd: owner.path, sessionPath: session.path });
      if (requestId === selectionRequestRef.current) applySnapshot(opened);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (requestId === selectionRequestRef.current && message !== SESSION_OPEN_SUPERSEDED_ERROR) toastError(message);
    } finally {
      if (requestId === selectionRequestRef.current) setLoading(false);
    }
  };

  const archiveConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      toastError("请先停止正在运行的会话，再进行归档。");
      return;
    }
    try {
      const next = await window.suocode.request<SessionSummary[]>({ type: "archive_session", cwd: owner.path, sessionPath: session.path });
      optimisticSessionsRef.current.delete(session.path);
      setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
      setSessionActivity((current) => {
        const updated = { ...current };
        delete updated[session.path];
        return updated;
      });
      if (owner.path === projectRef.current?.path && session.id === snapshotRef.current?.session.id) startPendingConversation(owner);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const renameConversation = async (owner: ProjectSelection, session: SessionSummary, name: string): Promise<void> => {
    const next = await window.suocode.request<SessionSummary[]>({ type: "rename_session", cwd: owner.path, sessionPath: session.path, name });
    setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
  };

  const pinConversation = async (owner: ProjectSelection, session: SessionSummary, pinned: boolean): Promise<void> => {
    try {
      const next = await window.suocode.request<SessionSummary[]>({ type: "pin_session", cwd: owner.path, sessionPath: session.path, pinned });
      setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const forkConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      toastError("请先停止正在运行的会话，再进行 Fork。");
      return;
    }
    try {
      const result = await window.suocode.request<{ sessions: SessionSummary[]; session: SessionSummary }>({
        type: "fork_session",
        cwd: owner.path,
        sessionPath: session.path,
      });
      setSessionsByProject((current) => ({ ...current, [owner.path]: result.sessions }));
      await openConversation(owner, result.session);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const rewindPrompt = async (message: ChatMessage, text: string, images: PromptImage[]): Promise<void> => {
    if (!message.entryId || !snapshot?.runtimeId) return;
    const previousConversationMessages = conversationMessages;
    const previousTools = tools;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const pendingMessage: ChatMessage = {
      id: clientMessageId,
      order: message.order,
      role: "user",
      text,
      images,
      timestamp: Date.now(),
      status: "succeeded",
    };
    dispatchConversationMessages({ type: "truncate", order: message.order });
    dispatchConversationMessages({ type: "queue", message: pendingMessage, sessionPath: snapshot.session.path });
    setTools((current) => current.filter((item) => item.order < message.order));
    shouldAutoScrollRef.current = true;
    try {
      await window.suocode.request({ type: "rewind_prompt", entryId: message.entryId, text, images, clientMessageId }, snapshot.runtimeId);
    } catch (caught) {
      dispatchConversationMessages({ type: "restore", state: previousConversationMessages });
      setTools(previousTools);
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const approvePlan = async (planId: string, target: PlanExecutionTarget, agent?: string): Promise<PlanApprovalState> => {
    if (!snapshot?.runtimeId) throw new Error("当前会话尚未准备好。");
    const plan = await window.suocode.request<PlanApprovalState>({ type: "approve_plan", planId, target, agent }, snapshot.runtimeId);
    setProjectState((current) => ({ ...current, planApproval: plan }));
    return plan;
  };

  const rejectPlan = async (planId: string): Promise<PlanApprovalState> => {
    if (!snapshot?.runtimeId) throw new Error("当前会话尚未准备好。");
    const plan = await window.suocode.request<PlanApprovalState>({ type: "reject_plan", planId }, snapshot.runtimeId);
    setProjectState((current) => ({ ...current, planApproval: plan }));
    return plan;
  };

  const submitPrompt = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prompt = draft.trim();
    const images = draftImages;
    const runtimeCommand = prompt === "/memory" && images.length === 0;
    if ((!prompt && !images.length) || !project || startingSession) return;
    if (runtimeCommand && (
      !snapshotRef.current
      || pendingProjectPath === project.path
      || snapshotRef.current.messages.length === 0
    )) {
      toastError("当前会话还没有可供整理的历史记录。");
      return;
    }
    if (!modelConfigured) {
      toastError("发送第一条消息前，请先选择并配置模型。");
      setSettingsOpen(true);
      return;
    }
    if (images.length && !selectedModel?.supportsImages) {
      toastError("当前模型不支持图片输入，请切换到支持图片的模型。");
      return;
    }
    setDraft("");
    setDraftImages([]);
    if (runtimeCommand) {
      setInspectorView("runtime");
      setRightOpen(true);
    }
    shouldAutoScrollRef.current = true;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const pendingMessage: ChatMessage | undefined = runtimeCommand ? undefined : {
      id: clientMessageId,
      order: Date.now(),
      role: "user",
      text: prompt,
      images,
      timestamp: Date.now(),
      status: "succeeded",
    };
    if (pendingMessage) {
      dispatchConversationMessages({
        type: "queue",
        message: pendingMessage,
        sessionPath: snapshotRef.current?.session.path,
      });
    }
    let createdSessionPath: string | undefined;
    try {
      let target = snapshotRef.current;
      if (!target || pendingProjectPath === project.path) {
        setStartingSession(true);
        const created = await window.suocode.request<SessionSnapshot>({ type: "create_session", cwd: project.path });
        const now = new Date().toISOString();
        const optimisticSession: SessionSummary = {
          ...created.session,
          title: runtimeCommand ? (created.session.title || "新对话") : titleFromPrompt(prompt, images.length > 0),
          updatedAt: now,
          messageCount: runtimeCommand ? created.session.messageCount : Math.max(1, created.session.messageCount),
        };
        const activeSnapshot = { ...created, session: optimisticSession };
        createdSessionPath = optimisticSession.path;
        if (pendingMessage) dispatchConversationMessages({ type: "bind_session", id: clientMessageId, sessionPath: optimisticSession.path });
        if (optimisticSession.path) optimisticSessionsRef.current.set(optimisticSession.path, optimisticSession);
        snapshotRef.current = activeSnapshot;
        if (created.runtimeId && created.session.path) runtimeSessionRef.current.set(created.runtimeId, created.session.path);
        setSnapshot(activeSnapshot);
        setSessionsByProject((current) => ({
          ...current,
          [project.path]: upsertSessionSummary(current[project.path] ?? [], optimisticSession),
        }));
        if (optimisticSession.path) {
          setSessionActivity((current) => ({
            ...current,
            [optimisticSession.path]: { runtimeId: created.runtimeId, running: true, unread: false },
          }));
        }
        setTools(created.tools);
        setProjectState(created.project);
        setPendingProjectPath(undefined);
        target = activeSnapshot;
      }
      if (runtimeCommand) await window.suocode.request({ type: "run_memory_now" }, target.runtimeId);
      else await window.suocode.request({ type: target.running ? "steer" : "prompt", text: prompt, images, clientMessageId }, target.runtimeId);
    } catch (caught) {
      setDraft(prompt);
      setDraftImages(images);
      dispatchConversationMessages({ type: "reject", id: clientMessageId });
      if (createdSessionPath) {
        const failedSessionPath = createdSessionPath;
        setSessionActivity((current) => ({
          ...current,
          [failedSessionPath]: { ...current[failedSessionPath], running: false, unread: false },
        }));
      }
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStartingSession(false);
    }
  };

  const handleTimelineScroll = (): void => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    shouldAutoScrollRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
  };

  const inspectorItems: Array<{ id: InspectorView; label: string; icon: typeof Files }> = [
    { id: "files", label: "文件", icon: Files },
    { id: "runtime", label: "运行时", icon: BrainCircuit },
  ];

  if (settingsOpen) {
    return <SettingsDialog configuration={configuration} open onClose={() => { shouldAutoScrollRef.current = true; setSettingsOpen(false); }} onSaved={setConfiguration} runtimeId={snapshot?.runtimeId} cwd={project?.path} initialSection={settingsSection} />;
  }

  return (
    <>
      <main className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`} style={{ "--sidebar-width": `${leftWidth}px`, "--inspector-width": `${rightWidth}px` } as CSSProperties}>
        <WorkspaceSidebar
          projects={projects}
          activeProject={project}
          activeSessionId={activeConversation?.id}
          pendingProjectPath={pendingProjectPath}
          sessionsByProject={sessionsByProject}
          sessionActivity={sessionActivity}
          expandedProjects={expandedProjects}
          expandedSessionLists={expandedSessionLists}
          modelLabel={snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.name}` : "本地 Agent"}
          onNewConversation={(owner) => startNewConversation(owner)}
          onOpenProject={() => { void openProject(); }}
          onToggleProject={(path) => setExpandedProjects((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
          })}
          onShowAllSessions={(path) => setExpandedSessionLists((current) => new Set(current).add(path))}
          onCollapseSessions={(path) => setExpandedSessionLists((current) => { const next = new Set(current); next.delete(path); return next; })}
          onOpenConversation={(owner, session) => { void openConversation(owner, session); }}
          onArchiveConversation={(owner, session) => { void archiveConversation(owner, session); }}
          onRenameConversation={(owner, session, name) => renameConversation(owner, session, name)}
          onPinConversation={(owner, session, pinned) => { void pinConversation(owner, session, pinned); }}
          onForkConversation={(owner, session) => { void forkConversation(owner, session); }}
          onRestoreSessions={(owner, sessions) => setSessionsByProject((current) => ({ ...current, [owner.path]: sessions }))}
          onFocusPending={() => {
            setWorkspaceSurface("conversation");
            window.requestAnimationFrame(() => inputRef.current?.focus());
          }}
          skillsOpen={workspaceSurface === "skills"}
          onOpenSkills={() => {
            setModelMenuOpen(false);
            setWorkspaceSurface("skills");
          }}
          onOpenSettings={() => {
            setSettingsSection("models");
            setSettingsOpen(true);
          }}
          onRemoveProject={(owner) => removeProject(owner)}
          onError={(message) => { if (message) toastError(message); }}
        />
        {leftOpen ? <button className="sidebar-toggle" type="button" aria-label="收起侧栏" onClick={() => setLeftOpen(false)}><span><PanelLeft size={17} /></span></button> : null}
        {leftOpen ? <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("left", event)} /> : null}

        {workspaceSurface === "skills" ? (
          <SkillsWorkspace
            runtimeId={snapshot?.runtimeId}
            cwd={project?.path}
            leftOpen={leftOpen}
            onOpenLeft={() => setLeftOpen(true)}
            onClose={() => {
              shouldAutoScrollRef.current = true;
              setWorkspaceSurface("conversation");
            }}
          />
        ) : <>
        <ConversationPane
          fileDragActive={fileDragActive}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          pendingProjectPath={pendingProjectPath}
          activeConversation={activeConversation}
          project={project}
          loading={loading}
          timeline={timeline}
          running={running}
          timelineRef={timelineRef}
          agentPhase={agentPhase}
          activityPhrase={AGENT_ACTIVITY_PHRASES[activityPhraseIndex % AGENT_ACTIVITY_PHRASES.length]}
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
          onOpenRight={() => setRightOpen(true)}
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
          onOpenSettings={(section) => {
            setModelMenuOpen(false);
            setSettingsSection(section ?? "models");
            setSettingsOpen(true);
          }}
          onAbort={() => { void window.suocode.request({ type: "abort" }, snapshot?.runtimeId); }}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
        />

        <InspectorPane
          tabs={inspectorItems}
          activeTab={inspectorView}
          onSelectTab={setInspectorView}
          onRefresh={() => void window.suocode.request({ type: "refresh_project" }, snapshot?.runtimeId)}
          refreshDisabled={!snapshot}
          onClose={() => setRightOpen(false)}
        >
          <div className={`inspector-tab-panel files-tab-panel ${inspectorView === "files" ? "active" : ""}`}>
            <FilesPanel key={`agent-files:${projectState.cwd}`} project={projectState} runtimeId={snapshot?.runtimeId} />
          </div>
          <div className={`inspector-tab-panel runtime-tab-panel ${inspectorView === "runtime" ? "active" : ""}`}>
            <RuntimePanel inspection={snapshot?.runtimeInspection} contextUsage={snapshot?.contextUsage} tokenUsage={snapshot?.tokenUsage} runtimeId={snapshot?.runtimeId} cwd={project?.path} />
          </div>
        </InspectorPane>
        {rightOpen ? <div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("right", event)} /> : null}
        </>}
      </main>
    </>
  );
}
