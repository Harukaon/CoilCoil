import { AlertCircle, Check, ChevronRight, Copy, LoaderCircle } from "lucide-react";
import { Fragment, memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ClipboardEvent as ReactClipboardEvent, FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatMessage,
  ModelOption,
  PlanApprovalState,
  ProjectSelection,
  PromptImage,
  RuntimeConfiguration,
  SessionSnapshot,
  SubagentActivity,
  ToolRun,
} from "@suocode/runtime-protocol";
import { ConversationComposer } from "../composer/ConversationComposer";
import { clipboardImage, imageDataUrl } from "../composer/promptImages";
import { ConfirmDialog } from "../../ui/dialog";

export type TimelineItem =
  | { kind: "message"; order: number; message: ChatMessage }
  | { kind: "tools"; order: number; tools: ToolRun[] }
  | { kind: "plan"; order: number; plan: PlanApprovalState }
  | { kind: "subagent"; order: number; activity: SubagentActivity };

export type ConversationTimelineItem =
  | { kind: "user"; order: number; message: ChatMessage }
  | { kind: "agent"; order: number; items: TimelineItem[]; model?: ChatMessage["model"] };

type ActivityEntry =
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolRun };

const REWIND_WARNING_DISMISSED_KEY = "suocode.rewind-warning-dismissed";
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS: Components = {
  table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props} /></div>,
};

export { imageDataUrl, clipboardImage };

const Markdown = memo(function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});

function ImageStrip({ images }: { images: PromptImage[] }): React.JSX.Element | null {
  if (!images.length) return null;
  return (
    <span className="message-images">
      {images.map((image) => (
        <span className="message-image" key={image.id ?? image.data.slice(0, 24)}>
          <img src={imageDataUrl(image)} alt={image.name ?? "附加图片"} />
        </span>
      ))}
    </span>
  );
}

function isInsideComposerChrome(target: EventTarget | null, shell: HTMLElement | null): boolean {
  if (!(target instanceof Node)) return false;
  if (shell?.contains(target)) return true;
  if (!(target instanceof Element)) return false;
  // Keep editing when interacting with model menu / rewind dialog / files inspector / sidebar
  // so users can drag paths from the right panel into the inline composer.
  return Boolean(target.closest(".model-popover, .suo-modal-backdrop, .suo-modal, .inspector-pane, .sidebar, .settings-dialog, .toast-host"));
}

function shouldDismissHistoryEdit(target: EventTarget | null, shell: HTMLElement | null): boolean {
  if (!(target instanceof Element)) return false;
  if (isInsideComposerChrome(target, shell)) return false;
  // Only dismiss when the click lands elsewhere inside the conversation pane.
  const pane = target.closest(".conversation-pane");
  if (!pane) return false;
  return !shell || !shell.contains(target);
}

export function MessageView({
  message,
  disabled,
  editing,
  project,
  configuration,
  selectedModel,
  modelChanging,
  runtimeId,
  onEditingChange,
  onRewind,
  onError,
  onSelectModel,
  onOpenSettings,
}: {
  message: ChatMessage;
  disabled: boolean;
  editing: boolean;
  project: ProjectSelection | null;
  configuration?: RuntimeConfiguration;
  selectedModel?: SessionSnapshot["model"];
  modelChanging: boolean;
  runtimeId?: string;
  onEditingChange: (editing: boolean) => void;
  onRewind: (message: ChatMessage, text: string, images: PromptImage[]) => Promise<void>;
  onError: (message: string) => void;
  onSelectModel: (model: ModelOption) => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(message.text);
  const [images, setImages] = useState<PromptImage[]>(message.images ?? []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    if (editing) return;
    setValue(message.text);
    setImages(message.images ?? []);
  }, [editing, message.images, message.text]);

  useEffect(() => {
    if (!editing) {
      setModelMenuOpen(false);
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (confirmOpen || modelMenuOpen) return;
      if (!shouldDismissHistoryEdit(event.target, editorRef.current)) return;
      onEditingChange(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [confirmOpen, editing, modelMenuOpen, onEditingChange]);

  const proceed = (remember: boolean): void => {
    const prompt = value.trim();
    if ((!prompt && !images.length) || !message.entryId) return;
    if (remember) window.localStorage.setItem(REWIND_WARNING_DISMISSED_KEY, "true");
    setConfirmOpen(false);
    onEditingChange(false);
    void onRewind(message, prompt, images);
  };

  const requestRewind = (): void => {
    if ((!value.trim() && !images.length) || !message.entryId) return;
    if (window.localStorage.getItem(REWIND_WARNING_DISMISSED_KEY) === "true") proceed(false);
    else setConfirmOpen(true);
  };

  const pasteImages = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(clipboardImage))
      .then((next) => setImages((current) => [...current, ...next]))
      .catch((caught) => onError(caught instanceof Error ? caught.message : String(caught)));
  };

  if (message.role === "user") {
    return (
      <article className="timeline-message user-message">
        {editing ? (
          <div className="user-message-editor-shell" ref={editorRef}>
            <ConversationComposer
              variant="inline"
              project={project}
              running={false}
              loading={false}
              startingSession={false}
              draft={value}
              images={images}
              inputRef={textareaRef}
              configuration={configuration}
              selectedModel={selectedModel}
              modelMenuOpen={modelMenuOpen}
              modelChanging={modelChanging}
              autoFocus
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                requestRewind();
              }}
              onDraftChange={setValue}
              onImagesChange={setImages}
              onPaste={pasteImages}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(event) => {
                if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onModelMenuOpenChange={setModelMenuOpen}
              onSelectModel={(model) => {
                setModelMenuOpen(false);
                onSelectModel(model);
              }}
              onOpenSettings={() => {
                setModelMenuOpen(false);
                onOpenSettings();
              }}
              onEscape={() => onEditingChange(false)}
              onPathDropError={onError}
            />
          </div>
        ) : (
          <button
            className="user-bubble user-bubble-button"
            type="button"
            title={message.entryId ? "点击编辑并从这里重新开始" : undefined}
            data-prompt-value={value}
            disabled={disabled || !message.entryId}
            onClick={() => onEditingChange(true)}
          >
            {value ? <span>{value}</span> : null}
            <ImageStrip images={images} />
          </button>
        )}
        <ConfirmDialog
          open={confirmOpen}
          title="从这里重新开始？"
          description="对话将从这条消息重新开始。当前工作区中已经产生的文件修改不会被恢复。"
          onClose={() => setConfirmOpen(false)}
          actions={[
            { label: "取消", onClick: () => setConfirmOpen(false) },
            { label: "不再提醒", onClick: () => proceed(true) },
            { label: "继续", variant: "primary", autoFocus: true, onClick: () => proceed(false) },
          ]}
        />
      </article>
    );
  }

  return <AssistantSegment message={message} />;
}

function AssistantSegment({ message }: { message: ChatMessage }): React.JSX.Element {
  return (
    <div className={`assistant-segment assistant-message ${message.isError ? "error" : ""}`}>
      {message.thinking?.trim() ? <details className="thinking-block"><summary>Reasoning</summary><div>{message.thinking}</div></details> : null}
      {message.text ? (
        <div className="assistant-message-body">
          <Markdown>{message.text}</Markdown>
        </div>
      ) : null}
    </div>
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

export function AgentTurnView({
  items,
  modelName,
  running,
  renderSubagent,
  renderPlan,
}: {
  items: TimelineItem[];
  modelName: string;
  running: boolean;
  renderSubagent?: (activity: SubagentActivity) => ReactNode;
  renderPlan?: (plan: PlanApprovalState) => ReactNode;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const copyTurn = async (): Promise<void> => {
    const text = items
      .filter((item): item is Extract<TimelineItem, { kind: "message" }> => item.kind === "message")
      .map((item) => item.message.text?.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text) return;
    try {
      await window.suocode.copyText(text);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard failures are non-fatal; leave UI unchanged.
    }
  };

  const rendered: React.JSX.Element[] = [];
  let activity: ActivityEntry[] = [];
  const flushActivity = (): void => {
    if (!activity.length) return;
    const entries = activity;
    activity = [];
    rendered.push(<ActivityGroupView key={`activity-${entries[0].id}`} entries={entries} />);
  };
  for (const item of items) {
    if (item.kind === "subagent") {
      flushActivity();
      rendered.push(<Fragment key={`subagent-${item.activity.id}`}>{renderSubagent?.(item.activity)}</Fragment>);
      continue;
    }
    if (item.kind === "plan") {
      flushActivity();
      rendered.push(<Fragment key={`plan-${item.plan.id}`}>{renderPlan?.(item.plan)}</Fragment>);
      continue;
    }
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
      <div className="agent-turn-content">{rendered}</div>
      {!running ? (
        <button className="assistant-copy-button" type="button" aria-label={copied ? "已复制" : "复制回复"} onClick={() => { void copyTurn(); }}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      ) : null}
    </article>
  );
}
