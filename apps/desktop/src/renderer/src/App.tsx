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
  MoreHorizontal,
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { ClipboardEvent as ReactClipboardEvent, CSSProperties, DragEvent as ReactDragEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChangedFile,
  ChatMessage,
  ContextUsage,
  FileNode,
  ProjectSelection,
  ProjectSnapshot,
  RuntimeBootstrap,
  RuntimeConfiguration,
  RuntimeEvent,
  ResponseMetrics,
  ModelOption,
  PromptImage,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
  TokenUsage,
  ToolRun,
} from "@suocode/runtime-protocol";

type InspectorView = "files";
type SessionActivity = { runtimeId?: string; running: boolean; unread: boolean };
type TimelineItem =
  | { kind: "message"; order: number; message: ChatMessage }
  | { kind: "tools"; order: number; tools: ToolRun[] };
type ConversationTimelineItem =
  | { kind: "user"; order: number; message: ChatMessage }
  | { kind: "agent"; order: number; items: TimelineItem[] };
type ActivityEntry =
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolRun };

const LEGACY_PROJECT_STORAGE_KEY = "suocode.selected-workspace";
const PROJECTS_STORAGE_KEY = "suocode.mounted-projects";
const ACTIVE_PROJECT_STORAGE_KEY = "suocode.active-project";
const LEFT_WIDTH_KEY = "suocode.left-panel-width";
const RIGHT_WIDTH_KEY = "suocode.right-panel-width";
const REWIND_WARNING_DISMISSED_KEY = "suocode.rewind-warning-dismissed";
const MINIMUM_CONVERSATION_WIDTH = 315;
const MINIMUM_PANEL_WIDTH = 40;
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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

function pathLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || path;
}

function absoluteProjectPath(root: string, value: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return value;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${value.replace(/^[\\/]+/, "")}`;
}

function quotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function imageDataUrl(image: PromptImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

async function clipboardImage(file: globalThis.File): Promise<PromptImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取粘贴的图片。"));
    reader.readAsDataURL(file);
  });
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name || "粘贴的图片",
    mimeType: file.type || "image/png",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}

function uniqueProjects(projects: ProjectSelection[]): ProjectSelection[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    if (seen.has(project.path)) return false;
    seen.add(project.path);
    return true;
  });
}

function formatMetricDuration(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "—" : `${(milliseconds / 1_000).toFixed(2)}s`;
}

function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return "—";
  if (tokens < 1_000) return String(Math.round(tokens));
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function performanceGrade(metrics: ResponseMetrics): "excellent" | "good" | "fair" | "slow" {
  const firstToken = metrics.firstTokenMs ?? Number.POSITIVE_INFINITY;
  const speed = metrics.averageTokensPerSecond ?? 0;
  if (firstToken <= 2_000 && speed >= 50) return "excellent";
  if (firstToken <= 5_000 && speed >= 25) return "good";
  if (firstToken <= 20_000 && speed >= 10) return "fair";
  return "slow";
}

function SuoLoader({ size = 14 }: { size?: number }): React.JSX.Element {
  return <span className="suo-loader" style={{ "--loader-size": `${size}px` } as CSSProperties}><i /><i /><i /></span>;
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

function truncateTitle(value: string, maximum = 10): string {
  const characters = Array.from(value);
  return characters.length > maximum ? `${characters.slice(0, maximum).join("")}…` : value;
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

function MessageView({ message, disabled, onRewind }: {
  message: ChatMessage;
  disabled: boolean;
  onRewind: (message: ChatMessage, text: string) => Promise<void>;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(message.text);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  useEffect(() => setValue(message.text), [message.text]);

  useEffect(() => {
    if (!editing) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (confirmOpen || editorRef.current?.contains(event.target as Node)) return;
      setEditing(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [confirmOpen, editing]);

  const proceed = (remember: boolean): void => {
    const prompt = value.trim();
    if (!prompt || !message.entryId) return;
    if (remember) window.localStorage.setItem(REWIND_WARNING_DISMISSED_KEY, "true");
    setConfirmOpen(false);
    setEditing(false);
    void onRewind(message, prompt);
  };

  const requestRewind = (): void => {
    if (!value.trim() || !message.entryId) return;
    if (window.localStorage.getItem(REWIND_WARNING_DISMISSED_KEY) === "true") proceed(false);
    else setConfirmOpen(true);
  };

  if (message.role === "user") {
    return (
      <article className="timeline-message user-message">
        <div className="message-label">你</div>
        {editing ? (
          <div className="user-message-editor-shell" ref={editorRef}>
            <textarea
              className="user-bubble user-message-editor"
              autoFocus
              value={value}
              aria-label="编辑历史消息"
              placeholder="编辑历史消息"
              onChange={(event) => setValue(event.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(event) => {
                if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  requestRewind();
                }
              }}
            />
            {value !== message.text ? <small className="history-edit-warning">修改历史消息会改变后续上下文，可能降低本次请求的提示缓存命中率。</small> : null}
          </div>
        ) : (
          <button
            className="user-bubble user-bubble-button"
            type="button"
            title={message.entryId ? "点击编辑并从这里重新开始" : undefined}
            data-prompt-value={value}
            disabled={disabled || !message.entryId}
            onClick={() => setEditing(true)}
          >
            {value ? <span>{value}</span> : null}
            {message.images?.length ? <span className="message-images">{message.images.map((image) => <img src={imageDataUrl(image)} alt={image.name ?? "附加图片"} key={image.id ?? image.data.slice(0, 24)} />)}</span> : null}
          </button>
        )}
        {confirmOpen ? (
          <div className="modal-backdrop rewind-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmOpen(false); }}>
            <section className="rewind-dialog" role="dialog" aria-modal="true" aria-labelledby={`rewind-title-${message.id}`}>
              <h2 id={`rewind-title-${message.id}`}>从这里重新开始？</h2>
              <p>对话将从这条消息重新开始。当前工作区中已经产生的文件修改不会被恢复。</p>
              <footer>
                <button type="button" onClick={() => setConfirmOpen(false)}>取消</button>
                <button type="button" onClick={() => proceed(true)}>不再提醒</button>
                <button className="primary-button" type="button" onClick={() => proceed(false)}>继续</button>
              </footer>
            </section>
          </div>
        ) : null}
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

function toolSummary(tools: ToolRun[], thinkingCount: number): string {
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
  if (thinkingCount) parts.push(`思考了 ${thinkingCount} 次`);
  if (edited.size) parts.push(`编辑了 ${edited.size} 个文件`);
  if (explored) parts.push(`查看了 ${explored} 个文件`);
  if (searches) parts.push(`搜索 ${searches} 次`);
  if (commands) parts.push(`运行了 ${commands} 个命令`);
  if (other) parts.push(`调用了 ${other} 个工具`);
  return parts.join("，") || `调用了 ${tools.length} 个工具`;
}

function toolArgumentsText(tool: ToolRun): string {
  const args = tool.args;
  const path = String(args.path ?? args.filePath ?? "");
  if (tool.name === "bash") return String(args.command ?? "");
  if (tool.name === "read") {
    const range = [args.offset !== undefined ? `offset=${String(args.offset)}` : "", args.limit !== undefined ? `limit=${String(args.limit)}` : ""].filter(Boolean).join(" · ");
    return [path, range].filter(Boolean).join("\n");
  }
  if (tool.name === "grep") return [`pattern: ${String(args.pattern ?? "")}`, path ? `path: ${path}` : "", args.glob ? `glob: ${String(args.glob)}` : ""].filter(Boolean).join("\n");
  if (tool.name === "find") return [`pattern: ${String(args.pattern ?? "")}`, path ? `path: ${path}` : ""].filter(Boolean).join("\n");
  if (tool.name === "ls") return path || ".";
  if (tool.name === "write") return [path, String(args.content ?? "")].filter(Boolean).join("\n\n");
  if (tool.name === "edit") {
    const oldText = String(args.oldText ?? args.old_string ?? "");
    const newText = String(args.newText ?? args.new_string ?? "");
    return [path, oldText ? `--- 原内容\n${oldText}` : "", newText ? `+++ 新内容\n${newText}` : ""].filter(Boolean).join("\n\n");
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function ToolExecutionDetails({ tool }: { tool: ToolRun }): React.JSX.Element | null {
  const input = toolArgumentsText(tool).trim();
  const output = tool.output.trim();
  if (!input && !output) return null;
  return (
    <div className="tool-execution-details">
      {input ? <section><span>调用参数</span><pre>{input}</pre></section> : null}
      {output ? <section><span>{tool.status === "failed" ? "错误" : "执行结果"}</span><pre>{output}</pre></section> : null}
    </div>
  );
}

function ActivityGroupView({ entries }: { entries: ActivityEntry[] }): React.JSX.Element {
  const tools = entries.flatMap((entry) => entry.kind === "tool" ? [entry.tool] : []);
  const thinkingCount = entries.filter((entry) => entry.kind === "thinking").length;
  const stats = tools.reduce((total, tool) => {
    const next = lineStats(tool);
    return { additions: total.additions + next.additions, deletions: total.deletions + next.deletions };
  }, { additions: 0, deletions: 0 });
  const running = tools.some((tool) => tool.status === "running");
  return (
    <details className="tool-activity" open={running}>
      <summary>
        <span>{running ? "正在执行工具" : toolSummary(tools, thinkingCount)}</span>
        {stats.additions ? <b className="additions">+{stats.additions}</b> : null}
        {stats.deletions ? <b className="deletions">-{stats.deletions}</b> : null}
        <ChevronRight className="tool-chevron" size={14} />
      </summary>
      <div className="tool-activity-list">
        {entries.map((entry) => {
          if (entry.kind === "thinking") return <details className="tool-activity-row thinking" key={entry.id}><summary><code>think</code><span>Reasoning</span></summary><pre>{entry.text}</pre></details>;
          const tool = entry.tool;
          const itemStats = lineStats(tool);
          return <details className={`tool-activity-row ${tool.status}`} key={tool.id}><summary><code>{tool.name}</code><span>{tool.label}</span>{itemStats.additions ? <b className="additions">+{itemStats.additions}</b> : null}{itemStats.deletions ? <b className="deletions">-{itemStats.deletions}</b> : null}{tool.status === "running" ? <LoaderCircle className="spin" size={13} /> : tool.status === "failed" ? <AlertCircle size={13} /> : null}</summary><ToolExecutionDetails tool={tool} /></details>;
        })}
      </div>
    </details>
  );
}

function AgentTurnView({ items, modelName }: { items: TimelineItem[]; modelName: string }): React.JSX.Element {
  const rendered: React.JSX.Element[] = [];
  let activity: ActivityEntry[] = [];
  const flushActivity = (): void => {
    if (!activity.length) return;
    const entries = activity;
    activity = [];
    rendered.push(<ActivityGroupView key={`activity-${entries[0].id}`} entries={entries} />);
  };
  for (const item of items) {
    if (item.kind === "tools") {
      activity.push(...item.tools.map((tool) => ({ kind: "tool" as const, id: tool.id, tool })));
      continue;
    }
    if (item.message.thinking?.trim()) activity.push({ kind: "thinking", id: `${item.message.id}-thinking`, text: item.message.thinking });
    if (item.message.text) {
      flushActivity();
      rendered.push(<AssistantSegment key={`message-${item.message.id}`} message={{ ...item.message, thinking: undefined }} />);
    }
  }
  flushActivity();
  return (
    <article className="agent-turn">
      <div className="message-label">{modelName}</div>
      <div className="agent-turn-content">
        {rendered}
      </div>
    </article>
  );
}

function ComposerPlan({ plan }: { plan: ProjectSnapshot["plan"] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true);
  if (!plan.length) return null;
  const completed = plan.filter((item) => item.status === "completed").length;
  return (
    <section className={`composer-plan ${expanded ? "expanded" : "collapsed"}`} aria-label="Agent Todo">
      <button className="composer-plan-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><span>Todo</span><small>{completed}/{plan.length}</small>{expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
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
    return <EmptyState icon={CheckSquare2} title="暂无 Todo" detail="Agent 的结构化 Todo 会显示在这里。" />;
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

function replaceDirectoryChildren(nodes: FileNode[], path: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === path && node.kind === "directory") return { ...node, children };
    if (!node.children) return node;
    return { ...node, children: replaceDirectoryChildren(node.children, path, children) };
  });
}

function FileTreeNode({ node, root, depth, onLoad, onOpen }: {
  node: FileNode;
  root: string;
  depth: number;
  onLoad: (path: string) => Promise<void>;
  onOpen: (node: FileNode) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const startPathDrag = (event: ReactDragEvent<HTMLButtonElement>): void => {
    const absolutePath = absoluteProjectPath(root, node.path);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-suocode-path", JSON.stringify({ path: absolutePath }));
    event.dataTransfer.setData("text/plain", quotePath(absolutePath));
  };
  if (node.kind === "directory") {
    const toggle = async (): Promise<void> => {
      const nextOpen = !open;
      setOpen(nextOpen);
      if (!nextOpen || node.children !== undefined || loading) return;
      setLoading(true);
      try {
        await onLoad(node.path);
      } finally {
        setLoading(false);
      }
    };
    return (
      <div className="file-tree-node">
        <button type="button" draggable style={{ paddingLeft: 8 + depth * 13 }} onClick={() => void toggle()} onDragStart={startPathDrag}>
          {loading ? <LoaderCircle className="spin" size={12} /> : open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={14} />
          <span>{node.name}</span>
        </button>
        {open ? node.children?.map((child) => <FileTreeNode key={child.path} node={child} root={root} depth={depth + 1} onLoad={onLoad} onOpen={onOpen} />) : null}
      </div>
    );
  }
  return (
    <button className="file-leaf" type="button" draggable style={{ paddingLeft: 21 + depth * 13 }} onClick={() => onOpen(node)} onDragStart={startPathDrag}>
      <File size={13} /><span>{node.name}</span>
    </button>
  );
}

function FilesPanel({ project, runtimeId, onOpen }: { project: ProjectSnapshot; runtimeId?: string; onOpen: (node: FileNode) => void }): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>(project.files);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setTree(project.files);
    setError(undefined);
  }, [project.cwd, project.files]);

  const loadDirectory = async (path: string): Promise<void> => {
    try {
      const children = await window.suocode.request<FileNode[]>({ type: "list_directory", path }, runtimeId);
      setTree((current) => replaceDirectoryChildren(current, path, children));
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
        {tree.length ? tree.map((node) => <FileTreeNode key={node.path} node={node} root={project.cwd} depth={0} onLoad={loadDirectory} onOpen={onOpen} />) : <p className="panel-note">此文件夹为空。</p>}
        {error ? <p className="file-tree-error">{error}</p> : null}
      </div>
    </div>
  );
}

function WorkspaceStatus({
  project,
  responseMetrics,
  responseMetricsHistory,
  contextUsage,
  tokenUsage,
}: {
  project: ProjectSelection | null;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  contextUsage?: ContextUsage;
  tokenUsage: TokenUsage;
}): React.JSX.Element {
  const [pathOpen, setPathOpen] = useState(false);
  const percent = Math.max(0, Math.min(100, contextUsage?.percent ?? 0));
  return (
    <div className="workspace-status">
      <Popover.Root open={pathOpen} onOpenChange={setPathOpen}>
        <Popover.Trigger asChild>
          <button className="workspace-path" type="button" title={project?.path ?? "未选择项目"}>
            <FileCode2 size={13} />
            <span>{project ? pathLabel(project.path) : "未选择项目"}</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="path-popover" side="top" align="start" sideOffset={7}>
            {project?.path ?? "未选择项目"}
            <Popover.Arrow className="model-popover-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="composer-metrics">
        {responseMetrics ? (
          <span className="response-metrics">
            首字 {formatMetricDuration(responseMetrics.firstTokenMs)} · {responseMetrics.averageTokensPerSecond?.toFixed(1) ?? "—"} tok/s
          </span>
        ) : null}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button className="performance-trigger" type="button" aria-label="查看模型性能历史" title="模型响应性能">
              <span className={`performance-signal ${responseMetrics ? performanceGrade(responseMetrics) : "unknown"}`}><i /><i /><i /></span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="performance-popover" side="top" align="end" sideOffset={7}>
              <strong>近期请求性能</strong>
              {responseMetricsHistory.length ? (
                <>
                  <div className="performance-grid">{responseMetricsHistory.slice(-60).map((item, index) => {
                    const promptTokens = (item.inputTokens ?? 0) + (item.cacheReadTokens ?? 0) + (item.cacheWriteTokens ?? 0);
                    const cacheRate = promptTokens > 0 ? ((item.cacheReadTokens ?? 0) / promptTokens) * 100 : undefined;
                    return <span className={`performance-cell ${performanceGrade(item)}`} key={`${item.timestamp}-${index}`}><span className="performance-tooltip"><strong>{new Date(item.timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong><span>首字 {formatMetricDuration(item.firstTokenMs)}</span><span>{item.averageTokensPerSecond?.toFixed(1) ?? "—"} tok/s</span><span>输出 {formatTokens(item.outputTokens)} tok</span><span>缓存读取 {formatTokens(item.cacheReadTokens)}</span><span>缓存写入 {formatTokens(item.cacheWriteTokens)}</span><span>缓存命中 {cacheRate === undefined ? "—" : `${cacheRate.toFixed(1)}%`}</span></span></span>;
                  })}</div>
                  <div className="performance-legend"><span>较慢</span><i className="slow" /><i className="fair" /><i className="good" /><i className="excellent" /><span>较快</span></div>
                </>
              ) : <p>完成一次模型请求后，这里会显示性能记录。</p>}
              <Popover.Arrow className="model-popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              className="context-trigger"
              type="button"
              aria-label="查看上下文 Token 详情"
              title={`上下文 ${contextUsage?.percent === null || contextUsage?.percent === undefined ? "未知" : `${contextUsage.percent.toFixed(1)}%`}`}
            >
              <span className="context-ring" style={{ "--context-percent": `${percent}%` } as CSSProperties}><i /></span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="context-popover" side="top" align="end" sideOffset={7}>
              <strong>Token 使用情况</strong>
              <dl>
                <div><dt>当前上下文</dt><dd>{formatTokens(contextUsage?.tokens)} / {formatTokens(contextUsage?.contextWindow)}</dd></div>
                <div><dt>上下文占用</dt><dd>{contextUsage?.percent === null || contextUsage?.percent === undefined ? "—" : `${contextUsage.percent.toFixed(1)}%`}</dd></div>
                <div><dt>累计输入</dt><dd>{formatTokens(tokenUsage.input)}</dd></div>
                <div><dt>累计输出</dt><dd>{formatTokens(tokenUsage.output)}</dd></div>
                <div><dt>缓存读取</dt><dd>{formatTokens(tokenUsage.cacheRead)}</dd></div>
                <div><dt>本次输出</dt><dd>{formatTokens(responseMetrics?.outputTokens)}</dd></div>
              </dl>
              <Popover.Arrow className="model-popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  );
}

function SettingsDialog({ configuration, open, onClose, onSaved, runtimeId }: {
  configuration?: RuntimeConfiguration;
  open: boolean;
  onClose: () => void;
  onSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
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
      }, runtimeId);
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
  const [projects, setProjects] = useState<ProjectSelection[]>([]);
  const [project, setProject] = useState<ProjectSelection | null>(null);
  const projectRef = useRef<ProjectSelection | null>(project);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, SessionSummary[]>>({});
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [projectState, setProjectState] = useState<ProjectSnapshot>(EMPTY_PROJECT);
  const [configuration, setConfiguration] = useState<RuntimeConfiguration>();
  const [inspectorView, setInspectorView] = useState<InspectorView>("files");
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivity>>({});
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<PromptImage[]>([]);
  const [pendingProjectPath, setPendingProjectPath] = useState<string>();
  const [expandedSessionLists, setExpandedSessionLists] = useState<Set<string>>(new Set());
  const [startingSession, setStartingSession] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [leftWidth, setLeftWidth] = useState(() => storedWidth(LEFT_WIDTH_KEY, 268));
  const [rightWidth, setRightWidth] = useState(() => storedWidth(RIGHT_WIDTH_KEY, 352));
  const preferredLeftWidthRef = useRef(leftWidth);
  const preferredRightWidthRef = useRef(rightWidth);
  const [agentPhase, setAgentPhase] = useState<"思考" | "回复" | "工具">();
  const [activityPhraseIndex, setActivityPhraseIndex] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelChanging, setModelChanging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const snapshotRef = useRef<SessionSnapshot | undefined>(undefined);
  const runtimeSessionRef = useRef(new Map<string, string>());
  const fileDragDepthRef = useRef(0);
  const optimisticMessageIdRef = useRef<string | undefined>(undefined);

  const applySnapshot = useCallback((next: SessionSnapshot): void => {
    snapshotRef.current = next;
    if (next.runtimeId && next.session.path) runtimeSessionRef.current.set(next.runtimeId, next.session.path);
    setSnapshot(next);
    setMessages(next.messages);
    setTools(next.tools);
    setProjectState(next.project);
    if (next.session.path) {
      setSessionActivity((current) => ({
        ...current,
        [next.session.path]: { runtimeId: next.runtimeId, running: next.running, unread: false },
      }));
    }
  }, []);

  const startPendingConversation = useCallback((selection: ProjectSelection): void => {
    projectRef.current = selection;
    setProject(selection);
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, selection.path);
    setExpandedProjects((current) => new Set(current).add(selection.path));
    setPendingProjectPath(selection.path);
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    setMessages([]);
    setTools([]);
    setProjectState({ ...EMPTY_PROJECT, cwd: selection.path });
    setDraft("");
    setDraftImages([]);
    setLoading(false);
    setError(undefined);
    shouldAutoScrollRef.current = true;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

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
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  }, [draft]);

  useEffect(() => {
    if (!snapshot?.running) return;
    const timer = window.setInterval(() => setActivityPhraseIndex((current) => current + 1), 2_300);
    return () => window.clearInterval(timer);
  }, [snapshot?.running]);

  useEffect(() => {
    const fitPanelsToWindow = (): void => {
      const compact = window.innerWidth <= 700 && !rightOpen;
      const leftIsTiled = leftOpen && !compact;
      const rightIsTiled = rightOpen;
      let nextLeftWidth = preferredLeftWidthRef.current;
      let nextRightWidth = preferredRightWidthRef.current;
      let deficit = Math.max(
        0,
        (leftIsTiled ? nextLeftWidth : 0)
          + (rightIsTiled ? nextRightWidth : 0)
          + MINIMUM_CONVERSATION_WIDTH
          - window.innerWidth,
      );

      if (deficit > 0 && rightIsTiled) {
        const reduction = Math.min(deficit, Math.max(0, nextRightWidth - MINIMUM_PANEL_WIDTH));
        nextRightWidth -= reduction;
        deficit -= reduction;
      }
      if (deficit > 0 && leftIsTiled) {
        const reduction = Math.min(deficit, Math.max(0, nextLeftWidth - MINIMUM_PANEL_WIDTH));
        nextLeftWidth -= reduction;
      }

      setLeftWidth(Math.round(leftIsTiled ? nextLeftWidth : preferredLeftWidthRef.current));
      setRightWidth(Math.round(rightIsTiled ? nextRightWidth : preferredRightWidthRef.current));
      void window.suocode.setWindowMinimumWidth(
        MINIMUM_CONVERSATION_WIDTH
          + (leftIsTiled ? MINIMUM_PANEL_WIDTH : 0)
          + (rightIsTiled ? MINIMUM_PANEL_WIDTH : 0),
      );
    };
    fitPanelsToWindow();
    window.addEventListener("resize", fitPanelsToWindow);
    return () => window.removeEventListener("resize", fitPanelsToWindow);
  }, [leftOpen, rightOpen]);

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
  const timeline = useMemo<ConversationTimelineItem[]>(() => {
    const ordered = [
      ...messages.filter((message) => message.role !== "tool" && (message.text || message.thinking || message.images?.length)).map((message) => ({ kind: "message" as const, order: message.order, message })),
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
      const minimum = 40;
      const oppositeWidth = side === "left"
        ? (rightOpen ? rightWidth : 0)
        : (leftOpen ? leftWidth : 0);
      const maximum = Math.max(minimum, window.innerWidth - oppositeWidth - 315);
      const width = Math.round(Math.max(minimum, Math.min(maximum, raw)));
      finalWidth = width;
      if (side === "left") setLeftWidth(width); else setRightWidth(width);
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      if (side === "left") preferredLeftWidthRef.current = finalWidth;
      else preferredRightWidthRef.current = finalWidth;
      window.localStorage.setItem(side === "left" ? LEFT_WIDTH_KEY : RIGHT_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

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
    if (owner.path === project?.path && session.id === activeConversation?.id) return;
    setLoading(true);
    setError(undefined);
    setPendingProjectPath(undefined);
    setDraft("");
    setDraftImages([]);
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

  const rewindPrompt = async (message: ChatMessage, text: string): Promise<void> => {
    if (!message.entryId || !snapshot?.runtimeId) return;
    setError(undefined);
    try {
      await window.suocode.request({ type: "rewind_prompt", entryId: message.entryId, text }, snapshot.runtimeId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openFilePreview = (node: FileNode): void => {
    if (!projectState.cwd || node.kind !== "file") return;
    void window.suocode.openFilePreview({ root: projectState.cwd, path: node.path }).catch((caught) => {
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

  const handleComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(clipboardImage))
      .then((images) => setDraftImages((current) => [...current, ...images]))
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  };

  const handleTimelineScroll = (): void => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    shouldAutoScrollRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1;
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
      }, snapshot?.runtimeId);
      setConfiguration(next);
      setModelMenuOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setModelChanging(false);
    }
  };

  const inspectorItems: Array<{ id: InspectorView; label: string; icon: typeof CheckSquare2 }> = [
    { id: "files", label: "文件", icon: Files },
  ];

  const handleFileDragEnter = (event: ReactDragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes("application/x-suocode-path")) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  };

  const handleFileDragLeave = (event: ReactDragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes("application/x-suocode-path")) return;
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  };

  const handleFileDrop = (event: ReactDragEvent<HTMLElement>): void => {
    const serialized = event.dataTransfer.getData("application/x-suocode-path");
    if (!serialized) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    try {
      const dropped = JSON.parse(serialized) as { path?: string };
      if (!dropped.path) return;
      const input = inputRef.current;
      const start = input?.selectionStart ?? draft.length;
      const end = input?.selectionEnd ?? start;
      const before = draft.slice(0, start);
      const after = draft.slice(end);
      const leadingSpace = before.length && !/\s$/.test(before) ? " " : "";
      const trailingSpace = after.length && !/^\s/.test(after) ? " " : "";
      const insertion = `${leadingSpace}${quotePath(dropped.path)}${trailingSpace}`;
      const nextDraft = `${before}${insertion}${after}`;
      const caret = start + insertion.length;
      setDraft(nextDraft);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(caret, caret);
      });
    } catch {
      setError("无法插入拖入的路径。请重新拖动一次。");
    }
  };

  return (
    <>
      <main className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "keep-tiled" : "right-collapsed"}`} style={{ "--sidebar-width": `${leftWidth}px`, "--inspector-width": `${rightWidth}px` } as CSSProperties}>
        <aside className="sidebar">
          <div className="sidebar-drag"><div className="window-drag sidebar-drag-region" /></div>
          <nav className="primary-nav"><button className="nav-button" type="button" disabled={!project} onClick={() => startNewConversation()}><MessageSquarePlus size={18} strokeWidth={1.7} /><span>新建对话</span><kbd>⌘N</kbd></button></nav>
          <section className="project-section">
            <div className="section-heading"><span>项目</span><button className="icon-button" type="button" aria-label="打开项目" onClick={() => void openProject()}><FolderOpen size={15} strokeWidth={1.7} /></button></div>
            {projects.length ? projects.map((item) => {
              const expanded = expandedProjects.has(item.path);
              const itemSessions = sessionsByProject[item.path] ?? [];
              const hasPending = pendingProjectPath === item.path;
              const showAll = expandedSessionLists.has(item.path);
              const visibleSessions = showAll ? itemSessions : itemSessions.slice(0, hasPending ? 3 : 4);
              const hiddenCount = itemSessions.length - visibleSessions.length;
              return (
                <div className={`project-tree ${item.path === project?.path ? "active" : ""}`} key={item.path}>
                  <div className="project-row">
                    <button className="project-toggle" type="button" aria-expanded={expanded} onClick={() => setExpandedProjects((current) => {
                      const next = new Set(current);
                      if (expanded) next.delete(item.path); else next.add(item.path);
                      return next;
                    })}>
                      <span className="project-leading"><Folder className="project-folder-icon" size={15} strokeWidth={1.7} />{expanded ? <ChevronDown className="project-hover-icon" size={14} /> : <ChevronRight className="project-hover-icon" size={14} />}</span>
                      <span className="project-name">{item.name}</span>
                    </button>
                    <button className="project-add" type="button" aria-label={`在 ${item.name} 中新建对话`} onClick={() => startNewConversation(item)}><Plus size={14} /></button>
                  </div>
                  <div className={`conversation-list-shell ${expanded ? "expanded" : ""}`} aria-hidden={!expanded}>
                    <div className="conversation-list">
                    {hasPending ? <button className="conversation-row active pending" type="button" onClick={() => inputRef.current?.focus()}><Circle size={11} strokeWidth={1.7} /><span>新 Agent</span><time>刚刚</time></button> : null}
                    {visibleSessions.map((session) => {
                      const activity = sessionActivity[session.path];
                      return <button className={`conversation-row ${item.path === project?.path && session.id === activeConversation?.id ? "active" : ""}`} type="button" key={session.id} onClick={() => void openConversation(item, session)}>{activity?.running ? <SuoLoader size={11} /> : activity?.unread ? <span className="conversation-unread" /> : <CircleDot size={11} strokeWidth={2} />}<span>{session.title}</span><time>{relativeTime(session.updatedAt)}</time></button>;
                    })}
                    {hiddenCount > 0 ? <button className="more-conversations" type="button" aria-label={`显示另外 ${hiddenCount} 个对话`} onClick={() => setExpandedSessionLists((current) => new Set(current).add(item.path))}><MoreHorizontal size={15} /></button> : null}
                    {showAll && itemSessions.length > 4 ? <button className="more-conversations" type="button" aria-label="收起更多对话" onClick={() => setExpandedSessionLists((current) => { const next = new Set(current); next.delete(item.path); return next; })}><ChevronUp size={14} /></button> : null}
                    {!itemSessions.length && !hasPending ? <p className="empty-conversations">暂无对话</p> : null}
                    </div>
                  </div>
                </div>
              );
            }) : (
              <button className="open-project-card" type="button" onClick={() => void openProject()}><span className="open-project-icon"><Plus size={14} /></span><span><strong>打开项目</strong><small>选择本地文件夹</small></span></button>
            )}
          </section>
          <div className="sidebar-footer"><div className="brand-mark">S</div><div className="brand-copy"><strong>SuoCode</strong><span>{snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.name}` : "本地 Agent"}</span></div><button className="icon-button" type="button" aria-label="设置" onClick={() => setSettingsOpen(true)}><Settings size={17} strokeWidth={1.7} /></button></div>
        </aside>
        {leftOpen ? <button className="sidebar-toggle" type="button" aria-label="收起侧栏" onClick={() => setLeftOpen(false)}><span><PanelLeft size={17} /></span></button> : null}
        {leftOpen ? <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("left", event)} /> : null}

        <section className={`conversation-pane ${fileDragActive ? "file-drag-active" : ""}`} onDragEnter={handleFileDragEnter} onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-suocode-path")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDragLeave={handleFileDragLeave} onDrop={handleFileDrop}>
          <header className="conversation-header window-drag">
            {!leftOpen ? <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={() => setLeftOpen(true)}><PanelLeft size={17} /></button> : null}
            <div className="conversation-title"><strong title={pendingProjectPath ? "新 Agent" : activeConversation?.title ?? "新建对话"}>{truncateTitle(pendingProjectPath ? "新 Agent" : activeConversation?.title ?? "新建对话")}</strong>{project ? <span>{project.name}</span> : null}</div>
            <div className="header-actions no-drag">
              {!rightOpen ? <button className="icon-button" type="button" aria-label="展开作业栏" onClick={() => setRightOpen(true)}><PanelRight size={17} /></button> : null}
            </div>
          </header>

          <div className="conversation-body" ref={timelineRef} onScroll={handleTimelineScroll}>
            {loading ? <div className="loading-state"><SuoLoader size={20} /><span>正在打开工作区…</span></div> : timeline.length || running ? <div className="timeline">{timeline.map((item) => item.kind === "user" ? <MessageView key={`user-${item.message.id}`} message={item.message} disabled={running} onRewind={rewindPrompt} /> : <AgentTurnView key={`agent-${item.order}`} items={item.items} modelName={snapshot?.model?.name ?? "Agent"} />)}{running ? <div className="agent-activity"><SuoLoader size={14} /><span>{agentPhase === "工具" ? "动手处理中…" : agentPhase === "回复" ? "组织回答中…" : AGENT_ACTIVITY_PHRASES[activityPhraseIndex % AGENT_ACTIVITY_PHRASES.length]}</span></div> : null}</div> : <div className="empty-chat"><div className="empty-chat-mark">S</div><h1>你想构建什么？</h1><p>{project ? `SuoCode 已在 ${project.name} 中准备就绪。` : "打开项目以开始新的 Agent 会话。"}</p></div>}
          </div>

          <div className="composer-wrap">
            {error ? <div className="error-banner"><AlertCircle size={14} /><span>{error}</span><button type="button" onClick={() => setError(undefined)}><X size={13} /></button></div> : null}
            <div className="composer-stack">
              <ComposerPlan plan={projectState.plan} />
              <form className="composer" onSubmit={(event) => void submitPrompt(event)}>
                {draftImages.length ? <div className="composer-images">{draftImages.map((image) => <figure key={image.id ?? image.data.slice(0, 24)}><img src={imageDataUrl(image)} alt={image.name ?? "粘贴的图片"} /><button type="button" aria-label="移除图片" onClick={() => setDraftImages((current) => current.filter((item) => item !== image))}><X size={11} /></button></figure>)}</div> : null}
                <textarea
                  ref={inputRef}
                  value={draft}
                  aria-label="发送消息给 SuoCode"
                  placeholder={project ? (running ? "补充指令…" : "让 SuoCode 处理这个项目…") : "请先打开项目"}
                  disabled={!project || loading || startingSession}
                  onChange={(event) => setDraft(event.target.value)}
                  onPaste={handleComposerPaste}
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={() => { composingRef.current = false; }}
                  onKeyDown={handleComposerKeyDown}
                />
                <div className="composer-toolbar">
                  <ModelPicker configuration={configuration} currentModel={selectedModel} open={modelMenuOpen} busy={modelChanging} onOpenChange={setModelMenuOpen} onSelect={(model) => void selectComposerModel(model)} onOpenSettings={() => { setModelMenuOpen(false); setSettingsOpen(true); }} />
                  {running ? <button className="stop-button" type="button" aria-label="停止 Agent" onClick={() => void window.suocode.request({ type: "abort" }, snapshot?.runtimeId)}><Square size={12} fill="currentColor" /></button> : null}
                  <button className="send-button" type="submit" aria-label={running ? "补充指令" : "发送消息"} disabled={!project || startingSession || (!draft.trim() && !draftImages.length)}><ArrowUp size={17} strokeWidth={2.2} /></button>
                </div>
              </form>
            </div>
            <WorkspaceStatus project={project} responseMetrics={snapshot?.responseMetrics} responseMetricsHistory={snapshot?.responseMetricsHistory ?? []} contextUsage={snapshot?.contextUsage} tokenUsage={snapshot?.tokenUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }} />
          </div>
        </section>

        <aside className="inspector-pane">
          <div className="inspector-header"><div className="inspector-drag-surface" aria-hidden="true" /><div className="inspector-actions no-drag"><button className="icon-button" type="button" aria-label="刷新项目" disabled={!snapshot} onClick={() => void window.suocode.request({ type: "refresh_project" }, snapshot?.runtimeId)}><RefreshCw size={15} /></button><button className="icon-button" type="button" aria-label="收起右侧栏" onClick={() => setRightOpen(false)}><PanelRight size={17} /></button></div></div>
          <nav className="inspector-nav">{inspectorItems.map((item) => { const Icon = item.icon; return <button className={item.id === inspectorView ? "active" : ""} type="button" key={item.id} onClick={() => setInspectorView(item.id)}><Icon size={17} strokeWidth={1.7} /><span>{item.label}</span></button>; })}</nav>
          <section className="inspector-content">
            {inspectorView === "files" ? <FilesPanel project={projectState} runtimeId={snapshot?.runtimeId} onOpen={openFilePreview} /> : null}
          </section>
        </aside>
        {rightOpen ? <div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧栏宽度" aria-orientation="vertical" onPointerDown={(event) => beginResize("right", event)} /> : null}
      </main>
      <SettingsDialog configuration={configuration} open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={setConfiguration} runtimeId={snapshot?.runtimeId} />
    </>
  );
}
