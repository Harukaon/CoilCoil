import type { FormEvent } from "react";
import type { AgentMode, ChatMessage, ModelOption, ProjectSelection, PromptDocument, PromptImage, RuntimeCommand, RuntimeConfiguration, SessionSnapshot, SessionSummary } from "@coilcoil/runtime-protocol";
import { manualCompactionCommand } from "@coilcoil/runtime-protocol";
import { titleFromPrompt } from "../workspaces/sessionList";

interface SubmissionState {
  project: ProjectSelection | null;
  pendingProjectPath?: string;
  pendingAgentMode: AgentMode;
  startingSession: boolean;
  loading: boolean;
  modelConfigured: boolean;
  configuration?: RuntimeConfiguration;
  selectedModel?: ModelOption;
  draft: string;
  draftDocument: PromptDocument;
  draftImages: PromptImage[];
  composerSessionKey: string;
  snapshotRef: { current: SessionSnapshot | undefined };
  selectionRequestRef: { current: number };
}

interface SubmissionEffects {
  request<T = unknown>(command: RuntimeCommand, runtimeId?: string): Promise<T>;
  resetComposer(): void;
  restoreSubmission(key: string, document: PromptDocument, images: PromptImage[]): void;
  openRuntimeTab(): void;
  setSettingsOpen(open: boolean): void;
  setStartingSession(starting: boolean): void;
  scrollToBottom(): void;
  queue(message: ChatMessage, sessionPath?: string): void;
  reject(id: string): void;
  created(snapshot: SessionSnapshot, summary: SessionSummary, clientMessageId: string, selected: boolean): void;
  creationFailed(path: string): void;
  error(message: string): void;
}

/** A submission owns its captured target even when the user selects another chat. */
export function createPromptSubmissionHandler(state: SubmissionState, effects: SubmissionEffects) {
  return async (event: FormEvent | undefined, intent: "queue" | "steer" = "queue", override?: string, overrideImages?: PromptImage[]): Promise<void> => {
    event?.preventDefault();
    const fromComposer = override === undefined;
    const prompt = (override ?? state.draft).trim();
    const promptDocument = fromComposer ? state.draftDocument : undefined;
    const images = overrideImages ?? (fromComposer ? state.draftImages : []);
    const memoryCommand = prompt === "/memory" && images.length === 0;
    const compaction = images.length === 0 ? manualCompactionCommand(prompt) : undefined;
    const runtimeCommand = memoryCommand || Boolean(compaction);
    const project = state.project;
    if ((!prompt && !images.length) || !project || state.startingSession || state.loading) return;
    const selectionRequest = state.selectionRequestRef.current;
    const stillSelected = (): boolean => state.selectionRequestRef.current === selectionRequest;
    if (runtimeCommand && (!state.snapshotRef.current || state.pendingProjectPath === project.path || state.snapshotRef.current.messages.length === 0)) {
      effects.error(compaction ? "当前会话还没有可压缩的上下文。" : "当前会话还没有可供整理的历史记录。");
      return;
    }
    if (!state.modelConfigured) {
      effects.error(state.configuration ? "发送第一条消息前，请先选择并配置模型。" : "正在读取模型配置，请稍等一下再发送。");
      if (state.configuration) effects.setSettingsOpen(true);
      return;
    }
    if (images.length && !state.selectedModel?.supportsImages) {
      effects.error("当前模型不支持图片输入，请切换到支持图片的模型。");
      return;
    }
    if (fromComposer) effects.resetComposer();
    if (memoryCommand) effects.openRuntimeTab();
    effects.scrollToBottom();
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const pendingMessage: ChatMessage | undefined = runtimeCommand ? undefined : {
      id: clientMessageId, order: Date.now(), role: "user", text: prompt, promptDocument, images,
      timestamp: Date.now(), status: "succeeded",
    };
    if (pendingMessage) effects.queue(pendingMessage, state.snapshotRef.current?.session.path);
    let createdSessionPath: string | undefined;
    try {
      let target = state.snapshotRef.current;
      if (!target || state.pendingProjectPath === project.path) {
        effects.setStartingSession(true);
        const created = await effects.request<SessionSnapshot>({
          type: "create_session", cwd: project.path, agentMode: state.pendingAgentMode,
          model: state.selectedModel && state.configuration ? {
            provider: state.selectedModel.provider, modelId: state.selectedModel.id, thinkingLevel: state.configuration.thinkingLevel,
          } : undefined,
        });
        const summary: SessionSummary = {
          ...created.session,
          title: runtimeCommand ? (created.session.title || "新对话") : titleFromPrompt(prompt, images.length > 0),
          updatedAt: new Date().toISOString(),
          messageCount: runtimeCommand ? created.session.messageCount : Math.max(1, created.session.messageCount),
        };
        target = { ...created, session: summary };
        createdSessionPath = summary.path;
        effects.created(target, summary, clientMessageId, stillSelected());
      }
      if (compaction) await effects.request({ type: "run_compaction_now", instructions: compaction.instructions }, target.runtimeId);
      else if (memoryCommand) await effects.request({ type: "run_memory_now" }, target.runtimeId);
      else await effects.request({ type: intent === "steer" ? "steer" : "prompt", text: prompt, promptDocument, images, clientMessageId }, target.runtimeId);
    } catch (caught) {
      if (fromComposer) effects.restoreSubmission(createdSessionPath ?? state.composerSessionKey, promptDocument ?? { version: 1, parts: [] }, images);
      if (stillSelected()) effects.reject(clientMessageId);
      if (createdSessionPath) effects.creationFailed(createdSessionPath);
      effects.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      effects.setStartingSession(false);
    }
  };
}
