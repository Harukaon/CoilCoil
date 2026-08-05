import {
  AlertCircle,
  ArrowUp,
  Check,
  CheckCircle2,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
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
import * as Popover from "@radix-ui/react-popover";
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
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
  ModelOption,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
  ToolRun,
} from "@suocode/runtime-protocol";

type InspectorView = "plan" | "changes" | "terminal" | "files";
type TimelineItem =
  | { kind: "message"; order: number; message: ChatMessage }
  | { kind: "tools"; order: number; tools: ToolRun[] };
type ConversationTimelineItem =
  | { kind: "user"; order: number; message: ChatMessage }
  | { kind: "agent"; order: number; items: TimelineItem[] };

const PROJECT_STORAGE_KEY = "suocode.selected-project";
const LEFT_WIDTH_KEY = "suocode.left-panel-width";
const RIGHT_WIDTH_KEY = "suocode.right-panel-width";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "刚刚";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天` : new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function storedWidth(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function thinkingLevelForModel(model: ModelOption | undefined, requested: ThinkingLevel): ThinkingLevel {
  const available: ThinkingLevel[] = model?.supportedThinkingLevels?.length ? model.supportedThinkingLevels : ["off"];
  if (available.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    if (available.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    if (available.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
  }
  return available[0] ?? "off";
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
        <div className="message-label">你</div>
        <div className="user-bubble">{message.text}</div>
      </article>
    );
  }

  return <AssistantSegment message={message} />;
}

function AssistantSegment({ message }: { message: ChatMessage }): React.JSX.Element {
  return (
    <div className={`assistant-segment assistant-message ${message.isError ? "error" : ""}`}>
      {message.thinking?.trim() ? <details className="thinking-block"><summary>Reasoning</summary><div>{message.thinking}</div></details> : null}
      {message.text ? <Markdown>{message.text}</Markdown> : null}
    </div>
  );
}

function ModelPicker({ configuration, currentModel, open, busy, onOpenChange, onSelect, onOpenSettings }: {
  configuration?: RuntimeConfiguration;
  currentModel?: SessionSnapshot["model"];
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (model: ModelOption) => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const grouped = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of configuration?.models ?? []) {
      if (!model.configured) continue;
      if (query && !`${model.providerName} ${model.provider} ${model.name} ${model.id}`.toLowerCase().includes(query)) continue;
      const group = grouped.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      grouped.set(model.provider, group);
    }
    return [...grouped.entries()];
  }, [configuration, search]);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button className="agent-mode" type="button"><CircleDot size={13} /><span>{currentModel?.name ?? "选择模型"}</span><ChevronDown size={12} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="model-popover" side="top" align="start" sideOffset={8} collisionPadding={12} avoidCollisions>
          <div className="model-popover-search"><Search size={14} /><input autoFocus value={search} placeholder="搜索模型" onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="model-popover-list">
            {groups.map(([provider, group]) => <section className="model-provider-group" key={provider}>
              <h3>{group.name}</h3>
              {group.models.map((model) => {
                const active = currentModel?.provider === model.provider && currentModel.id === model.id;
                return <button className={active ? "active" : ""} type="button" disabled={busy} key={`${model.provider}/${model.id}`} onClick={() => onSelect(model)}><span><strong>{model.name}</strong><small>{model.id}</small></span>{active ? <Check size={14} /> : null}</button>;
              })}
            </section>)}
            {!groups.length ? <div className="model-popover-empty">{configuration?.configuredProviders.length ? "没有匹配的模型" : "尚未配置模型服务商"}</div> : null}
          </div>
          <button className="model-settings-link" type="button" onClick={onOpenSettings}><Settings size={14} /><span>模型与服务商设置</span></button>
          <Popover.Arrow className="model-popover-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function lineStats(tool: ToolRun): { additions: number; deletions: number } {
  const args = tool.args;
  const added = String(args.newText ?? args.new_string ?? args.content ?? "");
  const removed = String(args.oldText ?? args.old_string ?? "");
  return {
    additions: added ? added.split("\n").length : 0,
    deletions: removed ? removed.split("\n").length : 0,
  };
}

function toolSummary(tools: ToolRun[]): string {
  const edited = new Set<string>();
  let explored = 0;
  let searches = 0;
  let commands = 0;
  let other = 0;
  for (const tool of tools) {
    const path = String(tool.args.path ?? "");
    if (["edit", "write"].includes(tool.name)) edited.add(path || tool.id);
    else if (["read", "ls", "find"].includes(tool.name)) explored += 1;
    else if (tool.name === "grep") searches += 1;
    else if (["bash", "terminal"].includes(tool.name)) commands += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (edited.size) parts.push(`编辑了 ${edited.size} 个文件`);
  if (explored) parts.push(`查看了 ${explored} 个文件`);
  if (searches) parts.push(`搜索 ${searches} 次`);
  if (commands) parts.push(`运行了 ${commands} 个命令`);
  if (other) parts.push(`调用了 ${other} 个工具`);
  return parts.join("，") || `调用了 ${tools.length} 个工具`;
}

function ToolGroupView({ tools }: { tools: ToolRun[] }): React.JSX.Element {
  const stats = tools.reduce((total, tool) => {
    const next = lineStats(tool);
    return { additions: total.additions + next.additions, deletions: total.deletions + next.deletions };
  }, { additions: 0, deletions: 0 });
  const running = tools.some((tool) => tool.status === "running");
  return (
    <details className="tool-activity" open={running}>
      <summary>
        <span>{running ? "正在执行工具" : toolSummary(tools)}</span>
        {stats.additions ? <b className="additions">+{stats.additions}</b> : null}
        {stats.deletions ? <b className="deletions">-{stats.deletions}</b> : null}
        <ChevronRight className="tool-chevron" size={14} />
      </summary>
      <div className="tool-activity-list">
        {tools.map((tool) => {
          const itemStats = lineStats(tool);
          return <details className={`tool-activity-row ${tool.status}`} key={tool.id}>
            <summary><code>{tool.name}</code><span>{tool.label}</span>{itemStats.additions ? <b className="additions">+{itemStats.additions}</b> : null}{itemStats.deletions ? <b className="deletions">-{itemStats.deletions}</b> : null}{tool.status === "running" ? <LoaderCircle className="spin" size={13} /> : tool.status === "failed" ? <AlertCircle size={13} /> : null}</summary>
            {tool.output || Object.keys(tool.args).length ? <pre>{tool.output || JSON.stringify(tool.args, null, 2)}</pre> : null}
          </details>;
        })}
      </div>
    </details>
  );
}

function AgentTurnView({ items, modelName }: { items: TimelineItem[]; modelName: string }): React.JSX.Element {
  return (
    <article className="agent-turn">
      <div className="message-label">{modelName}</div>
      <div className="agent-turn-content">
        {items.map((item) => item.kind === "message"
          ? <AssistantSegment key={`message-${item.message.id}`} message={item.message} />
          : <ToolGroupView key={`tools-${item.order}`} tools={item.tools} />)}
      </div>
    </article>
  );
}

function ComposerPlan({ plan }: { plan: ProjectSnapshot["plan"] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true);
  if (!plan.length) return null;
  const completed = plan.filter((item) => item.status === "completed").length;
  return (
    <section className={`composer-plan ${expanded ? "expanded" : "collapsed"}`} aria-label="Agent 计划">
      <button className="composer-plan-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><span>计划</span><small>{completed}/{plan.length}</small>{expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
      <div className="composer-plan-body"><ol>
          {plan.map((item, index) => <li className={item.status} key={`${index}-${item.text}`}>
            {item.status === "completed" ? <CheckCircle2 size={14} /> : item.status === "in_progress" ? <CircleDot size={14} /> : <Circle size={14} />}
            <span>{item.text}</span>
          </li>)}
      </ol></div>
    </section>
  );
}

function PlanPanel({ project }: { project: ProjectSnapshot }): React.JSX.Element {
  if (!project.plan.length) {
    return <EmptyState icon={CheckSquare2} title="暂无计划" detail="Agent 的结构化计划会显示在这里。" />;
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
    return <EmptyState icon={GitCompareArrows} title="工作区干净" detail="你或 Agent 所做的修改会显示在这里。" />;
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
          <pre>{selected.patch || "二进制文件或暂无文本差异。"}</pre>
        </div>
      ) : null}
    </div>
  );
}

function TerminalPanel({ project }: { project: ProjectSnapshot }): React.JSX.Element {
  if (!project.terminals.length) {
    return <EmptyState icon={TerminalSquare} title="暂无命令" detail="Agent 执行的命令会实时显示在这里。" />;
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
          <div className="terminal-meta">{terminal.cwd}{terminal.exitCode === undefined ? "" : ` · 退出码 ${terminal.exitCode}`}</div>
          <pre>{terminal.output || "等待输出…"}</pre>
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
    return <EmptyState icon={Files} title="未打开项目" detail="打开项目后即可查看文件。" />;
  }
  return (
    <div className="files-panel">
      <div className="file-tree">
        {project.files.length ? project.files.map((node) => <FileTreeNode key={node.path} node={node} depth={0} onOpen={(item) => void openFile(item)} />) : <p className="panel-note">此文件夹为空。</p>}
      </div>
      {preview || error ? (
        <div className="file-preview">
          <div className="preview-heading"><FileCode2 size={13} /><span>{preview?.path || "无法读取文件"}</span><button type="button" onClick={() => { setPreview(undefined); setError(undefined); }}><X size={13} /></button></div>
          <pre>{error || `${preview?.content || ""}${preview?.truncated ? "\n… 文件内容已截断 …" : ""}`}</pre>
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
    const nextModel = providerModels.find((model) => model.id === configuration.modelId) ?? providerModels[0];
    setModelId(nextModel?.id || "");
    setThinkingLevel(thinkingLevelForModel(nextModel, configuration.thinkingLevel));
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
    setThinkingLevel((current) => thinkingLevelForModel(first, current));
    setModelSearch("");
  };

  const chooseModel = (value: string): void => {
    setModelId(value);
    const model = configuration?.models.find((item) => item.provider === provider && item.id === value);
    setThinkingLevel((current) => thinkingLevelForModel(model, current));
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
  const selectedModel = configuration?.models.find((model) => model.provider === provider && model.id === modelId);
  const availableThinkingLevels: ThinkingLevel[] = selectedModel?.supportedThinkingLevels?.length ? selectedModel.supportedThinkingLevels : ["off"];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><span className="settings-icon"><Settings size={16} /></span><div><h2 id="settings-title">模型设置</h2><p>凭据保存在 SuoCode 的私有运行时目录中。</p></div></div>
          <button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={17} /></button>
        </header>
        <form onSubmit={(event) => void save(event)}>
          <label>服务商<select value={provider} onChange={(event) => chooseProvider(event.target.value)}>{providers.map(([id, name]) => <option value={id} key={id}>{name}{configuration?.configuredProviders.includes(id) ? " · 已配置" : ""}</option>)}</select></label>
          <label>模型<span className="model-search"><Search size={14} /><input value={modelSearch} placeholder="筛选模型" onChange={(event) => setModelSearch(event.target.value)} /></span><select size={7} value={modelId} onChange={(event) => chooseModel(event.target.value)}>{models.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.id}{model.reasoning ? " · reasoning" : ""}</option>)}</select></label>
          <div className="settings-grid">
            <label>Thinking<select value={thinkingLevel} disabled={availableThinkingLevels.length === 1} onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel)}>{availableThinkingLevels.map((level) => <option value={level} key={level}>{level}</option>)}</select></label>
            <label>API 密钥<span className="secret-input"><KeyRound size={14} /><input type="password" value={apiKey} autoComplete="off" placeholder={configured ? "已配置，留空可保留" : "粘贴服务商 API 密钥"} onChange={(event) => setApiKey(event.target.value)} /></span></label>
          </div>
          {error ? <div className="settings-error"><AlertCircle size={14} />{error}</div> : null}
          <footer><span>{configured ? "服务商凭据可用" : "首次发送消息前需要配置凭据。"}</span><button className="primary-button" type="submit" disabled={saving || !provider || !modelId}>{saving ? <LoaderCircle className="spin" size={15} /> : null}保存</button></footer>
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
  const [rightOpen, setRightOpen] = useState(false);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [leftWidth, setLeftWidth] = useState(() => storedWidth(LEFT_WIDTH_KEY, 268));
  const [rightWidth, setRightWidth] = useState(() => storedWidth(RIGHT_WIDTH_KEY, 352));
  const [agentPhase, setAgentPhase] = useState<"思考" | "回复" | "工具">();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelChanging, setModelChanging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
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
      case "project_updated":
        setProjectState(event.project);
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
    projectRef.current = selection;
    setProject(selection);
    setProjectExpanded(true);
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
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  }, [draft]);

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
  const timeline = useMemo<ConversationTimelineItem[]>(() => {
    const ordered = [
      ...messages.filter((message) => message.role !== "tool" && (message.text || message.thinking)).map((message) => ({ kind: "message" as const, order: message.order, message })),
      ...tools.map((tool) => ({ kind: "tool" as const, order: tool.order, tool })),
    ].sort((a, b) => a.order - b.order);
    const grouped: TimelineItem[] = [];
    for (const item of ordered) {
      if (item.kind === "tool") {
        const previous = grouped.at(-1);
        if (previous?.kind === "tools") previous.tools.push(item.tool);
        else grouped.push({ kind: "tools", order: item.order, tools: [item.tool] });
      } else grouped.push(item);
    }
    const turns: ConversationTimelineItem[] = [];
    for (const item of grouped) {
      if (item.kind === "message" && item.message.role === "user") {
        turns.push({ kind: "user", order: item.order, message: item.message });
        continue;
      }
      const previous = turns.at(-1);
      if (previous?.kind === "agent") previous.items.push(item);
      else turns.push({ kind: "agent", order: item.order, items: [item] });
    }
    return turns;
  }, [messages, tools]);

  const beginResize = (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    let finalWidth = startWidth;
    document.body.classList.add("resizing-panels");
    const move = (pointer: PointerEvent): void => {
      const raw = side === "left" ? startWidth + pointer.clientX - startX : startWidth + startX - pointer.clientX;
      const width = Math.round(Math.max(side === "left" ? 210 : 280, Math.min(side === "left" ? 420 : 560, raw)));
      finalWidth = width;
      if (side === "left") setLeftWidth(width); else setRightWidth(width);
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      window.localStorage.setItem(side === "left" ? LEFT_WIDTH_KEY : RIGHT_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

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
      setError("发送第一条消息前，请先选择并配置模型。");
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
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const selectComposerModel = async (model: ModelOption): Promise<void> => {
    if (!configuration || modelChanging) return;
    setModelChanging(true);
    setError(undefined);
    try {
      const next = await window.suocode.request<RuntimeConfiguration>({
        type: "configure_model",
        provider: model.provider,
        modelId: model.id,
        thinkingLevel: configuration.thinkingLevel,
      });
      setConfiguration(next);
      setModelMenuOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setModelChanging(false);
    }
  };

  const inspectorItems: Array<{ id: InspectorView; label: string; icon: typeof CheckSquare2; meta?: string }> = [
    { id: "plan", label: "计划", icon: CheckSquare2, meta: projectState.plan.length ? String(projectState.plan.length) : undefined },
    { id: "changes", label: "变更", icon: GitCompareArrows, meta: String(projectState.changes.length) },
    { id: "terminal", label: "终端", icon: TerminalSquare, meta: projectState.terminals.length ? String(projectState.terminals.length) : undefined },
    { id: "files", label: "文件", icon: Files },
  ];

  return (
    <>
      <main className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`} style={{ "--sidebar-width": `${leftWidth}px`, "--inspector-width": `${rightWidth}px` } as CSSProperties}>
        <aside className="sidebar">
          <div className="window-drag sidebar-drag"><button className="icon-button no-drag sidebar-toggle" type="button" aria-label="收起侧栏" onClick={() => setLeftOpen(false)}><PanelLeft size={17} /></button></div>
          <nav className="primary-nav"><button className="nav-button" type="button" disabled={!project} onClick={() => void startNewConversation()}><MessageSquarePlus size={18} strokeWidth={1.7} /><span>新建对话</span><kbd>⌘N</kbd></button></nav>
          <section className="project-section">
            <div className="section-heading"><span>项目</span><button className="icon-button" type="button" aria-label="打开项目" onClick={() => void openProject()}><FolderOpen size={15} strokeWidth={1.7} /></button></div>
            {project ? (
              <div className="project-tree">
                <button className="project-row" type="button" aria-expanded={projectExpanded} onClick={() => setProjectExpanded((value) => !value)}><Folder size={15} strokeWidth={1.7} /><span>{project.name}</span>{projectExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                {projectExpanded ? <div className="conversation-list">
                  {sessions.map((session) => <button className={`conversation-row ${session.id === activeConversation?.id ? "active" : ""}`} type="button" key={session.id} onClick={() => void openConversation(session)}><CircleDot size={11} strokeWidth={2} /><span>{session.title}</span><time>{relativeTime(session.updatedAt)}</time></button>)}
                  {!sessions.length ? <p className="empty-conversations">暂无对话</p> : null}
                </div> : null}
              </div>
            ) : (
              <button className="open-project-card" type="button" onClick={() => void openProject()}><span className="open-project-icon"><Plus size={14} /></span><span><strong>打开项目</strong><small>选择本地文件夹</small></span></button>
            )}
          </section>
          <div className="sidebar-footer"><div className="brand-mark">S</div><div className="brand-copy"><strong>SuoCode</strong><span>{snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.name}` : "本地 Agent"}</span></div><button className="icon-button" type="button" aria-label="设置" onClick={() => setSettingsOpen(true)}><Settings size={17} strokeWidth={1.7} /></button></div>
        </aside>
        {leftOpen ? <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("left", event)} /> : null}

        <section className="conversation-pane">
          <header className="conversation-header window-drag">
            {!leftOpen ? <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={() => setLeftOpen(true)}><PanelLeft size={17} /></button> : null}
            <div className="conversation-title"><strong>{activeConversation?.title ?? "新建对话"}</strong>{project ? <span>{project.name}</span> : null}</div>
            <div className="header-actions no-drag">
              {!rightOpen ? <button className="icon-button" type="button" aria-label="展开作业栏" onClick={() => setRightOpen(true)}><PanelRight size={17} /></button> : null}
            </div>
          </header>

          <div className="conversation-body" ref={timelineRef}>
            {loading ? <div className="loading-state"><LoaderCircle className="spin" size={20} /><span>正在加载工作区…</span></div> : timeline.length || running ? <div className="timeline">{timeline.map((item) => item.kind === "user" ? <MessageView key={`user-${item.message.id}`} message={item.message} /> : <AgentTurnView key={`agent-${item.order}`} items={item.items} modelName={snapshot?.model?.name ?? "Agent"} />)}{running ? <div className="agent-activity"><LoaderCircle className="spin" size={14} /><span>{agentPhase === "工具" ? "正在执行工具…" : agentPhase === "回复" ? "正在回复…" : "正在思考…"}</span></div> : null}</div> : <div className="empty-chat"><div className="empty-chat-mark">S</div><h1>你想构建什么？</h1><p>{project ? `SuoCode 已在 ${project.name} 中准备就绪。` : "打开项目以开始新的 Agent 会话。"}</p></div>}
          </div>

          <div className="composer-wrap">
            {error ? <div className="error-banner"><AlertCircle size={14} /><span>{error}</span><button type="button" onClick={() => setError(undefined)}><X size={13} /></button></div> : null}
            <div className="composer-stack">
              <ComposerPlan plan={projectState.plan} />
              <form className="composer" onSubmit={(event) => void submitPrompt(event)}>
                <textarea ref={inputRef} value={draft} rows={3} aria-label="发送消息给 SuoCode" placeholder={project ? (running ? "补充指令…" : "让 SuoCode 处理这个项目…") : "请先打开项目"} disabled={!project || !snapshot || loading} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={handleComposerKeyDown} />
                <div className="composer-toolbar">
                  <ModelPicker configuration={configuration} currentModel={snapshot?.model} open={modelMenuOpen} busy={modelChanging} onOpenChange={setModelMenuOpen} onSelect={(model) => void selectComposerModel(model)} onOpenSettings={() => { setModelMenuOpen(false); setSettingsOpen(true); }} />
                  {running ? <button className="stop-button" type="button" aria-label="停止 Agent" onClick={() => void window.suocode.request({ type: "abort" })}><Square size={12} fill="currentColor" /></button> : null}
                  <button className="send-button" type="submit" aria-label={running ? "补充指令" : "发送消息"} disabled={!project || !snapshot || !draft.trim()}><ArrowUp size={17} strokeWidth={2.2} /></button>
                </div>
              </form>
            </div>
            <div className="workspace-status"><span><FileCode2 size={14} />{project?.path ?? "未选择项目"}</span></div>
          </div>
        </section>

        <aside className="inspector-pane">
          <div className="inspector-header window-drag"><span>项目作业</span><div className="inspector-actions no-drag"><button className="icon-button" type="button" aria-label="刷新项目" disabled={!snapshot} onClick={() => void window.suocode.request({ type: "refresh_project" })}><RefreshCw size={15} /></button><button className="icon-button" type="button" aria-label="收起作业栏" onClick={() => setRightOpen(false)}><PanelRight size={17} /></button></div></div>
          <nav className="inspector-nav">{inspectorItems.map((item) => { const Icon = item.icon; return <button className={item.id === inspectorView ? "active" : ""} type="button" key={item.id} onClick={() => setInspectorView(item.id)}><Icon size={17} strokeWidth={1.7} /><span>{item.label}</span>{item.meta ? <small>{item.meta}</small> : null}</button>; })}</nav>
          <section className="inspector-content">
            {inspectorView === "plan" ? <PlanPanel project={projectState} /> : null}
            {inspectorView === "changes" ? <ChangesPanel changes={projectState.changes} /> : null}
            {inspectorView === "terminal" ? <TerminalPanel project={projectState} /> : null}
            {inspectorView === "files" ? <FilesPanel project={projectState} /> : null}
          </section>
        </aside>
        {rightOpen ? <div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("right", event)} /> : null}
      </main>
      <SettingsDialog configuration={configuration} open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={setConfiguration} />
    </>
  );
}
