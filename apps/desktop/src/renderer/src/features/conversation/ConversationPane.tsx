import { ArrowDown, PanelLeft, PanelRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  FormEvent,
  RefObject,
} from "react";
import type {
  ChatMessage,
  ModelOption,
  PlanApprovalState,
  PlanExecutionTarget,
  PromptImage,
  ProjectSelection,
  ProjectSnapshot,
  RuntimeConfiguration,
  SessionSnapshot,
  SubagentActivity,
} from "@suocode/runtime-protocol";
import { useChatContentWidth } from "../../hooks/useChatContentWidth";
import { ActivityPanel } from "../activity/ActivityPanel";
import { ConversationComposer } from "../composer/ConversationComposer";
import { useSlashMenu, type SettingsSection } from "../composer/useSlashSkills";
import { WorkspaceStatus } from "../composer/WorkspaceStatus";
import { SuoLoader } from "../../ui/SuoLoader";
import { AgentTurnView, MessageView, type ConversationTimelineItem } from "./ConversationTimeline";
import { PlanApprovalCard } from "../plans/PlanApprovalCard";
import { SubagentCard, SubagentDetailDialog } from "../subagents/SubagentActivity";

function turnModelName(
  model: ChatMessage["model"],
  configuration: RuntimeConfiguration | undefined,
  fallback: string,
): string {
  if (!model) return fallback;
  return configuration?.models.find((candidate) => candidate.provider === model.provider && candidate.id === model.id)?.name
    ?? model.id;
}

const INITIAL_VISIBLE_TURNS = 24;
const LOAD_MORE_TURNS = 20;

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
  onSubmit,
  onDraftChange,
  onImagesChange,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onModelMenuOpenChange,
  onSelectModel,
  onConfigureModelOptions,
  onFastChange,
  onOpenSettings,
  onAbort,
  onApprovePlan,
  onRejectPlan,
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
  onSubmit: (event: FormEvent) => void;
  onDraftChange: (value: string) => void;
  onImagesChange: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onModelMenuOpenChange: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  onConfigureModelOptions: (model: ModelOption, thinkingLevel: RuntimeConfiguration["thinkingLevel"], contextWindow?: number) => Promise<void>;
  onFastChange: (enabled: boolean) => Promise<void>;
  onOpenSettings: (section?: SettingsSection) => void;
  onAbort: () => void;
  onApprovePlan: (planId: string, target: PlanExecutionTarget, agent?: string) => Promise<PlanApprovalState>;
  onRejectPlan: (planId: string) => Promise<PlanApprovalState>;
}): React.JSX.Element {
  const { chatContentWidth, beginChatWidthResize } = useChatContentWidth();
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [visibleTimelineStart, setVisibleTimelineStart] = useState<number>();
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showLoadEarlier, setShowLoadEarlier] = useState(false);
  const pendingScrollRestore = useRef<{ height: number; top: number } | undefined>(undefined);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string>();
  const selectedSubagent = subagents.find((activity) => activity.id === selectedSubagentId);
  const conversationTitle = pendingProjectPath ? "新对话" : activeConversation?.title ?? "新建对话";
  const slashMenu = useSlashMenu({
    draft,
    inputRef,
    project,
    runtimeId: snapshot?.runtimeId,
    onDraftChange,
    onOpenSettings,
  });
  const hasComposerActivity = projectState.plan.length > 0 || subagents.length > 0 || slashMenu.slashActive;

  useEffect(() => {
    setEditingMessageId(undefined);
    setSelectedSubagentId(undefined);
    setVisibleTimelineStart(undefined);
    setHistoryExpanded(false);
    setShowLoadEarlier(false);
    pendingScrollRestore.current = undefined;
  }, [activeConversation?.id, pendingProjectPath]);

  useEffect(() => {
    if (historyExpanded || !timeline.length) return;
    setVisibleTimelineStart(Math.max(0, timeline.length - INITIAL_VISIBLE_TURNS));
  }, [historyExpanded, timeline.length]);

  const timelineStart = Math.min(
    visibleTimelineStart ?? Math.max(0, timeline.length - INITIAL_VISIBLE_TURNS),
    timeline.length,
  );
  const visibleTimeline = timeline.slice(timelineStart);
  const hasEarlierTimeline = timelineStart > 0;

  const updateScrollDownVisibility = useCallback((): void => {
    const viewport = timelineRef.current;
    if (!viewport) {
      setShowScrollDown(false);
      return;
    }
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setShowScrollDown(distance > 48);
  }, [timelineRef]);

  const updateLoadEarlierVisibility = useCallback((): void => {
    const viewport = timelineRef.current;
    setShowLoadEarlier(Boolean(hasEarlierTimeline && viewport && viewport.scrollTop <= 64));
  }, [hasEarlierTimeline, timelineRef]);

  useLayoutEffect(() => {
    const restore = pendingScrollRestore.current;
    const viewport = timelineRef.current;
    if (!restore || !viewport) return;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - restore.height + restore.top);
    pendingScrollRestore.current = undefined;
    updateLoadEarlierVisibility();
  }, [timelineStart, timelineRef, updateLoadEarlierVisibility]);

  useEffect(() => {
    updateScrollDownVisibility();
    updateLoadEarlierVisibility();
  }, [timeline, running, loading, timelineStart, updateLoadEarlierVisibility, updateScrollDownVisibility]);

  const handleBodyScroll = useCallback((): void => {
    onTimelineScroll();
    updateScrollDownVisibility();
    updateLoadEarlierVisibility();
  }, [onTimelineScroll, updateLoadEarlierVisibility, updateScrollDownVisibility]);

  const loadEarlierTimeline = useCallback((): void => {
    if (!hasEarlierTimeline) return;
    const viewport = timelineRef.current;
    if (viewport) pendingScrollRestore.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    setHistoryExpanded(true);
    setVisibleTimelineStart(Math.max(0, timelineStart - LOAD_MORE_TURNS));
    setShowLoadEarlier(false);
  }, [hasEarlierTimeline, timelineRef, timelineStart]);

  const scrollToBottom = useCallback((): void => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [timelineRef]);

  const reportError = useCallback((message?: string): void => {
    if (message) onError(message);
  }, [onError]);

  return (
    <section className={`conversation-pane ${fileDragActive ? "file-drag-active" : ""} ${hasComposerActivity ? "has-composer-activity" : ""}`} style={{ "--chat-content-width": `${chatContentWidth}px` } as CSSProperties} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="conversation-header window-drag">
        {!leftOpen ? <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={onOpenLeft}><PanelLeft size={17} /></button> : null}
        <div className="conversation-title"><strong title={conversationTitle}>{conversationTitle}</strong>{project ? <span>{project.name}</span> : null}</div>
        <div className="header-actions no-drag">{!rightOpen ? <button className="icon-button" type="button" aria-label="展开作业栏" onClick={onOpenRight}><PanelRight size={17} /></button> : null}</div>
      </header>

      <div className="conversation-scroll">
        <div className="conversation-body" ref={timelineRef} onScroll={handleBodyScroll}>
          {loading ? <div className="loading-state"><SuoLoader size={20} /><span>正在打开工作区…</span></div> : timeline.length || running || startingSession ? (
            <div className="timeline">
              {showLoadEarlier && hasEarlierTimeline ? (
                <div className="timeline-history-loader">
                  <button type="button" onClick={loadEarlierTimeline}>
                    加载更早的对话
                    <span>还有 {timelineStart} 轮</span>
                  </button>
                </div>
              ) : null}
              {visibleTimeline.map((item, index) => item.kind === "user" ? (
                <MessageView
                  key={`user-${item.message.id}`}
                  message={item.message}
                  disabled={running}
                  editing={editingMessageId === item.message.id}
                  project={project}
                  configuration={configuration}
                  selectedModel={selectedModel}
                  thinkingLevel={snapshot?.pendingModel?.thinkingLevel ?? snapshot?.thinkingLevel}
                  modelChanging={modelChanging}
                  runtimeId={snapshot?.runtimeId}
                  onEditingChange={(next) => setEditingMessageId(next ? item.message.id : undefined)}
                  onRewind={onRewind}
                  onError={reportError}
                  onSelectModel={onSelectModel}
                  onOpenSettings={onOpenSettings}
                />
              ) : (
                <AgentTurnView
                  key={`agent-${item.order}`}
                  items={item.items}
                  running={running && index === visibleTimeline.length - 1}
                  modelName={turnModelName(item.model, configuration, snapshot?.model?.name ?? "Agent")}
                  renderSubagent={(activity) => <SubagentCard activity={activity} onOpen={(selected) => setSelectedSubagentId(selected.id)} />}
                  renderPlan={(plan) => <PlanApprovalCard plan={plan} onApprove={onApprovePlan} onReject={onRejectPlan} />}
                />
              ))}
              {running ? <div className="agent-activity"><SuoLoader size={14} /><span>{agentPhase === "工具" ? "动手处理中…" : agentPhase === "回复" ? "组织回答中…" : activityPhrase}</span></div> : null}
            </div>
          ) : (
            <div className="empty-chat"><div className="empty-chat-mark">S</div><h1>你想构建什么？</h1><p>{project ? `SuoCode 已在 ${project.name} 中准备就绪。` : "打开项目以开始新的 Agent 会话。"}</p></div>
          )}
        </div>
        {showScrollDown ? (
          <button className="scroll-to-bottom" type="button" aria-label="滚动到最新消息" onClick={scrollToBottom}>
            <ArrowDown size={14} strokeWidth={2.2} />
          </button>
        ) : null}
      </div>

      <div className="composer-wrap">
        <div className="composer-width-resizer left" role="separator" aria-label="调整对话宽度" aria-orientation="vertical" onPointerDown={(event) => beginChatWidthResize("left", event)} />
        <div className="composer-width-resizer right" role="separator" aria-label="调整对话宽度" aria-orientation="vertical" onPointerDown={(event) => beginChatWidthResize("right", event)} />
        <div className="composer-stack">
          <div className="composer-overlays">
            <ActivityPanel
              todo={projectState.plan}
              subagents={subagents}
              commands={slashMenu.slashActive ? slashMenu.filteredItems : undefined}
              commandIndex={slashMenu.itemIndex}
              onSelectCommand={slashMenu.selectItem}
              onOpenSubagent={(activity) => setSelectedSubagentId(activity.id)}
            />
          </div>
          <ConversationComposer
            variant="footer"
            project={project}
            running={running}
            loading={loading}
            startingSession={startingSession}
            draft={draft}
            images={draftImages}
            inputRef={inputRef}
            configuration={configuration}
            selectedModel={selectedModel}
            thinkingLevel={snapshot?.pendingModel?.thinkingLevel ?? snapshot?.thinkingLevel}
            fast={snapshot?.fast}
            modelMenuOpen={modelMenuOpen}
            modelChanging={modelChanging}
            onSubmit={onSubmit}
            onDraftChange={onDraftChange}
            onImagesChange={onImagesChange}
            onPaste={onPaste}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            onKeyDown={onKeyDown}
            onSlashKeyDown={slashMenu.handleSlashKeyDown}
            onModelMenuOpenChange={onModelMenuOpenChange}
            onSelectModel={onSelectModel}
            onConfigureModelOptions={onConfigureModelOptions}
            onFastChange={onFastChange}
            onOpenSettings={() => onOpenSettings()}
            onAbort={onAbort}
          />
        </div>
        <WorkspaceStatus project={project} responseMetrics={snapshot?.responseMetrics} responseMetricsHistory={snapshot?.responseMetricsHistory ?? []} contextUsage={snapshot?.contextUsage} tokenUsage={snapshot?.tokenUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }} tokenBreakdown={snapshot?.runtimeInspection.tokenBreakdown} />
      </div>
      <SubagentDetailDialog activity={selectedSubagent} onClose={() => setSelectedSubagentId(undefined)} />
    </section>
  );
}
