import {
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import {
  type FileNode,
  type ProjectSnapshot,
  type PromptImage,
  type RuntimeInspectionSnapshot,
  type RuntimeSkillState,
  type RuntimeToolDefinition,
  type SessionSnapshot,
  type SessionSummary,
  type ThinkingLevel,
} from "@suocode/runtime-protocol";
import {
  existsSync,
  statSync,
} from "node:fs";
import {
  readFile,
  stat,
} from "node:fs/promises";
import {
  relative,
  resolve,
} from "node:path";
import {
  preparePromptImages,
  titleFromText,
} from "./message-helpers.js";
import {
  directoryNodes,
  gitChanges,
} from "./project-helpers.js";
import {
  ABORT_STALL_NOTICE_MS,
  ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
  projectMemoryStatusByCwd,
} from "./runtime-constants.js";
import {
  buildRuntimeInspection,
} from "./runtime-inspection.js";
import { RuntimeSessionEvents } from "./runtime-session-events.js";
import {
  ActiveSession,
  ReconstructedSessionState,
  hydrateProjectMemoryStatus,
  memoryStatusForInspection,
  shutdownAgentSession,
} from "./runtime-state.js";
import {
  ensureInside,
  errorDetail,
  errorMessage,
  estimatedTextTokens,
  isRecord,
  safeRealPath,
} from "./runtime-utils.js";
import {
  sessionCacheInspection,
  sessionUsage,
} from "./session-values.js";
import {
  buildRuntimeTokenBreakdown,
  runtimeToolCategory,
  runtimeToolDefinitionTokens,
} from "./runtime-token-breakdown.js";

export class SuoCodeRuntime extends RuntimeSessionEvents {
  async prompt(text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (prompt === "/memory" && !images?.length) return this.runMemoryNow();
    // A goal loop starts the next round as soon as this one settles, so a
    // queued message would sit behind rounds that keep coming. Everything the
    // user sends during goal mode joins the turn that is running instead.
    if (this.goalSteers(active)) {
      await this.steerNow(active, prompt, images, clientMessageId);
      return { accepted: true };
    }
    if (
      active.session.isStreaming
      || this.promptStarting
      || active.promptDrainInProgress
      || active.promptQueue.length > 0
    ) {
      this.enqueuePrompt(active, prompt, images, clientMessageId);
      // Nothing else is guaranteed to come along: the run this prompt is
      // queueing behind may already have settled, in which case its `finally`
      // will never fire again. Ask for a drain now and let the guard decide.
      queueMicrotask(() => { void this.drainPromptQueue(active); });
      return { accepted: true };
    }
    await this.startPrompt(active, prompt, images, clientMessageId, false);
    return { accepted: true };
  }

  /**
   * Withdraw a prompt that is still waiting its turn.
   *
   * Only an item that has not started counts: once `drainPromptQueue` hands one
   * to Pi it stays in the queue until Pi echoes its user message, and pulling it
   * out there would drop the running turn's own bookkeeping.
   */
  async cancelQueuedPrompt(id: string): Promise<{ cancelled: boolean; }> {
    const active = this.requireActive();
    const head = active.promptQueue[0];
    if (active.promptDrainInProgress && head?.id === id) {
      throw new Error("这条消息已经开始发送，无法撤回。");
    }
    if (active.promptQueue.find((item) => item.id === id)?.promoting) {
      throw new Error("这条消息正在介入当前轮次，无法撤回。");
    }
    if (!this.removeQueuedPrompt(active, id)) return { cancelled: false };
    this.rejectClientMessage(active, id);
    if (active.promptQueue.length === 0 && !active.session.isStreaming && !this.promptStarting) {
      this.emitEvent({ type: "run_state", running: false });
    }
    return { cancelled: true };
  }

  async rewindPrompt(entryId: string, text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (active.session.isStreaming) throw new Error("请等待当前回复结束后再回溯。");
    if (this.promptStarting) throw new Error("上一条消息正在启动，请稍候。");
    this.promptStarting = true;
    try {
      await this.applyPendingSessionModel(active);
      const result = await active.session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("未能回溯到所选消息。");
      active.sessionRevision += 1;
      active.summaryActivity = undefined;
      const prepared = await preparePromptImages(images);
      const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
      const hasUserMessage = active.session.messages.some((message) => isRecord(message) && message.role === "user");
      if (!hasUserMessage) active.session.setSessionName(titleFromText(prompt));
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
      // Session-scoped System Prompt, Skill, and MCP policies live on the active
      // Pi branch. Rewinding changes that branch, so refresh the right-hand
      // runtime inspector without blocking the new prompt on MCP discovery.
      void this.refreshRuntimeInspectionSources(active);
      this.queueClientMessage(active, clientMessageId);
      void active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        preflightResult: () => { this.promptStarting = false; },
      }).catch((error) => {
        this.promptStarting = false;
        this.rejectClientMessage(active, clientMessageId);
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
        this.emitEvent({ type: "run_state", running: false });
      });
      return { accepted: true };
    } catch (error) {
      this.promptStarting = false;
      throw error;
    }
  }

  /**
   * Interject a message into the turn that is already running.
   *
   * Pi delivers a steered message at the next turn boundary of the live agent
   * loop, so the correction reaches the model without aborting tool calls,
   * terminals, or subagents the way stopping does. With nothing streaming there
   * is no turn to interject into, and the message takes the ordinary path.
   */
  async steer(text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true; steered: boolean; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (!this.canSteer(active)) {
      await this.prompt(text, images, clientMessageId);
      return { accepted: true, steered: false };
    }
    await this.steerNow(active, prompt, images, clientMessageId);
    return { accepted: true, steered: true };
  }

  /** Whether a live turn exists for a message to join right now. */
  private canSteer(active: ActiveSession): boolean {
    return active.session.isStreaming && !this.promptStarting;
  }

  /** During a running `/goal` loop the queue is bypassed entirely. */
  private goalSteers(active: ActiveSession): boolean {
    return active.goal?.status === "running" && this.canSteer(active);
  }

  private async steerNow(
    active: ActiveSession,
    prompt: string,
    images: PromptImage[] | undefined,
    clientMessageId: string | undefined,
  ): Promise<void> {
    const prepared = await preparePromptImages(images);
    const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
    this.queueClientMessage(active, clientMessageId);
    try {
      await active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        streamingBehavior: "steer",
      });
    } catch (error) {
      this.rejectClientMessage(active, clientMessageId);
      throw error;
    }
  }

  /**
   * Move a queued prompt out of the FIFO and into the running turn.
   *
   * The queue is the safe default; this is the explicit opt-out for a user who
   * wants the message to land now. Without a live turn to join, the prompt only
   * moves to the head of the queue so it is never lost.
   */
  async promoteQueuedPrompt(id: string): Promise<{ promoted: boolean; steered: boolean; }> {
    const active = this.requireActive();
    const index = active.promptQueue.findIndex((item) => item.id === id);
    if (index < 0) return { promoted: false, steered: false };
    if (active.promptDrainInProgress && index === 0) {
      throw new Error("这条消息已经开始发送，无法介入。");
    }
    const item = active.promptQueue[index]!;
    if (item.promoting) return { promoted: true, steered: false };
    if (!this.canSteer(active)) {
      if (index === 0) return { promoted: false, steered: false };
      active.promptQueue.splice(index, 1);
      active.promptQueue.unshift(item);
      this.publishPromptQueue(active);
      return { promoted: true, steered: false };
    }
    // Steering is not instant, and taking the row out first left a stretch where
    // the message was gone from the queue and not yet in the transcript — it
    // read as a message that had been swallowed. Keep the row, flagged, so the
    // UI can show it is on its way, and drop it only once the steer landed.
    item.promoting = true;
    this.publishPromptQueue(active);
    try {
      const result = await this.steer(item.text, item.images, item.id);
      // A steer that could not join a live turn fell back to the queue, which
      // re-uses this very entry; removing it would drop the message instead.
      if (result.steered) this.removeQueuedPrompt(active, id);
      else {
        delete item.promoting;
        this.publishPromptQueue(active);
      }
      return { promoted: true, steered: result.steered };
    } catch (error) {
      delete item.promoting;
      this.publishPromptQueue(active);
      throw error;
    }
  }

  /**
   * Stop everything this session is doing.
   *
   * The request returns as soon as the abort is delivered. Pi's own `abort()`
   * signals the run and then waits for it to settle, and a tool that is slow to
   * honour the signal — a long command, a request already in flight — can hold
   * that wait for a long time. Awaiting it here left the button pressed with
   * nothing to show for it, which reads as "stop did nothing"; the run state
   * events report when the turn has actually ended.
   */
  async abort(): Promise<{ aborted: boolean; aborting: boolean; cancelledQueue: number; }> {
    const active = this.requireActive();
    // Stopping is how a user ends a `/goal` loop: without this the loop would
    // simply start the next round after the aborted turn settles.
    const stoppedGoal = await this.stopGoalIfRunning(active);
    // Stopping means the conversation stops. Anything still waiting in the FIFO
    // would otherwise start the moment the aborted turn settles, which looks
    // exactly like the stop having been ignored.
    const cancelledQueue = this.dropQueuedPrompts(active);
    if (!active.session.isStreaming) {
      // A stop pressed against a run this session no longer has still has a job
      // to do: publish what is actually true, so a stale spinner clears.
      this.publishRunState(active);
      return { aborted: stoppedGoal || cancelledQueue > 0, aborting: false, cancelledQueue };
    }
    active.aborting = true;
    this.publishRunState(active);
    const stallNotice = setTimeout(() => this.reportSlowAbort(active), ABORT_STALL_NOTICE_MS);
    stallNotice.unref?.();
    void active.session.abort()
      .catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      })
      .finally(() => {
        clearTimeout(stallNotice);
        active.aborting = false;
        if (this.active === active) this.publishRunState(active);
      });
    return { aborted: true, aborting: true, cancelledQueue };
  }

  /**
   * Say why a stop is taking so long.
   *
   * The abort itself was delivered; what is left is a tool call that has not
   * come back yet. Naming it is the difference between "stop is broken" and
   * "stop is waiting for this command".
   */
  private reportSlowAbort(active: ActiveSession): void {
    if (this.active !== active || !active.aborting) return;
    const running = [...new Set(
      [...active.tools.values()].filter((tool) => tool.status === "running").map((tool) => tool.name),
    )];
    this.emitEvent({
      type: "runtime_notice",
      level: "info",
      message: running.length
        ? `正在停止：还在等 ${running.join("、")} 收尾`
        : "正在停止：已经发出中断，正在等这一轮收尾",
    });
  }

  /** Emit the run state this session actually has, whatever the UI believes. */
  private publishRunState(active: ActiveSession): void {
    this.emitEvent({
      type: "run_state",
      running: active.session.isStreaming || this.promptStarting || active.promptQueue.length > 0,
      aborting: active.aborting === true,
    });
    void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot })).catch(() => undefined);
  }

  /**
   * Drop every prompt that has not started yet.
   *
   * The head is kept while a drain owns it: that one is the turn being aborted,
   * and Pi still has to echo its user message.
   */
  private dropQueuedPrompts(active: ActiveSession): number {
    const keepHead = active.promptDrainInProgress && active.promptQueue.length > 0;
    const dropped = active.promptQueue.splice(keepHead ? 1 : 0);
    if (!dropped.length) return 0;
    this.publishPromptQueue(active);
    for (const item of dropped) this.rejectClientMessage(active, item.id);
    this.emitEvent({
      type: "runtime_notice",
      level: "info",
      message: `已停止，${dropped.length} 条排队消息未发送`,
    });
    return dropped.length;
  }

  /** End the `/goal` loop of this session, if one is running. */
  async stopGoal(): Promise<{ stopped: boolean; }> {
    const active = this.requireActive();
    return { stopped: await this.stopGoalIfRunning(active) };
  }

  private async stopGoalIfRunning(active: ActiveSession): Promise<boolean> {
    if (active.goal?.status !== "running") return false;
    // Extension commands run immediately, even while a turn is streaming.
    await active.session.prompt("/goal stop").catch(() => undefined);
    return active.goal?.status !== "running";
  }

  protected requireActive(): ActiveSession {
    if (!this.active) throw new Error("请先打开项目并创建会话。");
    return this.active;
  }

  async refreshProject(): Promise<ProjectSnapshot> {
    const active = this.requireActive();
    const [files, changes] = await Promise.all([directoryNodes(active.cwd), gitChanges(active.cwd)]);
    active.project = {
      cwd: active.cwd,
      files,
      changes,
      terminals: [...active.terminals.values()].sort((a, b) => b.startedAt - a.startedAt),
      plan: [...active.plan],
      planApproval: active.planApproval,
      refreshedAt: Date.now(),
    };
    this.emitEvent({ type: "project_updated", project: active.project });
    return active.project;
  }

  async listProjectDirectory(path: string): Promise<FileNode[]> {
    const active = this.requireActive();
    return directoryNodes(active.cwd, path);
  }

  protected publishProjectFromMemory(): void {
    const active = this.active;
    if (!active) return;
    active.project = {
      ...active.project,
      terminals: [...active.terminals.values()].sort((a, b) => b.startedAt - a.startedAt),
      plan: [...active.plan],
      planApproval: active.planApproval,
      refreshedAt: Date.now(),
    };
    this.emitEvent({ type: "project_updated", project: active.project });
  }

  protected scheduleProjectRefresh(): void {
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    this.projectRefreshTimer = setTimeout(() => {
      void this.refreshProject().catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      });
    }, 180);
  }

  async readProjectFile(path: string, maxBytes = 512 * 1024): Promise<{ path: string; content: string; truncated: boolean; }> {
    const active = this.requireActive();
    const target = ensureInside(active.cwd, path);
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("所选路径不是文件。");
    const buffer = await readFile(target);
    const limit = Math.max(1, Math.min(maxBytes, 2 * 1024 * 1024));
    const truncated = buffer.byteLength > limit;
    const content = buffer.subarray(0, limit).toString("utf8");
    return { path: relative(active.cwd, target), content, truncated };
  }

  async snapshot(reconstructedState?: ReconstructedSessionState): Promise<SessionSnapshot> {
    const active = this.requireActive();
    const reconstructed = reconstructedState ?? this.reconstructState(active.session);
    const header = active.session.sessionManager.getHeader();
    const now = new Date();
    const sessionFile = active.session.sessionFile ?? "";
    let updatedAt = now.toISOString();
    if (sessionFile && existsSync(sessionFile)) {
      try {
        updatedAt = statSync(sessionFile).mtime.toISOString();
      } catch {
        // The session may be between an atomic write and rename; the live timestamp is sufficient.
      }
    }
    const firstUserMessage = reconstructed.messages.find((message) => message.role === "user");
    const summary: SessionSummary = {
      id: active.session.sessionId,
      path: sessionFile,
      cwd: active.cwd,
      title: active.session.sessionName || titleFromText(firstUserMessage?.text ?? ""),
      createdAt: header?.timestamp ?? now.toISOString(),
      updatedAt,
      messageCount: active.session.messages.length,
    };
    const messages = reconstructed.messages;
    if (active.activeAssistantMessage && !messages.some((message) => message.id === active.activeAssistantMessage!.id)) {
      const maxOrder = messages.reduce((max, message) => Math.max(max, message.order), -1);
      messages.push({ ...active.activeAssistantMessage, order: maxOrder + 1 });
    }
    const model = active.session.model;
    const usage = sessionUsage(active.session);
    active.responseMetrics = reconstructed.responseMetrics ?? active.responseMetrics;
    active.responseMetricsHistory = reconstructed.responseMetricsHistory;
    const projectedTools = new Map(reconstructed.tools);
    // A running tool has no toolResult yet, so branch reconstruction cannot see
    // it. Preserve the live projection across Renderer reconnects and HMR.
    for (const [id, tool] of active.tools) {
      if (tool.status === "running") projectedTools.set(id, { ...tool, args: { ...tool.args } });
    }
    return {
      messageRevision: active.messageRevision,
      session: summary,
      messages,
      promptQueue: active.promptQueue.map((item) => ({
        ...item,
        images: item.images?.map((image) => ({ ...image })),
      })),
      tools: [...projectedTools.values()].sort((a, b) => a.order - b.order),
      subagents: [...active.subagents.values()].sort((left, right) => left.updatedAt - right.updatedAt || left.index - right.index),
      project: active.project,
      model: model
        ? { provider: model.provider, id: model.id, name: model.name || model.id, reasoning: Boolean(model.reasoning) }
        : undefined,
      pendingModel: active.pendingModel,
      thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
      fast: active.fastState?.enabled ?? false,
      goal: active.goal,
      aborting: active.aborting === true,
      responseMetrics: active.responseMetrics,
      responseMetricsHistory: active.responseMetricsHistory,
      contextUsage: usage.contextUsage,
      tokenUsage: usage.tokenUsage,
      runtimeInspection: this.runtimeInspection(active),
      running: active.session.isStreaming || this.promptStarting || active.promptQueue.length > 0,
    };
  }

  protected runtimeInspection(active: ActiveSession): RuntimeInspectionSnapshot {
    const base = buildRuntimeInspection(
      active.session.sessionManager,
      active.sessionRevision,
      active.summaryActivity,
    );
    const messages: readonly unknown[] = active.session.isStreaming && active.bridgeState?.contextMessages?.length
      ? active.bridgeState.contextMessages
      : active.session.messages;
    const estimatedMessages = messages.reduce<number>((total, message) => {
      try {
        return total + estimateTokens(message as Parameters<typeof estimateTokens>[0]);
      } catch {
        return total + estimatedTextTokens(message);
      }
    }, 0);
    const activeToolNames = new Set(active.session.getActiveToolNames());
    const mcpServerNames = active.mcpStatus?.servers.map((server) => server.name) ?? [];
    const tools: RuntimeToolDefinition[] = active.session.getAllTools().map((tool) => {
      const source = tool.sourceInfo.source || tool.sourceInfo.path || "unknown";
      const category = runtimeToolCategory(tool, mcpServerNames);
      return {
        name: tool.name,
        description: tool.description,
        source,
        active: activeToolNames.has(tool.name),
        category,
        estimatedTokens: runtimeToolDefinitionTokens(tool),
      };
    }).sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
    const disabledSkills = new Set(active.bridgeState?.disabledSkills ?? []);
    const readSkills = new Set((active.bridgeState?.readSkills ?? []).map((path) => resolve(path)));
    const skills: RuntimeSkillState[] = (active.skillConfiguration?.skills ?? []).map((skill) => {
      const resolvedPath = resolve(skill.filePath);
      const sessionEnabled = skill.enabled && !disabledSkills.has(skill.filePath) && !disabledSkills.has(resolvedPath);
      return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        source: skill.source,
        globallyEnabled: skill.enabled,
        sessionEnabled,
        publishedToModel: sessionEnabled && !skill.disableModelInvocation,
        readInSession: readSkills.has(resolvedPath),
        estimatedMetadataTokens: estimatedTextTokens({
          name: skill.name,
          description: skill.description,
          location: skill.filePath,
        }),
      };
    });
    const effectiveSystemPrompt = active.bridgeState?.effectiveSystemPrompt || active.session.systemPrompt || undefined;
    const systemPromptTokens = effectiveSystemPrompt ? estimatedTextTokens(effectiveSystemPrompt) : undefined;
    const toolDefinitionTokens = tools.filter((tool) => tool.active).reduce((total, tool) => total + tool.estimatedTokens, 0);
    const tokenBreakdown = buildRuntimeTokenBreakdown(
      messages,
      systemPromptTokens ?? 0,
      tools,
      mcpServerNames,
    );
    const usage = sessionUsage(active.session);
    const { cacheHitRate, cache } = sessionCacheInspection(active.session, active.responseMetrics);
    const sharedMemoryStatus = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
    const memoryStatus = memoryStatusForInspection(active.memoryStatus, sharedMemoryStatus);
    return {
      ...base,
      effectiveSystemPrompt,
      systemPromptOverride: Boolean(active.bridgeState?.systemPromptOverride),
      estimates: {
        systemPrompt: systemPromptTokens,
        toolDefinitions: toolDefinitionTokens || undefined,
        messages: estimatedMessages || undefined,
        total: usage.contextUsage?.tokens ?? (((systemPromptTokens ?? 0) + toolDefinitionTokens + estimatedMessages) || undefined),
      },
      cacheHitRate,
      cache,
      tokenBreakdown,
      tools,
      skills,
      mcp: active.mcpStatus,
      memory: memoryStatus ? hydrateProjectMemoryStatus(memoryStatus) : undefined,
      capabilities: {
        editSystemPrompt: true,
        removeOriginalSessionItems: false,
        removeOriginalSessionItemsReason: ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
      },
    };
  }

  protected publishRuntimeInspection(active: ActiveSession): void {
    this.emitEvent({ type: "runtime_inspection_updated", inspection: this.runtimeInspection(active) });
  }

  async dispose(): Promise<void> {
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    if (this.resourceReloadTimer) clearTimeout(this.resourceReloadTimer);
    for (const flow of this.providerAuthFlows.values()) {
      const pending = this.clearProviderAuthPrompt(flow);
      flow.controller.abort();
      pending?.reject(new Error("运行时已关闭，订阅登录已取消。"));
    }
    this.providerAuthFlows.clear();
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.unsubscribe();
      try {
        await shutdownAgentSession(active.session, "quit");
      } finally {
        active.eventBus.clear();
      }
    }
  }
}
