import { AlertCircle, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, PromptImage, SubagentActivity, ToolRun } from "@suocode/runtime-protocol";
import { SubagentTimelineCard } from "./SubagentTimelineCard";

export type TimelineItem =
  | { kind: "message"; order: number; message: ChatMessage }
  | { kind: "tools"; order: number; tools: ToolRun[] }
  | { kind: "subagents"; order: number; tool: ToolRun; subagents: SubagentActivity[] };

export type ConversationTimelineItem =
  | { kind: "user"; order: number; message: ChatMessage }
  | { kind: "agent"; order: number; items: TimelineItem[] };

type ActivityEntry =
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolRun };

const REWIND_WARNING_DISMISSED_KEY = "suocode.rewind-warning-dismissed";

export function imageDataUrl(image: PromptImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export async function clipboardImage(file: globalThis.File): Promise<PromptImage> {
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

function quotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function insertPath(value: string, path: string, start: number, end: number): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before.length && !/\s$/.test(before) ? " " : "";
  const trailingSpace = after.length && !/^\s/.test(after) ? " " : "";
  const insertion = `${leadingSpace}${quotePath(path)}${trailingSpace}`;
  return { value: `${before}${insertion}${after}`, caret: start + insertion.length };
}

function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props} /></div>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ImageStrip({ images, editable, onRemove }: {
  images: PromptImage[];
  editable?: boolean;
  onRemove?: (image: PromptImage) => void;
}): React.JSX.Element | null {
  if (!images.length) return null;
  return (
    <span className={`message-images ${editable ? "editable" : ""}`}>
      {images.map((image) => (
        <span className="message-image" key={image.id ?? image.data.slice(0, 24)}>
          <img src={imageDataUrl(image)} alt={image.name ?? "附加图片"} />
          {editable ? <button type="button" aria-label="移除历史图片" onClick={() => onRemove?.(image)}><X size={11} /></button> : null}
        </span>
      ))}
    </span>
  );
}

export function MessageView({ message, disabled, onRewind, onError }: {
  message: ChatMessage;
  disabled: boolean;
  onRewind: (message: ChatMessage, text: string, images: PromptImage[]) => Promise<void>;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(message.text);
  const [images, setImages] = useState<PromptImage[]>(message.images ?? []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    setValue(message.text);
    setImages(message.images ?? []);
  }, [message.images, message.text]);

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
    if ((!prompt && !images.length) || !message.entryId) return;
    if (remember) window.localStorage.setItem(REWIND_WARNING_DISMISSED_KEY, "true");
    setConfirmOpen(false);
    setEditing(false);
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

  const dropPath = (event: ReactDragEvent<HTMLTextAreaElement>): void => {
    const serialized = event.dataTransfer.getData("application/x-suocode-path");
    if (!serialized) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const dropped = JSON.parse(serialized) as { path?: string };
      if (!dropped.path) return;
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? value.length;
      const end = textarea?.selectionEnd ?? start;
      const result = insertPath(value, dropped.path, start, end);
      setValue(result.value);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(result.caret, result.caret);
      });
    } catch {
      onError("无法插入拖入的路径。请重新拖动一次。");
    }
  };

  if (message.role === "user") {
    const changed = value !== message.text || images.length !== (message.images?.length ?? 0)
      || images.some((image, index) => image.data !== message.images?.[index]?.data);
    return (
      <article className="timeline-message user-message">
        <div className="message-label">你</div>
        {editing ? (
          <div className="user-message-editor-shell" ref={editorRef}>
            <ImageStrip images={images} editable onRemove={(image) => setImages((current) => current.filter((item) => item !== image))} />
            <textarea
              ref={textareaRef}
              className="user-bubble user-message-editor"
              autoFocus
              value={value}
              aria-label="编辑历史消息"
              placeholder="编辑历史消息"
              onChange={(event) => setValue(event.target.value)}
              onPaste={pasteImages}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("application/x-suocode-path")) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={dropPath}
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
            {changed ? <small className="history-edit-warning">修改历史消息会改变后续上下文，可能降低本次请求的提示缓存命中率。</small> : null}
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
            <ImageStrip images={images} />
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

export function AgentTurnView({ items, modelName, onStopSubagent }: { items: TimelineItem[]; modelName: string; onStopSubagent: (activity: SubagentActivity) => void }): React.JSX.Element {
  const rendered: React.JSX.Element[] = [];
  let activity: ActivityEntry[] = [];
  const flushActivity = (): void => {
    if (!activity.length) return;
    const entries = activity;
    activity = [];
    rendered.push(<ActivityGroupView key={`activity-${entries[0].id}`} entries={entries} />);
  };
  for (const item of items) {
    if (item.kind === "subagents") {
      flushActivity();
      rendered.push(<SubagentTimelineCard key={`subagents-${item.tool.id}`} tool={item.tool} activities={item.subagents} onStop={onStopSubagent} />);
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
    </article>
  );
}
