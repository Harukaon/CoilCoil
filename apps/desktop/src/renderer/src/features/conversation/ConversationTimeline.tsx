import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, ExternalLink, FileText, Folder, FolderOpen, Layers, LoaderCircle } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
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
  PromptDocument,
  PromptImage,
  RewindPreview,
  RuntimeConfiguration,
  SessionSnapshot,
  SubagentActivity,
  ToolRun,
} from "@coilcoil/runtime-protocol";
import { ConversationComposer } from "../composer/ConversationComposer";
import { PromptImagePreview } from "../composer/PromptImagePreview";
import type { PromptEditorHandle } from "../composer/PromptEditor";
import { appendPromptImages, clipboardImage, imageDataUrl } from "../composer/promptImages";
import { promptDocumentFromText, promptDocumentText, replaceTextRange } from "../composer/promptDocument";
import { isPromptSendKey } from "../composer/promptKeyboard";
import { inAppBrowserModifierLabel, markdownBrowserUrl } from "../browser/useInAppBrowserLinks";
import { ConfirmDialog } from "../../ui/dialog";
import { CollapsibleCodeBlock } from "./CollapsibleCodeBlock";
import { copyPath, copyText, revealLabel, revealPath } from "../files/pathActions";
import { markdownUrlTransform, parseMarkdownFileHref, type MarkdownFileTarget } from "./markdownFileLinks";
import { useFileLinkKind } from "./fileLinkKinds";
import { TerminalNoticeCard } from "./TerminalNoticeCard";
import { SubagentNoticeCard } from "./SubagentNoticeCard";
import { parseFileDiffOutput, type FileDiffOutput } from "./fileDiffOutput";
import { parseSubagentCompletion } from "./subagentNotice";
import { compactionMarkDetail, compactionMarkLabel, compactionSummaryPreview, type CompactionMark } from "./compactionMarks";
import { TERMINAL_NOTIFICATION_TYPE } from "./terminalNotice";
import { checkpointRewindDescription } from "./checkpointRewind";

export type TimelineItem =
  | { kind: "message"; order: number; message: ChatMessage }
  | { kind: "tools"; order: number; tools: ToolRun[] }
  | { kind: "plan"; order: number; plan: PlanApprovalState }
  | { kind: "subagent"; order: number; activity: SubagentActivity };

export type ConversationTimelineItem =
  | { kind: "user"; order: number; message: ChatMessage }
  | { kind: "agent"; order: number; items: TimelineItem[]; model?: ChatMessage["model"]; continuation?: boolean }
  | { kind: "compaction"; order: number; marks: CompactionMark[] };

type ActivityEntry =
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolRun };

const REWIND_WARNING_DISMISSED_KEY = "coilcoil.rewind-warning-dismissed";
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
/**
 * A path in the transcript, drawn as the file or folder it points at.
 *
 * The kind arrives a moment after the first paint; until then the neutral file
 * icon stands in, and `data-file-kind` is what routes the click.
 */
function MarkdownFileLink({
  file,
  className,
  children,
  href,
  ...props
}: {
  file: MarkdownFileTarget;
  className?: string;
  children?: ReactNode;
  href?: string;
} & Record<string, unknown>): React.JSX.Element {
  const kind = useFileLinkKind(file.path);
  const location = file.line ? `L${file.line}${file.column ? `:${file.column}` : ""}` : undefined;
  const directory = kind === "directory";
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <a
          {...props}
          className={[className, "markdown-file-link", directory ? "directory" : ""].filter(Boolean).join(" ")}
          data-file-path={file.path}
          data-file-line={file.line}
          data-file-kind={kind ?? "unknown"}
          href={href}
          title={directory ? `${file.path}（在文件管理器中打开）` : file.path}
        >
          {directory ? <Folder size={13} /> : <FileText size={13} />}
          <span className="markdown-file-link-label">{children}</span>
          {location ? <span className="markdown-file-link-location">{location}</span> : null}
        </a>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
          {/* The label the transcript shows is often a short name; what is worth
              copying is the absolute path underneath it. */}
          <ContextMenu.Item className="conversation-context-item" onSelect={() => { void copyPath(file.path); }}><Copy size={13} /><span>复制路径</span></ContextMenu.Item>
          <ContextMenu.Item className="conversation-context-item" onSelect={() => revealPath(file.path)}><FolderOpen size={13} /><span>{revealLabel()}</span></ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * A web link in the transcript.
 *
 * Clicking goes to the user's own browser (see `useInAppBrowserLinks`); the
 * built-in panel is one modifier away and named in the tooltip, because a
 * modifier nobody can see is a modifier nobody uses. Right-click offers the
 * address itself — the visible text is often a title, and what someone wants to
 * paste elsewhere is the URL underneath it.
 */
function MarkdownWebLink({
  url,
  className,
  children,
  href,
  ...props
}: {
  url: string;
  className?: string;
  children?: ReactNode;
  href?: string;
} & Record<string, unknown>): React.JSX.Element {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <a
          {...props}
          className={className}
          href={href}
          title={`${url}\n单击在浏览器中打开，${inAppBrowserModifierLabel()} + 单击在内置浏览器打开`}
        >
          {children}
        </a>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
          <ContextMenu.Item className="conversation-context-item" onSelect={() => { void copyText(url, "链接地址"); }}><Copy size={13} /><span>复制链接地址</span></ContextMenu.Item>
          <ContextMenu.Item className="conversation-context-item" onSelect={() => { void window.coilcoil.openExternal(url); }}><ExternalLink size={13} /><span>在浏览器中打开</span></ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * 一条我们不认识的链接。
 *
 * 既不是文件也不是网页——`vscode://`、`slack://` 这类自定义协议都会落到这里。点
 * 击什么都不做（也绝不能让它去导航，那会把应用自己冲掉），但地址得让人拿得走：
 * 「右键一定要有一个复制链接地址」是用户对这种链接提的第一条要求。
 */
function MarkdownPlainLink({
  href,
  className,
  children,
  ...props
}: {
  href: string;
  className?: string;
  children?: ReactNode;
} & Record<string, unknown>): React.JSX.Element {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <a {...props} className={className} href={href} title={`${href}
这种地址打不开，右键可以复制`}>{children}</a>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
          <ContextMenu.Item className="conversation-context-item" onSelect={() => { void copyText(href, "链接地址"); }}><Copy size={13} /><span>复制链接地址</span></ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props} /></div>,
  pre: ({ node: _node, ...props }) => <CollapsibleCodeBlock {...props} />,
  a: ({ node: _node, children, className, href, ...props }) => {
    const file = parseMarkdownFileHref(href);
    if (file) return <MarkdownFileLink {...props} file={file} className={className} href={href}>{children}</MarkdownFileLink>;
    const url = markdownBrowserUrl(href ?? null);
    if (url) return <MarkdownWebLink {...props} url={url} className={className} href={href}>{children}</MarkdownWebLink>;
    // 地址被挡掉了（危险协议）就别画成链接：没有 href 的 <a> 点下去会重新加载当前
    // 页，而当前页就是应用自己。不是链接的东西，就不要长得像链接。
    const raw = href?.trim();
    if (!raw) return <span className={className}>{children}</span>;
    return <MarkdownPlainLink {...props} href={raw} className={className}>{children}</MarkdownPlainLink>;
  },
};

export { imageDataUrl, clipboardImage };

export const Markdown = memo(function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} urlTransform={markdownUrlTransform} components={MARKDOWN_COMPONENTS}>
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
        <PromptImagePreview
          className="message-image"
          image={image}
          alt={image.name ?? "附加图片"}
          key={image.id ?? image.data.slice(0, 24)}
        />
      ))}
    </span>
  );
}

function PromptDocumentView({ document }: { document: PromptDocument }): React.JSX.Element {
  return (
    <span className="user-bubble-text">
      {document.parts.map((part, index) => part.type === "text" ? (
        <Fragment key={`text-${index}`}>{part.text}</Fragment>
      ) : (
        <span
          className="prompt-editor-element prompt-history-element"
          key={part.id}
          title={`${part.element.pageTitle || "网页元素"}\n${part.element.selector}`}
        >
          {part.label}
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
  return Boolean(target.closest(".model-popover, .coil-modal-backdrop, .coil-modal, .inspector-pane, .sidebar, .settings-dialog, .toast-host"));
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
  thinkingLevel,
  modelChanging,
  fast,
  runtimeId,
  onEditingChange,
  onRewind,
  onError,
  onSelectModel,
  onConfigureModelOptions,
  onFastChange,
  onOpenSettings,
}: {
  message: ChatMessage;
  disabled: boolean;
  editing: boolean;
  project: ProjectSelection | null;
  configuration?: RuntimeConfiguration;
  selectedModel?: SessionSnapshot["model"];
  thinkingLevel?: RuntimeConfiguration["thinkingLevel"];
  modelChanging: boolean;
  fast?: boolean;
  runtimeId?: string;
  onEditingChange: (editing: boolean) => void;
  onRewind: (message: ChatMessage, text: string, images: PromptImage[], document: PromptDocument, restoreCode: boolean) => Promise<void>;
  onError: (message: string) => void;
  onSelectModel: (model: ModelOption) => void;
  onConfigureModelOptions: (model: ModelOption, thinkingLevel: RuntimeConfiguration["thinkingLevel"], contextWindow?: number) => Promise<void>;
  onFastChange: (enabled: boolean) => Promise<void>;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [documentValue, setDocumentValue] = useState<PromptDocument>(() => message.promptDocument ?? promptDocumentFromText(message.text));
  const [images, setImages] = useState<PromptImage[]>(message.images ?? []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 有检查点、而且那之后代码变过：问要不要把代码一起退回去。
  const [codeChanges, setCodeChanges] = useState<RewindPreview["files"]>();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<PromptEditorHandle>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    if (editing) return;
    setDocumentValue(message.promptDocument ?? promptDocumentFromText(message.text));
    setImages(message.images ?? []);
  }, [editing, message.images, message.promptDocument, message.text]);

  useEffect(() => {
    if (!editing) {
      setModelMenuOpen(false);
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (confirmOpen || codeChanges || modelMenuOpen) return;
      if (!shouldDismissHistoryEdit(event.target, editorRef.current)) return;
      onEditingChange(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [codeChanges, confirmOpen, editing, modelMenuOpen, onEditingChange]);

  const proceed = (remember: boolean, restoreCode = false): void => {
    const prompt = promptDocumentText(documentValue).trim();
    if ((!prompt && !images.length) || !message.entryId) return;
    if (remember) window.localStorage.setItem(REWIND_WARNING_DISMISSED_KEY, "true");
    setConfirmOpen(false);
    setCodeChanges(undefined);
    onEditingChange(false);
    void onRewind(message, prompt, images, documentValue, restoreCode);
  };

  const requestRewind = async (): Promise<void> => {
    if ((!promptDocumentText(documentValue).trim() && !images.length) || !message.entryId) return;
    if (message.checkpoint && runtimeId) {
      // 代码变过就一定要问：回不回退是个不能默认替用户做的决定，「不再提醒」管不到这里。
      try {
        const preview = await window.coilcoil.request<RewindPreview>({ type: "rewind_preview", entryId: message.entryId }, runtimeId);
        if (preview.checkpoint && preview.files.length) {
          setCodeChanges(preview.files);
          return;
        }
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : String(caught));
        return;
      }
    }
    if (window.localStorage.getItem(REWIND_WARNING_DISMISSED_KEY) === "true") proceed(false);
    else setConfirmOpen(true);
  };

  const pasteImages = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(clipboardImage))
      .then((next) => setImages((current) => {
        try {
          return appendPromptImages(current, next);
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : String(caught));
          return current;
        }
      }))
      .catch((caught) => onError(caught instanceof Error ? caught.message : String(caught)));
  };

  if (message.role === "user") {
    return (
      <article className="timeline-message user-message" data-message-id={message.id}>
        {editing ? (
          <div className="user-message-editor-shell" ref={editorRef}>
            <ConversationComposer
              variant="inline"
              project={project}
              running={false}
              loading={false}
              startingSession={false}
              draft={promptDocumentText(documentValue)}
              document={documentValue}
              images={images}
              inputRef={textareaRef}
              configuration={configuration}
              selectedModel={selectedModel}
              thinkingLevel={thinkingLevel}
              fast={fast}
              modelMenuOpen={modelMenuOpen}
              modelChanging={modelChanging}
              autoFocus
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void requestRewind();
              }}
              onDocumentChange={setDocumentValue}
              onReplaceTextRange={(start, end, replacement) => setDocumentValue((current) => replaceTextRange(current, start, end, replacement))}
              onImagesChange={setImages}
              onPaste={pasteImages}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(event) => {
                if (composingRef.current || !isPromptSendKey(event)) return;
                event.preventDefault();
                const currentTarget = event.currentTarget as unknown as HTMLElement | null;
                currentTarget?.closest("form")?.requestSubmit();
              }}
              onModelMenuOpenChange={setModelMenuOpen}
              onSelectModel={(model) => {
                setModelMenuOpen(false);
                onSelectModel(model);
              }}
              onConfigureModelOptions={onConfigureModelOptions}
              onFastChange={onFastChange}
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
            className={`user-bubble user-bubble-button ${message.status === "queued" ? "queued" : ""} ${message.status === "steering" ? "steering" : ""}`}
            type="button"
            title={message.entryId ? "点击编辑并从这里重新开始" : undefined}
            data-prompt-value={promptDocumentText(documentValue)}
            disabled={disabled || !message.entryId}
            onClick={() => onEditingChange(true)}
          >
            <ImageStrip images={images} />
            {message.promptDocument ? <PromptDocumentView document={message.promptDocument} /> : promptDocumentText(documentValue) ? <span className="user-bubble-text">{promptDocumentText(documentValue)}</span> : null}
            {message.status === "queued" ? (
              <span className="user-message-queue-status"><LoaderCircle className="spin" size={12} />排队中</span>
            ) : null}
            {/* Pi already has this one; it reaches the model when the running turn
                ends, which is why it waits here instead of vanishing. */}
            {message.status === "steering" ? (
              <span className="user-message-queue-status"><LoaderCircle className="spin" size={12} />介入中 · 本轮结束后送达</span>
            ) : null}
          </button>
        )}
        <ConfirmDialog
          open={confirmOpen}
          title="从这里重新开始？"
          description={message.checkpoint ? "对话将从这条消息重新开始。代码和这条消息发出时一样，不需要回退。" : "对话将从这条消息重新开始。这条消息没有代码检查点，当前工作区中已经产生的文件修改不会被恢复。"}
          onClose={() => setConfirmOpen(false)}
          actions={[
            { label: "取消", onClick: () => setConfirmOpen(false) },
            { label: "不再提醒", onClick: () => proceed(true) },
            { label: "继续", variant: "primary", autoFocus: true, onClick: () => proceed(false) },
          ]}
        />
        <ConfirmDialog
          open={Boolean(codeChanges)}
          title="代码也回退吗？"
          description={checkpointRewindDescription(codeChanges ?? [])}
          onClose={() => setCodeChanges(undefined)}
          actions={[
            { label: "取消", onClick: () => setCodeChanges(undefined) },
            { label: "保留现在的代码", onClick: () => proceed(false, false) },
            { label: "回退代码并重新发送", variant: "primary", autoFocus: true, onClick: () => proceed(false, true) },
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
  const diff = parseFileDiffOutput(tool.name, tool.output);
  if (diff) return { additions: diff.additions, deletions: diff.deletions };
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
    else if (["bash", "powershell", "terminal"].includes(tool.name)) commands += 1;
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
  if (tool.name === "bash" || tool.name === "powershell") return String(args.command ?? "");
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

function DiffView({ diff }: { diff: FileDiffOutput }): React.JSX.Element {
  return (
    <pre className="tool-diff">
      <span className="tool-diff-header">{diff.header}</span>
      {diff.lines.map((line, index) => <span key={index} className={`tool-diff-line ${line.kind}`}>{line.text}</span>)}
    </pre>
  );
}

function ToolExecutionDetails({ tool }: { tool: ToolRun }): React.JSX.Element | null {
  const diff = parseFileDiffOutput(tool.name, tool.output);
  // 有 diff 时参数只留路径：旧文本、新文本、整份写入内容都已经在 diff 里了。
  const input = diff ? diff.path : toolArgumentsText(tool).trim();
  const output = tool.output.trim();
  if (!input && !output) return null;
  return (
    <div className="tool-execution-details">
      {input ? <section><span>调用参数</span><pre>{input}</pre></section> : null}
      {diff
        ? <section><span>改动</span><DiffView diff={diff} /></section>
        : output ? <section><span>{tool.status === "failed" ? "错误" : "执行结果"}</span><pre>{output}</pre></section> : null}
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
  // Whether this group is open belongs to the reader. Binding `open` to
  // `running` made the group pop open the moment a tool started and snap shut
  // when it finished, throwing away whatever the reader had chosen; `running`
  // is only consulted for the state the group is born in.
  const [open, setOpen] = useState(running);
  return (
    <details
      className="tool-activity"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
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

/**
 * The rule across the transcript where the context was compacted.
 *
 * Codex's shape, for the same reason: compaction is a boundary, and a boundary
 * reads as a line. Above it the model saw everything; below it, less. Closed it
 * is one short sentence, because most of the time knowing that it happened is
 * the whole answer; open it says which of the two stages ran and what it cost.
 *
 * Everything shown is already on hand — Pi's own compaction record and the
 * clearing extension's tally. Nothing here spends a request to explain itself.
 */
export function CompactionMarkView({ marks }: { marks: CompactionMark[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // 落在同一处的几件事共用一道线。清理刚跑完、压缩紧接着失败，这在长会话里是常
  // 态；给每件事各画一道线，读起来就是两道挨着的横线互相打架，而它们说的其实是
  // 同一个位置上发生的事。
  const leading = marks.find((mark) => mark.status === "failed") ?? marks.find((mark) => mark.status === "running") ?? marks[0];
  return (
    <div className={`compaction-mark layer-${leading.layer} ${leading.status} ${open ? "open" : ""}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <i />
        <span>
          {marks.map((mark) => (
            <em key={mark.id} className={`compaction-mark-label ${mark.status}`}>
              {mark.status === "running" ? <LoaderCircle className="spin" size={12} /> : <Layers size={12} />}
              {compactionMarkLabel(mark)}
            </em>
          ))}
          <ChevronDown size={12} className="compaction-caret" />
        </span>
        <i />
      </button>
      {open ? (
        <div className="compaction-mark-panel">
          {marks.map((mark) => {
            const preview = compactionSummaryPreview(mark.summary);
            return (
              <Fragment key={mark.id}>
                <p>{compactionMarkDetail(mark)}</p>
                {preview ? <blockquote>{preview}</blockquote> : null}
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function AgentTurnView({
  items,
  modelName,
  running,
  continuation,
  renderSubagent,
  renderPlan,
}: {
  items: TimelineItem[];
  modelName: string;
  running: boolean;
  /** 这一段是被压缩横线切开的下半截，不是新的一轮回复。 */
  continuation?: boolean;
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
      await window.coilcoil.copyText(text);
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
    if (item.message.custom?.type === TERMINAL_NOTIFICATION_TYPE) {
      flushActivity();
      rendered.push(<TerminalNoticeCard key={`terminal-notice-${item.message.id}`} message={item.message} />);
      continue;
    }
    const subagentNotice = parseSubagentCompletion(item.message);
    if (subagentNotice) {
      flushActivity();
      rendered.push(
        <SubagentNoticeCard
          key={`subagent-notice-${item.message.id}`}
          notice={subagentNotice}
          report={subagentNotice.report ? <Markdown>{subagentNotice.report}</Markdown> : undefined}
        />,
      );
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
    <article className={continuation ? "agent-turn continued" : "agent-turn"}>
      {/* 横线可以落在一段回答中间。它照旧是条分界线，但线下面那半截是同一轮回答
          接着说，再报一次模型名就成了「又开始答了一遍」。 */}
      {continuation ? null : <div className="message-label">{modelName}</div>}
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
