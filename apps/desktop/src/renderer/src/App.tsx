import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  File,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  GitCompareArrows,
  KeyRound,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChangedFile,
  ChatMessage,
  FileNode,
  ProjectSelection,
  ProjectSnapshot,
  RuntimeBootstrap,
  RuntimeConfiguration,
  RuntimeEvent,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
  ToolRun,
} from "@suocode/runtime-protocol";

type InspectorView = "plan" | "changes" | "terminal" | "files";
type TimelineItem =
  | { kind: "message"; timestamp: number; message: ChatMessage }
  | { kind: "tool"; timestamp: number; tool: ToolRun };

const PROJECT_STORAGE_KEY = "suocode.selected-project";
const EMPTY_PROJECT: ProjectSnapshot = {
  cwd: "",
  files: [],
  changes: [],
  terminals: [],
  plan: [],
  refreshedAt: 0,
};

function loadStoredProject(): ProjectSelection | null {
  try {
    const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<ProjectSelection>;
    return typeof parsed.name === "string" && typeof parsed.path === "string"
      ? { name: parsed.name, path: parsed.path }
      : null;
  } catch {
    return null;
  }
}

function relativeTime(value: string): string {
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "now";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function EmptyState({ icon: Icon, title, detail }: {
  icon: typeof CheckSquare2;
  title: string;
  detail: string;
}): React.JSX.Element {
  return (
    <div className="inspector-empty">
      <span className="inspector-empty-icon"><Icon size={16} strokeWidth={1.7} /></span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function MessageView({ message }: { message: ChatMessage }): React.JSX.Element {
  if (message.role === "user") {
    return (
      <article className="timeline-message user-message">
        <div className="message-label">You</div>
        <div className="user-bubble">{message.text}</div>
      </article>
    );
  }

  return (
    <article className={`timeline-message assistant-message ${message.isError ? "error" : ""}`}>
      <div className="assistant-avatar"><Bot size={15} /></div>
      <div className="assistant-content">
        <div className="message-label">SuoCode</div>
        {message.thinking?.trim() ? (
          <details className="thinking-block">
            <summary>Reasoning</summary>
            <div>{message.thinking}</div>
          </details>
        ) : null}
        {message.text ? <Markdown>{message.text}</Markdown> : message.status === "running" ? <span className="typing-dot">Working…</span> : null}
      </div>
    </article>
  );
}

function ToolView({ tool }: { tool: ToolRun }): React.JSX.Element {
  return (
    <details className={`tool-card ${tool.status}`} open={tool.status === "running"}>
      <summary>
        <span className="tool-state-icon">
          {tool.status === "running" ? <LoaderCircle className="spin" size={14} /> : tool.status === "failed" ? <AlertCircle size={14} /> : <Check size={14} />}
        </span>
        <Wrench size={13} />
        <strong>{tool.label}</strong>
        <span>{tool.name}</span>
        <ChevronRight className="tool-chevron" size={14} />
      </summary>
      <div className="tool-detail">
        {Object.keys(tool.args).length ? <pre>{JSON.stringify(tool.args, null, 2)}</pre> : null}
        {tool.output ? <pre>{tool.output}</pre> : <p>{tool.status === "running" ? "Running…" : "Completed without output."}</p>}
      </div>
    </details>
  );
}

function PlanPanel({ project }: { project: ProjectSnapshot }): React.JSX.Element {
  if (!project.plan.length) {
    return <EmptyState icon={CheckSquare2} title="No active plan" detail="The agent's structured plan will appear here." />;
  }
  return (
    <ol className="plan-list">
      {project.plan.map((item, index) => (
        <li className={item.status} key={`${index}-${item.text}`}>
          {item.status === "completed" ? <CheckCircle2 size={15} /> : item.status === "in_progress" ? <CircleDot size={15} /> : <Circle size={15} />}
          <span>{item.text}</span>
        </li>
      ))}
    </ol>
  );
}

function ChangesPanel({ changes }: { changes: ChangedFile[] }): React.JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string>();
  const selected = changes.find((change) => change.path === selectedPath) ?? changes[0];
  useEffect(() => {
    if (!changes.some((change) => change.path === selectedPath)) setSelectedPath(changes[0]?.path);
  }, [changes, selectedPath]);

  if (!changes.length) {
    return <EmptyState icon={GitCompareArrows} title="Working tree clean" detail="Changes made by you or the agent will appear here." />;
  }
  return (
    <div className="changes-panel">
      <div className="change-list">
        {changes.map((change) => (
          <button className={selected?.path === change.path ? "active" : ""} type="button" key={change.path} onClick={() => setSelectedPath(change.path)}>
            <span className={`change-status ${change.status}`}>{change.status.slice(0, 1).toUpperCase()}</span>
            <span className="change-path">{change.path}</span>
            <small className="additions">+{change.additions}</small>
            <small className="deletions">−{change.deletions}</small>
          </button>
        ))}
      </div>
      {selected ? (
        <div className="diff-preview">
          <div className="preview-heading"><FileCode2 size={13} /><span>{selected.path}</span></div>
          <pre>{selected.patch || "Binary file or no textual diff available."}</pre>
        </div>
      ) : null}
    </div>
  );
}

function TerminalPanel({ project }: { project: ProjectSnapshot }): React.JSX.Element {
  if (!project.terminals.length) {
    return <EmptyState icon={TerminalSquare} title="No commands yet" detail="Commands executed by the agent will stream here." />;
  }
  return (
    <div className="terminal-list">
      {project.terminals.map((terminal) => (
        <details className={`terminal-card ${terminal.status}`} key={terminal.id} open={terminal.status === "running"}>
          <summary>
            <span className="terminal-light" />
            <code>{terminal.command}</code>
            {terminal.status === "running" ? <LoaderCircle className="spin" size={13} /> : null}
          </summary>
          <div className="terminal-meta">{terminal.cwd}{terminal.exitCode === undefined ? "" : ` · exit ${terminal.exitCode}`}</div>
          <pre>{terminal.output || "Waiting for output…"}</pre>
        </details>
      ))}
    </div>
  );
}

function FileTreeNode({ node, depth, onOpen }: { node: FileNode; depth: number; onOpen: (node: FileNode) => void }): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1);
  if (node.kind === "directory") {
    return (
      <div className="file-tree-node">
        <button type="button" style={{ paddingLeft: 8 + depth * 13 }} onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={14} />
          <span>{node.name}</span>
        </button>
        {open ? node.children?.map((child) => <FileTreeNode key={child.path} node={child} depth={depth + 1} onOpen={onOpen} />) : null}
      </div>
    );
  }
  return (
    <button className="file-leaf" type="button" style={{ paddingLeft: 21 + depth * 13 }} onClick={() => onOpen(node)}>
      <File size={13} /><span>{node.name}</span>
    </button>
  );
}

function FilesPanel({ project }: { project: ProjectSnapshot }): React.JSX.Element {
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean }>();
  const [error, setError] = useState<string>();
  const openFile = async (node: FileNode): Promise<void> => {
    try {
      setError(undefined);
      setPreview(await window.suocode.request({ type: "read_file", path: node.path }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  if (!project.cwd) {
    return <EmptyState icon={Files} title="No project open" detail="Open a project to inspect its files." />;
  }
  return (
    <div className="files-panel">
      <div className="file-tree">
        {project.files.length ? project.files.map((node) => <FileTreeNode key={node.path} node={node} depth={0} onOpen={(item) => void openFile(item)} />) : <p className="panel-note">This folder is empty.</p>}
      </div>
      {preview || error ? (
        <div className="file-preview">
          <div className="preview-heading"><FileCode2 size={13} /><span>{preview?.path || "Unable to read file"}</span><button type="button" onClick={() => { setPreview(undefined); setError(undefined); }}><X size={13} /></button></div>
          <pre>{error || `${preview?.content || ""}${preview?.truncated ? "\n… file truncated …" : ""}`}</pre>
        </div>
      ) : null}
    </div>
  );
}

function SettingsDialog({ configuration, open, onClose, onSaved }: {
  configuration?: RuntimeConfiguration;
  open: boolean;
  onClose: () => void;
  onSaved: (configuration: RuntimeConfiguration) => void;
}): React.JSX.Element | null {
  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of configuration?.models ?? []) map.set(model.provider, model.providerName);
    return [...map].sort((a, b) => {
      const aConfigured = configuration?.configuredProviders.includes(a[0]) ? 1 : 0;
      const bConfigured = configuration?.configuredProviders.includes(b[0]) ? 1 : 0;
      return bConfigured - aConfigured || a[1].localeCompare(b[1]);
    });
  }, [configuration]);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [apiKey, setApiKey] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !configuration) return;
    const nextProvider = configuration.provider || configuration.configuredProviders[0] || providers[0]?.[0] || "";
    setProvider(nextProvider);
    const providerModels = configuration.models.filter((model) => model.provider === nextProvider);
    setModelId(configuration.modelId && providerModels.some((model) => model.id === configuration.modelId) ? configuration.modelId : providerModels[0]?.id || "");
    setThinkingLevel(configuration.thinkingLevel);
    setApiKey("");
    setModelSearch("");
    setError(undefined);
  }, [configuration, open, providers]);

  const models = useMemo(() => (configuration?.models ?? []).filter((model) =>
    model.provider === provider && (!modelSearch || `${model.name} ${model.id}`.toLowerCase().includes(modelSearch.toLowerCase())),
  ), [configuration, modelSearch, provider]);

  const chooseProvider = (value: string): void => {
    setProvider(value);
    const first = configuration?.models.find((model) => model.provider === value);
    setModelId(first?.id || "");
    setModelSearch("");
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!provider || !modelId) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await window.suocode.request<RuntimeConfiguration>({
        type: "configure_model",
        provider,
        modelId,
        thinkingLevel,
        apiKey: apiKey || undefined,
      });
      onSaved(next);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  const configured = configuration?.configuredProviders.includes(provider) ?? false;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><span className="settings-icon"><Settings size={16} /></span><div><h2 id="settings-title">Model settings</h2><p>Credentials are stored in SuoCode's private runtime directory.</p></div></div>
          <button className="icon-button" type="button" aria-label="Close settings" onClick={onClose}><X size={17} /></button>
        </header>
        <form onSubmit={(event) => void save(event)}>
          <label>Provider<select value={provider} onChange={(event) => chooseProvider(event.target.value)}>{providers.map(([id, name]) => <option value={id} key={id}>{name}{configuration?.configuredProviders.includes(id) ? " · configured" : ""}</option>)}</select></label>
          <label>Model<span className="model-search"><Search size={14} /><input value={modelSearch} placeholder="Filter models" onChange={(event) => setModelSearch(event.target.value)} /></span><select size={7} value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.id}{model.reasoning ? " · reasoning" : ""}</option>)}</select></label>
          <div className="settings-grid">
            <label>Thinking<select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel)}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option value={level} key={level}>{level}</option>)}</select></label>
            <label>API key<span className="secret-input"><KeyRound size={14} /><input type="password" value={apiKey} autoComplete="off" placeholder={configured ? "Configured — leave blank to keep" : "Paste provider API key"} onChange={(event) => setApiKey(event.target.value)} /></span></label>
          </div>
          {error ? <div className="settings-error"><AlertCircle size={14} />{error}</div> : null}
          <footer><span>{configured ? "Provider credential available" : "A credential is required before the first prompt."}</span><button className="primary-button" type="submit" disabled={saving || !provider || !modelId}>{saving ? <LoaderCircle className="spin" size={15} /> : null}Save</button></footer>
        </form>
      </section>
    </div>
  );
}

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<ProjectSelection | null>(loadStoredProject);
  const projectRef = useRef<ProjectSelection | null>(project);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [projectState, setProjectState] = useState<ProjectSnapshot>(EMPTY_PROJECT);
  const [configuration, setConfiguration] = useState<RuntimeConfiguration>();
  const [inspectorView, setInspectorView] = useState<InspectorView>("plan");
  const [draft, setDraft] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const applySnapshot = useCallback((next: SessionSnapshot): void => {
    setSnapshot(next);
    setMessages(next.messages);
    setTools(next.tools);
    setProjectState(next.project);
  }, []);

  const handleRuntimeEvent = useCallback((event: RuntimeEvent): void => {
    switch (event.type) {
      case "runtime_ready":
      case "configuration_updated":
        setConfiguration(event.configuration);
        break;
      case "sessions_updated":
        if (projectRef.current?.path === event.cwd) setSessions(event.sessions);
        break;
      case "session_snapshot":
        applySnapshot(event.snapshot);
        break;
      case "message_started":
      case "message_finished":
        setMessages((current) => upsertMessage(current, event.message));
        break;
      case "message_delta":
        setMessages((current) => {
          const index = current.findIndex((message) => message.id === event.id);
          if (index < 0) {
            return [...current, { id: event.id, role: "assistant", text: event.field === "text" ? event.delta : "", thinking: event.field === "thinking" ? event.delta : undefined, timestamp: Date.now(), status: "running" }];
          }
          const next = [...current];
          const message = next[index];
          next[index] = { ...message, [event.field]: `${event.field === "thinking" ? message.thinking || "" : message.text}${event.delta}`, status: "running" };
          return next;
        });
        break;
      case "tool_started":
      case "tool_updated":
      case "tool_finished":
        setTools((current) => upsertTool(current, event.tool));
        break;
      case "plan_updated":
        setProjectState((current) => ({ ...current, plan: event.plan }));
        break;
      case "project_updated":
        setProjectState(event.project);
        break;
      case "run_state":
        setSnapshot((current) => current ? { ...current, running: event.running } : current);
        break;
      case "runtime_error":
        setError(event.message);
        break;
      default:
        break;
    }
  }, [applySnapshot]);

  const activateProject = useCallback(async (selection: ProjectSelection): Promise<void> => {
    projectRef.current = selection;
    setProject(selection);
    setLoading(true);
    setError(undefined);
    setMessages([]);
    setTools([]);
    setProjectState({ ...EMPTY_PROJECT, cwd: selection.path });
    try {
      const existing = await window.suocode.request<SessionSummary[]>({ type: "list_sessions", cwd: selection.path });
      setSessions(existing);
      const next = existing[0]
        ? await window.suocode.request<SessionSnapshot>({ type: "open_session", cwd: selection.path, sessionPath: existing[0].path })
        : await window.suocode.request<SessionSnapshot>({ type: "create_session", cwd: selection.path });
      applySnapshot(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [applySnapshot]);

  useEffect(() => {
    document.documentElement.dataset.platform = window.suocode.platform;
    const unsubscribe = window.suocode.onRuntimeEvent(handleRuntimeEvent);
    void (async () => {
      try {
        const bootstrap = await window.suocode.request<RuntimeBootstrap>({ type: "bootstrap" });
        setConfiguration(bootstrap.configuration);
        const stored = loadStoredProject();
        if (stored) await activateProject(stored);
        else setLoading(false);
        if (!bootstrap.configuration.configuredProviders.length) setSettingsOpen(true);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      }
    })();
    return unsubscribe;
  }, [activateProject, handleRuntimeEvent]);

  useEffect(() => {
    const viewport = timelineRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, tools]);

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
  const modelConfigured = Boolean(
    snapshot?.model && configuration?.configuredProviders.includes(snapshot.model.provider),
  );
  const timeline = useMemo<TimelineItem[]>(() => [
    ...messages.filter((message) => message.role !== "tool" && message.text !== "").map((message) => ({ kind: "message" as const, timestamp: message.timestamp, message })),
    ...tools.map((tool) => ({ kind: "tool" as const, timestamp: tool.startedAt, tool })),
  ].sort((a, b) => a.timestamp - b.timestamp), [messages, tools]);

  const openProject = async (): Promise<void> => {
    const selection = await window.suocode.selectProject();
    if (!selection) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(selection));
    await activateProject(selection);
  };

  const startNewConversation = async (): Promise<void> => {
    if (!project) return;
    setLoading(true);
    setError(undefined);
    try {
      applySnapshot(await window.suocode.request<SessionSnapshot>({ type: "create_session", cwd: project.path }));
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const openConversation = async (session: SessionSummary): Promise<void> => {
    if (!project || session.id === activeConversation?.id) return;
    setLoading(true);
    setError(undefined);
    try {
      applySnapshot(await window.suocode.request<SessionSnapshot>({ type: "open_session", cwd: project.path, sessionPath: session.path }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const submitPrompt = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || !project || !snapshot) return;
    if (!modelConfigured) {
      setError("Choose a configured model before sending the first prompt.");
      setSettingsOpen(true);
      return;
    }
    setDraft("");
    setError(undefined);
    try {
      await window.suocode.request({ type: running ? "steer" : "prompt", text: prompt });
    } catch (caught) {
      setDraft(prompt);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const inspectorItems: Array<{ id: InspectorView; label: string; icon: typeof CheckSquare2; meta?: string }> = [
    { id: "plan", label: "Plan", icon: CheckSquare2, meta: projectState.plan.length ? String(projectState.plan.length) : undefined },
    { id: "changes", label: "Changes", icon: GitCompareArrows, meta: String(projectState.changes.length) },
    { id: "terminal", label: "Terminal", icon: TerminalSquare, meta: projectState.terminals.length ? String(projectState.terminals.length) : undefined },
    { id: "files", label: "Files", icon: Files },
  ];

  return (
    <>
      <main className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`}>
        <aside className="sidebar">
          <div className="window-drag sidebar-drag"><button className="icon-button no-drag sidebar-toggle" type="button" aria-label="Hide sidebar" onClick={() => setLeftOpen(false)}><PanelLeft size={17} /></button></div>
          <nav className="primary-nav"><button className="nav-button" type="button" disabled={!project} onClick={() => void startNewConversation()}><MessageSquarePlus size={18} strokeWidth={1.7} /><span>New chat</span><kbd>⌘N</kbd></button></nav>
          <section className="project-section">
            <div className="section-heading"><span>Projects</span><button className="icon-button" type="button" aria-label="Open project" onClick={() => void openProject()}><FolderOpen size={17} strokeWidth={1.7} /></button></div>
            {project ? (
              <div className="project-tree">
                <button className="project-row" type="button" onClick={() => void openProject()}><Folder size={17} strokeWidth={1.7} /><span>{project.name}</span><ChevronDown size={14} /></button>
                <div className="conversation-list">
                  {sessions.map((session) => <button className={`conversation-row ${session.id === activeConversation?.id ? "active" : ""}`} type="button" key={session.id} onClick={() => void openConversation(session)}><CircleDot size={12} strokeWidth={2} /><span>{session.title}</span><time>{relativeTime(session.updatedAt)}</time></button>)}
                  {!sessions.length ? <p className="empty-conversations">No conversations yet</p> : null}
                </div>
              </div>
            ) : (
              <button className="open-project-card" type="button" onClick={() => void openProject()}><span className="open-project-icon"><Plus size={16} /></span><span><strong>Open a project</strong><small>Choose a local folder</small></span></button>
            )}
          </section>
          <div className="sidebar-footer"><div className="brand-mark">S</div><div className="brand-copy"><strong>SuoCode</strong><span>{snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.name}` : "Local agent"}</span></div><button className="icon-button" type="button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={17} strokeWidth={1.7} /></button></div>
        </aside>

        <section className="conversation-pane">
          <header className="conversation-header window-drag">
            {!leftOpen ? <button className="icon-button no-drag" type="button" aria-label="Show sidebar" onClick={() => setLeftOpen(true)}><PanelLeft size={17} /></button> : null}
            <div className="conversation-title"><strong>{activeConversation?.title ?? "New chat"}</strong>{project ? <span>{project.name}</span> : null}</div>
            <div className="header-actions no-drag">
              {running ? <span className="run-indicator"><LoaderCircle className="spin" size={13} />Running</span> : snapshot ? <span className="run-indicator idle"><Check size={13} />Ready</span> : null}
              {!rightOpen ? <button className="icon-button" type="button" aria-label="Show project inspector" onClick={() => setRightOpen(true)}><PanelRight size={17} /></button> : null}
            </div>
          </header>

          <div className="conversation-body" ref={timelineRef}>
            {loading ? <div className="loading-state"><LoaderCircle className="spin" size={20} /><span>Loading workspace…</span></div> : timeline.length ? <div className="timeline">{timeline.map((item) => item.kind === "message" ? <MessageView key={`message-${item.message.id}`} message={item.message} /> : <ToolView key={`tool-${item.tool.id}`} tool={item.tool} />)}</div> : <div className="empty-chat"><div className="empty-chat-mark">S</div><h1>What do you want to build?</h1><p>{project ? `SuoCode is ready in ${project.name}.` : "Open a project to start a new agent session."}</p></div>}
          </div>

          <div className="composer-wrap">
            {error ? <div className="error-banner"><AlertCircle size={14} /><span>{error}</span><button type="button" onClick={() => setError(undefined)}><X size={13} /></button></div> : null}
            <form className="composer" onSubmit={(event) => void submitPrompt(event)}>
              <textarea ref={inputRef} value={draft} rows={2} aria-label="Message SuoCode" placeholder={project ? (running ? "Steer the running agent" : "Ask SuoCode to work on this project") : "Open a project to begin"} disabled={!project || !snapshot || loading} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} />
              <div className="composer-toolbar">
                <button className="agent-mode" type="button" onClick={() => setSettingsOpen(true)}><CircleDot size={13} /><span>{snapshot?.model ? snapshot.model.name : "Choose model"}</span><ChevronDown size={12} /></button>
                {running ? <button className="stop-button" type="button" aria-label="Stop agent" onClick={() => void window.suocode.request({ type: "abort" })}><Square size={12} fill="currentColor" /></button> : null}
                <button className="send-button" type="submit" aria-label={running ? "Steer agent" : "Send message"} disabled={!project || !snapshot || !draft.trim()}><ArrowUp size={17} strokeWidth={2.2} /></button>
              </div>
            </form>
            <div className="workspace-status"><span><FileCode2 size={14} />{project?.path ?? "No project selected"}</span><span>{snapshot?.thinkingLevel ? `Thinking: ${snapshot.thinkingLevel}` : ""}</span></div>
          </div>
        </section>

        <aside className="inspector-pane">
          <div className="inspector-header window-drag"><span>On project</span><div className="inspector-actions no-drag"><button className="icon-button" type="button" aria-label="Refresh project" disabled={!snapshot} onClick={() => void window.suocode.request({ type: "refresh_project" })}><RefreshCw size={15} /></button><button className="icon-button" type="button" aria-label="Hide project inspector" onClick={() => setRightOpen(false)}><PanelRight size={17} /></button></div></div>
          <nav className="inspector-nav">{inspectorItems.map((item) => { const Icon = item.icon; return <button className={item.id === inspectorView ? "active" : ""} type="button" key={item.id} onClick={() => setInspectorView(item.id)}><Icon size={17} strokeWidth={1.7} /><span>{item.label}</span>{item.meta ? <small>{item.meta}</small> : null}</button>; })}</nav>
          <section className="inspector-content">
            {inspectorView === "plan" ? <PlanPanel project={projectState} /> : null}
            {inspectorView === "changes" ? <ChangesPanel changes={projectState.changes} /> : null}
            {inspectorView === "terminal" ? <TerminalPanel project={projectState} /> : null}
            {inspectorView === "files" ? <FilesPanel project={projectState} /> : null}
          </section>
        </aside>
      </main>
      <SettingsDialog configuration={configuration} open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={setConfiguration} />
    </>
  );
}
