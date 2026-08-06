import { AlertCircle, PanelLeft, PanelRight, X } from "lucide-react";
import type {
  DragEvent as ReactDragEvent,
  FormEvent,
  RefObject,
} from "react";
import type {
  ChatMessage,
  ModelOption,
  PromptImage,
  ProjectSelection,
  ProjectSnapshot,
  RuntimeConfiguration,
  SessionSnapshot,
  SubagentActivity,
} from "@suocode/runtime-protocol";
import { ActivityPanel } from "../activity/ActivityPanel";
import { ConversationComposer } from "../composer/ConversationComposer";
import { WorkspaceStatus } from "../composer/WorkspaceStatus";
import { SuoLoader } from "../../ui/SuoLoader";
import { AgentTurnView, MessageView, type ConversationTimelineItem } from "./ConversationTimeline";

function truncateTitle(value: string, maximum = 10): string {
  const characters = Array.from(value);
  return characters.length > maximum ? `${characters.slice(0, maximum).join("")}…` : value;
}

export function ConversationPane({
  fileDragActive,
  leftOpen,
  rightOpen,
  pendingProjectPath,
  activeConversation,
  project,
  loading,
  timeline,
  running,
  timelineRef,
  agentPhase,
  activityPhrase,
  error,
  projectState,
  subagents,
  snapshot,
  startingSession,
  draft,
  draftImages,
  inputRef,
  configuration,
  selectedModel,
  modelMenuOpen,
  modelChanging,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenLeft,
  onOpenRight,
  onTimelineScroll,
  onRewind,
  onError,
  onStopSubagent,
  onSubmit,
  onDraftChange,
  onImagesChange,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onModelMenuOpenChange,
  onSelectModel,
  onOpenSettings,
  onAbort,
}: {
  fileDragActive: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  pendingProjectPath?: string;
  activeConversation?: SessionSnapshot["session"];
  project: ProjectSelection | null;
  loading: boolean;
  timeline: ConversationTimelineItem[];
  running: boolean;
  timelineRef: RefObject<HTMLDivElement | null>;
  agentPhase?: "思考" | "回复" | "工具";
  activityPhrase: string;
  error?: string;
  projectState: ProjectSnapshot;
  subagents: SubagentActivity[];
  snapshot?: SessionSnapshot;
  startingSession: boolean;
  draft: string;
  draftImages: PromptImage[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  configuration?: RuntimeConfiguration;
  selectedModel?: SessionSnapshot["model"];
  modelMenuOpen: boolean;
  modelChanging: boolean;
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onTimelineScroll: () => void;
  onRewind: (message: ChatMessage, text: string, images: PromptImage[]) => Promise<void>;
  onError: (message?: string) => void;
  onStopSubagent: (activity: SubagentActivity) => void;
  onSubmit: (event: FormEvent) => void;
  onDraftChange: (value: string) => void;
  onImagesChange: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onModelMenuOpenChange: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  onOpenSettings: () => void;
  onAbort: () => void;
}): React.JSX.Element {
  return (
    <section className={`conversation-pane ${fileDragActive ? "file-drag-active" : ""}`} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="conversation-header window-drag">
        {!leftOpen ? <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={onOpenLeft}><PanelLeft size={17} /></button> : null}
        <div className="conversation-title"><strong title={pendingProjectPath ? "新对话" : activeConversation?.title ?? "新建对话"}>{truncateTitle(pendingProjectPath ? "新对话" : activeConversation?.title ?? "新建对话")}</strong>{project ? <span>{project.name}</span> : null}</div>
        <div className="header-actions no-drag">{!rightOpen ? <button className="icon-button" type="button" aria-label="展开作业栏" onClick={onOpenRight}><PanelRight size={17} /></button> : null}</div>
      </header>

      <div className="conversation-body" ref={timelineRef} onScroll={onTimelineScroll}>
        {loading ? <div className="loading-state"><SuoLoader size={20} /><span>正在打开工作区…</span></div> : timeline.length || running ? <div className="timeline">{timeline.map((item) => item.kind === "user" ? <MessageView key={`user-${item.message.id}`} message={item.message} disabled={running} onRewind={onRewind} onError={onError} /> : <AgentTurnView key={`agent-${item.order}`} items={item.items} modelName={snapshot?.model?.name ?? "Agent"} onStopSubagent={onStopSubagent} />)}{running ? <div className="agent-activity"><SuoLoader size={14} /><span>{agentPhase === "工具" ? "动手处理中…" : agentPhase === "回复" ? "组织回答中…" : activityPhrase}</span></div> : null}</div> : <div className="empty-chat"><div className="empty-chat-mark">S</div><h1>你想构建什么？</h1><p>{project ? `SuoCode 已在 ${project.name} 中准备就绪。` : "打开项目以开始新的 Agent 会话。"}</p></div>}
      </div>

      <div className="composer-wrap">
        {error ? <div className="error-banner"><AlertCircle size={14} /><span>{error}</span><button type="button" onClick={() => onError(undefined)}><X size={13} /></button></div> : null}
        <div className="composer-stack">
          <ActivityPanel todo={projectState.plan} subagents={subagents} onStopSubagent={onStopSubagent} />
          <ConversationComposer project={project} running={running} loading={loading} startingSession={startingSession} draft={draft} images={draftImages} inputRef={inputRef} configuration={configuration} selectedModel={selectedModel} modelMenuOpen={modelMenuOpen} modelChanging={modelChanging} onSubmit={onSubmit} onDraftChange={onDraftChange} onImagesChange={onImagesChange} onPaste={onPaste} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} onKeyDown={onKeyDown} onModelMenuOpenChange={onModelMenuOpenChange} onSelectModel={onSelectModel} onOpenSettings={onOpenSettings} onAbort={onAbort} />
        </div>
        <WorkspaceStatus project={project} responseMetrics={snapshot?.responseMetrics} responseMetricsHistory={snapshot?.responseMetricsHistory ?? []} contextUsage={snapshot?.contextUsage} tokenUsage={snapshot?.tokenUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }} />
      </div>
    </section>
  );
}
