import {
  Files,
  PanelLeft,
  PanelRight,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import type {
  ChatMessage,
  FileNode,
  ProjectSelection,
  ProjectSnapshot,
  RuntimeBootstrap,
  RuntimeConfiguration,
  RuntimeEvent,
  PromptImage,
  SessionSnapshot,
  SessionSummary,
  SubagentActivity,
  ToolRun,
} from "@suocode/runtime-protocol";
import { buildConversationTimeline } from "./features/conversation/buildConversationTimeline";
import { ConversationPane } from "./features/conversation/ConversationPane";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { WorkspaceSidebar, type SessionActivityState } from "./features/workspaces/WorkspaceSidebar";
import { FilesPanel } from "./features/files/FilesPanel";
import { useComposerController } from "./features/composer/useComposerController";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { useFilePathDrop } from "./hooks/useFilePathDrop";
import { TerminalWorkspace } from "./features/terminal/TerminalWorkspace";

type InspectorView = "files";
type WorkspaceMode = "agent" | "terminal";

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


function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [subagents, setSubagents] = useState<SubagentActivity[]>([]);
  const [projectState, setProjectState] = useState<ProjectSnapshot>(EMPTY_PROJECT);
  const [configuration, setConfiguration] = useState<RuntimeConfiguration>();
  const [inspectorView, setInspectorView] = useState<InspectorView>("files");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("agent");
  const [terminalProject, setTerminalProject] = useState<ProjectSelection>();
  const [terminalFileRefresh, setTerminalFileRefresh] = useState(0);
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivityState>>({});
  const [pendingProjectPath, setPendingProjectPath] = useState<string>();
  const [expandedSessionLists, setExpandedSessionLists] = useState<Set<string>>(new Set());
  const [startingSession, setStartingSession] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const { leftOpen, rightOpen, leftWidth, rightWidth, setLeftOpen, setRightOpen, beginResize } = usePanelLayout();
  const [agentPhase, setAgentPhase] = useState<"思考" | "回复" | "工具">();
  const [activityPhraseIndex, setActivityPhraseIndex] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const composer = useComposerController({
    configuration,
    runtimeId: snapshot?.runtimeId,
    onConfigurationChange: setConfiguration,
    onError: setError,
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
  const runtimeSessionRef = useRef(new Map<string, string>());
  const optimisticMessageIdRef = useRef<string | undefined>(undefined);
  const { fileDragActive, handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop } = useFilePathDrop({
    onInsertPath: insertComposerPath,
    onError: (message) => setError(message),
  });

  const applySnapshot = useCallback((next: SessionSnapshot): void => {
    snapshotRef.current = next;
    if (next.runtimeId && next.session.path) runtimeSessionRef.current.set(next.runtimeId, next.session.path);
    setSnapshot(next);
    setMessages(next.messages);
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
    setWorkspaceMode("agent");
    projectRef.current = selection;
    setProject(selection);
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, selection.path);
    setExpandedProjects((current) => new Set(current).add(selection.path));
    setPendingProjectPath(selection.path);
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    setMessages([]);
    setTools([]);
    setSubagents([]);
    setProjectState({ ...EMPTY_PROJECT, cwd: selection.path });
    resetComposer();
    setLoading(false);
    setError(undefined);
    shouldAutoScrollRef.current = true;
    focusComposer();
  }, [focusComposer, resetComposer]);

  const handleRuntimeEvent = useCallback((event: RuntimeEvent, runtimeId?: string): void => {
    if (event.type === "session_snapshot") {
      const path = event.snapshot.session.path;
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
        setSessionsByProject((current) => ({ ...current, [event.cwd]: event.sessions }));
        break;
      case "session_snapshot":
        applySnapshot(event.snapshot);
        break;
      case "message_started":
      case "message_finished":
        setMessages((current) => {
          const optimisticId = optimisticMessageIdRef.current;
          const base = optimisticId && event.message.role === "user"
            ? current.filter((message) => message.id !== optimisticId)
            : current;
          if (optimisticId && event.message.role === "user") optimisticMessageIdRef.current = undefined;
          return upsertMessage(base, event.message);
        });
        break;
      case "message_delta":
        setAgentPhase(event.field === "thinking" ? "思考" : "回复");
        setMessages((current) => {
          const index = current.findIndex((message) => message.id === event.id);
          if (index < 0) {
            return [...current, { id: event.id, order: Date.now(), role: "assistant", text: event.field === "text" ? event.delta : "", thinking: event.field === "thinking" ? event.delta : undefined, timestamp: Date.now(), status: "running" }];
          }
          const next = [...current];
          const message = next[index];
          next[index] = { ...message, [event.field]: `${event.field === "thinking" ? message.thinking || "" : message.text}${event.delta}`, status: "running" };
          return next;
        });
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
      case "subagents_updated":
        setSubagents(event.subagents);
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
      case "run_state":
        setSnapshot((current) => current ? { ...current, running: event.running } : current);
        setAgentPhase(event.running ? "思考" : undefined);
        break;
      case "runtime_error":
        setError(event.message);
        break;
      default:
        break;
    }
  }, [applySnapshot]);

  const activateProject = useCallback(async (selection: ProjectSelection): Promise<void> => {
    setWorkspaceMode("agent");
    projectRef.current = selection;
    setProject(selection);
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, selection.path);
    setExpandedProjects((current) => new Set(current).add(selection.path));
    setPendingProjectPath(undefined);
    setDraftImages([]);
    setLoading(true);
    setError(undefined);
    setMessages([]);
    setTools([]);
    setSubagents([]);
    setProjectState({ ...EMPTY_PROJECT, cwd: selection.path });
    try {
      const existing = await window.suocode.request<SessionSummary[]>({ type: "list_sessions", cwd: selection.path });
      setSessionsByProject((current) => ({ ...current, [selection.path]: existing }));
      const next = existing[0]
        ? await window.suocode.request<SessionSnapshot>({ type: "open_session", cwd: selection.path, sessionPath: existing[0].path })
        : await window.suocode.request<SessionSnapshot>({ type: "create_session", cwd: selection.path });
      applySnapshot(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      focusComposer();
    }
  }, [applySnapshot, focusComposer, setDraftImages]);

  useEffect(() => {
    document.documentElement.dataset.platform = window.suocode.platform;
    const unsubscribe = window.suocode.onRuntimeEvent(handleRuntimeEvent);
    void (async () => {
      try {
        const bootstrap = await window.suocode.request<RuntimeBootstrap>({ type: "bootstrap" });
        setConfiguration(bootstrap.configuration);
        const home = await window.suocode.homeProject();
        const mounted = uniqueProjects([home, ...loadStoredProjects()]);
        setProjects(mounted);
        setExpandedProjects(new Set(mounted.map((item) => item.path)));
        await Promise.all(mounted.map(async (item) => {
          const listed = await window.suocode.request<SessionSummary[]>({ type: "list_sessions", cwd: item.path });
          setSessionsByProject((current) => ({ ...current, [item.path]: listed }));
        }));
        const activePath = window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
        await activateProject(mounted.find((item) => item.path === activePath) ?? home);
        if (!bootstrap.configuration.configuredProviders.length) setSettingsOpen(true);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      }
    })();
    return unsubscribe;
  }, [activateProject, handleRuntimeEvent]);

  useLayoutEffect(() => {
    const viewport = timelineRef.current;
    if (viewport && shouldAutoScrollRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, tools, snapshot?.running]);

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
  const timeline = useMemo(() => buildConversationTimeline(messages, tools, subagents), [messages, subagents, tools]);

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
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  };

  const startNewConversation = (owner = projectRef.current): void => {
    if (!owner) return;
    startPendingConversation(owner);
  };

  const openConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    setWorkspaceMode("agent");
    if (owner.path === project?.path && session.id === activeConversation?.id) return;
    setLoading(true);
    setError(undefined);
    setPendingProjectPath(undefined);
    resetComposer();
    shouldAutoScrollRef.current = true;
    try {
      projectRef.current = owner;
      setProject(owner);
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, owner.path);
      applySnapshot(await window.suocode.request<SessionSnapshot>({ type: "open_session", cwd: owner.path, sessionPath: session.path }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const archiveConversation = async (owner: ProjectSelection, session: SessionSummary): Promise<void> => {
    if (sessionActivity[session.path]?.running) {
      setError("请先停止正在运行的会话，再进行归档。");
      return;
    }
    try {
      const next = await window.suocode.request<SessionSummary[]>({ type: "archive_session", cwd: owner.path, sessionPath: session.path });
      setSessionsByProject((current) => ({ ...current, [owner.path]: next }));
      setSessionActivity((current) => {
        const updated = { ...current };
        delete updated[session.path];
        return updated;
      });
      if (owner.path === projectRef.current?.path && session.id === snapshotRef.current?.session.id) startPendingConversation(owner);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const rewindPrompt = async (message: ChatMessage, text: string, images: PromptImage[]): Promise<void> => {
    if (!message.entryId || !snapshot?.runtimeId) return;
    setError(undefined);
    const previousMessages = messages;
    const previousTools = tools;
    setMessages((current) => current.filter((item) => item.order < message.order));
    setTools((current) => current.filter((item) => item.order < message.order));
    shouldAutoScrollRef.current = true;
    try {
      await window.suocode.request({ type: "rewind_prompt", entryId: message.entryId, text, images }, snapshot.runtimeId);
    } catch (caught) {
      setMessages(previousMessages);
      setTools(previousTools);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openFilePreview = (node: FileNode): void => {
    const previewRoot = workspaceMode === "terminal" ? terminalProject?.path : projectState.cwd;
    if (!previewRoot || node.kind !== "file") return;
    void window.suocode.openFilePreview({ root: previewRoot, path: node.path }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  const submitPrompt = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prompt = draft.trim();
    const images = draftImages;
    if ((!prompt && !images.length) || !project || startingSession) return;
    if (!modelConfigured) {
      setError("发送第一条消息前，请先选择并配置模型。");
      setSettingsOpen(true);
      return;
    }
    if (images.length && !selectedModel?.supportsImages) {
      setError("当前模型不支持图片输入，请切换到支持图片的模型。");
      return;
    }
    setDraft("");
    setDraftImages([]);
    setError(undefined);
    shouldAutoScrollRef.current = true;
    const optimisticId = `local-${Date.now()}-${Math.random()}`;
    try {
      let target = snapshotRef.current;
      if (!target || pendingProjectPath === project.path) {
        setStartingSession(true);
        optimisticMessageIdRef.current = optimisticId;
        setMessages([{ id: optimisticId, order: Date.now(), role: "user", text: prompt, images, timestamp: Date.now(), status: "succeeded" }]);
        const created = await window.suocode.request<SessionSnapshot>({ type: "create_session", cwd: project.path });
        snapshotRef.current = created;
        if (created.runtimeId && created.session.path) runtimeSessionRef.current.set(created.runtimeId, created.session.path);
        setSnapshot(created);
        setTools(created.tools);
        setProjectState(created.project);
        setPendingProjectPath(undefined);
        target = created;
      }
      await window.suocode.request({ type: target.running ? "steer" : "prompt", text: prompt, images }, target.runtimeId);
    } catch (caught) {
      optimisticMessageIdRef.current = undefined;
      setDraft(prompt);
      setDraftImages(images);
      setMessages((current) => current.filter((message) => message.id !== optimisticId));
      setError(caught instanceof Error ? caught.message : String(caught));
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
  ];

  return (
    <>
      <main className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "keep-tiled" : "right-collapsed"}`} style={{ "--sidebar-width": `${leftWidth}px`, "--inspector-width": `${rightWidth}px` } as CSSProperties}>
        <WorkspaceSidebar
          projects={projects}
          activeProject={workspaceMode === "terminal" ? terminalProject ?? null : project}
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
          onOpenTerminal={(owner) => {
            setTerminalProject(owner);
            setWorkspaceMode("terminal");
            setExpandedProjects((current) => new Set(current).add(owner.path));
          }}
          onShowAllSessions={(path) => setExpandedSessionLists((current) => new Set(current).add(path))}
          onCollapseSessions={(path) => setExpandedSessionLists((current) => { const next = new Set(current); next.delete(path); return next; })}
          onOpenConversation={(owner, session) => { void openConversation(owner, session); }}
          onArchiveConversation={(owner, session) => { void archiveConversation(owner, session); }}
          onRestoreSessions={(owner, sessions) => setSessionsByProject((current) => ({ ...current, [owner.path]: sessions }))}
          onFocusPending={() => { setWorkspaceMode("agent"); inputRef.current?.focus(); }}
          onOpenSettings={() => setSettingsOpen(true)}
          onError={setError}
        />
        {leftOpen ? <button className="sidebar-toggle" type="button" aria-label="收起侧栏" onClick={() => setLeftOpen(false)}><span><PanelLeft size={17} /></span></button> : null}
        {leftOpen ? <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("left", event)} /> : null}

        {workspaceMode === "agent" ? <ConversationPane
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
          error={error}
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
          onError={setError}
          onStopSubagent={(activity) => { void window.suocode.request({ type: "stop_subagent", id: activity.runId, background: activity.background }, snapshot?.runtimeId).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))); }}
          onSubmit={(event) => { void submitPrompt(event); }}
          onDraftChange={setDraft}
          onImagesChange={setDraftImages}
          onPaste={composer.handlePaste}
          onCompositionStart={composer.handleCompositionStart}
          onCompositionEnd={composer.handleCompositionEnd}
          onKeyDown={composer.handleKeyDown}
          onModelMenuOpenChange={setModelMenuOpen}
          onSelectModel={(model) => { void composer.selectModel(model); }}
          onOpenSettings={() => { setModelMenuOpen(false); setSettingsOpen(true); }}
          onAbort={() => { void window.suocode.request({ type: "abort" }, snapshot?.runtimeId); }}
        /> : terminalProject ? <TerminalWorkspace project={terminalProject} leftOpen={leftOpen} rightOpen={rightOpen} onOpenLeft={() => setLeftOpen(true)} onOpenRight={() => setRightOpen(true)} /> : null}

        <aside className="inspector-pane">
          <div className="inspector-header"><div className="inspector-drag-surface" aria-hidden="true" /><div className="inspector-actions no-drag"><button className="icon-button" type="button" aria-label="刷新项目" disabled={workspaceMode === "agent" && !snapshot} onClick={() => workspaceMode === "agent" ? void window.suocode.request({ type: "refresh_project" }, snapshot?.runtimeId) : setTerminalFileRefresh((current) => current + 1)}><RefreshCw size={15} /></button><button className="icon-button" type="button" aria-label="收起右侧栏" onClick={() => setRightOpen(false)}><PanelRight size={17} /></button></div></div>
          <nav className="inspector-nav">{inspectorItems.map((item) => { const Icon = item.icon; return <button className={item.id === inspectorView ? "active" : ""} type="button" key={item.id} onClick={() => setInspectorView(item.id)}><Icon size={17} strokeWidth={1.7} /><span>{item.label}</span></button>; })}</nav>
          <section className="inspector-content">
            {inspectorView === "files" ? <FilesPanel key={workspaceMode === "terminal" ? `${terminalProject?.path ?? "terminal"}-${terminalFileRefresh}` : "agent-files"} project={workspaceMode === "terminal" && terminalProject ? { ...EMPTY_PROJECT, cwd: terminalProject.path } : projectState} runtimeId={workspaceMode === "agent" ? snapshot?.runtimeId : undefined} onOpen={openFilePreview} /> : null}
          </section>
        </aside>
        {rightOpen ? <div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("right", event)} /> : null}
      </main>
      <SettingsDialog configuration={configuration} open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={setConfiguration} runtimeId={snapshot?.runtimeId} cwd={project?.path} />
    </>
  );
}
