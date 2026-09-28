import {
  manualCompactionCommand,
  type FileNode,
  type ProjectSnapshot,
  type PromptDocument,
  type PromptImage,
  type RuntimeInspectionSnapshot,
  type SessionSnapshot,
  type SessionSummary,
  type ThinkingLevel,
} from "@coilcoil/runtime-protocol";
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
} from "node:path";
import {
  manualCompactionErrorMessage,
  manualCompactionRefusal,
} from "./manual-compaction.js";
import {
  preparePromptImages,
  promptDocumentPrompt,
  titleFromText,
} from "./message-helpers.js";
import {
  directoryNodes,
  readGitChanges,
} from "./project-helpers.js";
import {
  ABORT_STALL_NOTICE_MS,
} from "./runtime-constants.js";
import {
  buildRuntimeInspectionSnapshot,
} from "./runtime-inspection-snapshot.js";
import { RuntimeSessionEvents } from "./runtime-session-events.js";
import {
  ActiveSession,
  ReconstructedSessionState,
  shutdownAgentSession,
} from "./runtime-state.js";
import {
  ensureInside,
  errorDetail,
  errorMessage,
  isRecord,
} from "./runtime-utils.js";
import {
  sessionUsage,
} from "./session-values.js";

export class CoilCoilRuntime extends RuntimeSessionEvents {
  async prompt(text: string, images?: PromptImage[], clientMessageId?: string, promptDocument?: PromptDocument): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const documentPrompt = promptDocumentPrompt(promptDocument, images);
    const promptImages = documentPrompt.images;
    const prompt = documentPrompt.text.trim() || text.trim() || (promptImages?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (prompt === "/memory" && !images?.length) return this.runMemoryNow();
    // Both manual commands are intercepted here rather than in the composer so
    // that every client — desktop, the remote browser, anything speaking the
    // runtime protocol — gets them from one place.
    const compaction = images?.length ? undefined : manualCompactionCommand(prompt);
    if (compaction) return this.compactNow(compaction.instructions);
    // A goal loop starts the next round as soon as this one settles, so a
    // queued message would sit behind rounds that keep coming. Everything the
    // user sends during goal mode joins the turn that is running instead.
    if (this.goalSteers(active)) {
      await this.steerNow(active, prompt, promptImages, clientMessageId, promptDocument);
      return { accepted: true };
    }
    if (
      active.session.isStreaming
      || this.promptStarting
      || active.promptDrainInProgress
      || active.promptQueue.length > 0
      // A manual compaction is rewriting the very history this prompt would be
      // appended to. Queue behind it instead of racing it.
      || active.compacting
    ) {
      this.enqueuePrompt(active, prompt, promptImages, clientMessageId, promptDocument);
      // Nothing else is guaranteed to come along: the run this prompt is
      // queueing behind may already have settled, in which case its `finally`
      // will never fire again. Ask for a drain now and let the guard decide.
      queueMicrotask(() => { void this.drainPromptQueue(active); });
      return { accepted: true };
    }
    await this.startPrompt(active, prompt, promptImages, clientMessageId, false, promptDocument);
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
      this.publishRunning(false, "queue_cancelled", { id });
    }
    return { cancelled: true };
  }

  async rewindPrompt(entryId: string, text: string, images?: PromptImage[], clientMessageId?: string, promptDocument?: PromptDocument, restoreCode = false): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    // Stop returns before Pi settles; rewinding must wait before changing the branch.
    if (active.abortInFlight) {
      await active.abortInFlight;
      if (this.active !== active) throw new Error("会话已切换，未能回溯消息。");
    }
    const documentPrompt = promptDocumentPrompt(promptDocument, images);
    const promptImages = documentPrompt.images;
    const prompt = documentPrompt.text.trim() || text.trim() || (promptImages?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (active.session.isStreaming) throw new Error("请等待当前回复结束后再回溯。");
    if (this.promptStarting) throw new Error("上一条消息正在启动，请稍候。");
    // A stop belongs to the prompt it was pressed against, never to this one.
    active.abortOnStart = false;
    this.promptStarting = true;
    this.publishRunning(true, "prompt_starting", { queued: false });
    try {
      await this.applyPendingSessionModel(active);
      const result = await this.navigateWithCheckpoint(active, entryId, restoreCode);
      if (result.cancelled) throw new Error("未能回溯到所选消息。");
      active.sessionRevision += 1;
      active.summaryActivity = undefined;
      const prepared = await preparePromptImages(promptImages);
      const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
      const hasUserMessage = active.session.messages.some((message) => message.role === "user");
      if (!hasUserMessage && !active.titleManuallySet && !active.titleAttempted) {
        active.session.setSessionName(titleFromText(prompt));
        active.titlePending = true;
      }
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
      // Session-scoped System Prompt, Skill, and MCP policies live on the active
      // Pi branch. Rewinding changes that branch, so refresh the right-hand
      // runtime inspector without blocking the new prompt on MCP discovery.
      void this.refreshRuntimeInspectionSources(active);
      this.queueClientMessage(active, clientMessageId, expandedPrompt, promptDocument);
      void active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        preflightResult: () => { this.promptStarting = false; },
      }).catch((error) => {
        this.promptStarting = false;
        this.rejectClientMessage(active, clientMessageId);
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
        this.publishRunning(false, "rewind_failed");
      });
      return { accepted: true };
    } catch (error) {
      this.promptStarting = false;
      if (this.active === active) this.publishRunState(active);
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
  async steer(text: string, images?: PromptImage[], clientMessageId?: string, promptDocument?: PromptDocument): Promise<{ accepted: true; steered: boolean; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const documentPrompt = promptDocumentPrompt(promptDocument, images);
    const promptImages = documentPrompt.images;
    const prompt = documentPrompt.text.trim() || text.trim() || (promptImages?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (!this.canSteer(active)) {
      await this.prompt(text, promptImages, clientMessageId, promptDocument);
      return { accepted: true, steered: false };
    }
    await this.steerNow(active, prompt, promptImages, clientMessageId, promptDocument);
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
    promptDocument?: PromptDocument,
  ): Promise<void> {
    const prepared = await preparePromptImages(images);
    const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
    this.queueClientMessage(active, clientMessageId, expandedPrompt, promptDocument);
    try {
      await active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        streamingBehavior: "steer",
      });
    } catch (error) {
      this.rejectClientMessage(active, clientMessageId);
      throw error;
    }
    // Pi has the message, but it only reaches the model at the end of the turn
    // the tools are still inside. Announcing it here is what keeps it visible
    // for that stretch: it has left the queue, and it is not in the transcript
    // yet, so without this it reads as a message that was swallowed.
    if (clientMessageId) {
      const steering = {
        id: clientMessageId,
        text: expandedPrompt,
        promptDocument: promptDocument ? structuredClone(promptDocument) : undefined,
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ mimeType, data })) : undefined,
        timestamp: Date.now(),
      };
      // 事件只对「此刻正开着这个会话」的界面有用。同时记进会话状态，快照才带得走
      // ——否则切去别的对话再切回来，这条介入就从界面上消失了（它还会照常生效）。
      // 清除时机和 pendingUserPrompts 一致：Pi 把这条用户消息回显出来就删。
      if (!active.steeringMessages.some((item) => item.id === clientMessageId)) {
        active.steeringMessages.push(steering);
      }
      this.emitEvent({
        type: "message_steering",
        ...steering,
        revision: ++active.messageRevision,
      });
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
      const result = await this.steer(item.text, item.images, item.id, item.promptDocument);
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
   * Summarize the context now, because the user said so.
   *
   * The automatic passes only fire once the context is nearly full, which is
   * the worst moment to discover they were needed. `/compact` is the same
   * machinery, started by hand at a moment the user chose. Why it may refuse,
   * and in what words, lives in `manualCompactionRefusal`.
   */
  async compactNow(instructions?: string): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const refusal = manualCompactionRefusal({
      compacting: active.compacting === true,
      summarizing: active.summaryActivity?.status === "running",
      busy: active.session.isStreaming || this.promptStarting || active.promptDrainInProgress === true,
      hasModel: Boolean(active.session.model),
      messages: active.session.messages.length,
      alreadyCompacted: active.session.sessionManager.getBranch().at(-1)?.type === "compaction",
    });
    if (refusal) throw new Error(refusal);
    active.compacting = true;
    this.log.info("compaction", "manual_compaction_started", { withInstructions: Boolean(instructions) });
    // Compaction is not streaming, so nothing else would make the session look
    // busy: no spinner, no stop button, for a request that can run for minutes.
    this.publishRunState(active);
    // Deliberately not awaited. The reply to this request is not where the wait
    // belongs — the transcript already draws a live rule from Pi's own
    // compaction events, and the stop button cancels it through the same path
    // an automatic compaction uses.
    void active.session.compact(instructions)
      .catch((error: unknown) => {
        const raw = errorMessage(error);
        // 我们的压缩扩展失败时也是交回「取消」；那不是用户取消的，要说出真实原因。
        const failure = active.compactionFailure && Date.now() - active.compactionFailure.at < 30_000
          ? active.compactionFailure.message
          : undefined;
        active.compactionFailure = undefined;
        const cancelled = !failure && (raw.includes("Compaction cancelled") || (error instanceof Error && error.name === "AbortError"));
        this.log.log(cancelled ? "info" : "error", "compaction", "manual_compaction_failed", { error: failure ?? raw, cancelled });
        this.emitEvent({
          type: "runtime_notice",
          level: cancelled ? "info" : "error",
          message: failure ? `上下文压缩失败，会话保持原样：${failure}` : manualCompactionErrorMessage(raw),
        });
      })
      .finally(() => {
        active.compacting = false;
        if (this.active !== active) return;
        this.publishRunState(active);
        // Anything typed during the compaction queued behind it; nothing else
        // is coming to wake that queue up.
        if (active.promptQueue.length > 0) void this.drainPromptQueue(active);
      });
    return { accepted: true };
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
    const requestedAt = Date.now();
    this.log.info("abort", "abort_requested", {
      streaming: active.session.isStreaming,
      aborting: active.aborting === true,
      queued: active.promptQueue.length,
      runningTools: [...active.tools.values()].filter((tool) => tool.status === "running").map((tool) => tool.name),
    });
    const stoppedGoal = await this.stopGoalIfRunning(active);
    const cancelledQueue = this.dropQueuedPrompts(active) + this.clearSteeredQueue(active);
    const cancelledSummary = this.cancelSummarization(active);
    if (active.abortInFlight) {
      return { aborted: true, aborting: true, cancelledQueue };
    }
    if (!active.session.isStreaming) {
      const pending = this.promptStarting;
      if (pending) {
        active.abortOnStart = true;
        active.aborting = true;
      }
      this.log.info("abort", "abort_without_live_run", { cancelledQueue, stoppedGoal, cancelledSummary, pending });
      this.publishRunState(active);
      return {
        aborted: stoppedGoal || cancelledQueue > 0 || cancelledSummary || pending,
        aborting: pending,
        cancelledQueue,
      };
    }
    active.aborting = true;
    this.publishRunState(active);
    const stallNotice = setTimeout(() => this.reportSlowAbort(active), ABORT_STALL_NOTICE_MS);
    stallNotice.unref?.();
    const abortInFlight = active.session.abort()
      .catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      })
      .finally(() => {
        clearTimeout(stallNotice);
        if (active.abortInFlight === abortInFlight) active.abortInFlight = undefined;
        active.aborting = false;
        // The gap between this and `abort_requested` is the whole of "I pressed
        // stop and nothing happened": it is time spent inside a tool call that
        // had already been dispatched, not a click that went missing.
        this.log.info("abort", "abort_settled", { elapsedMs: Date.now() - requestedAt });
        if (this.active === active) this.publishRunState(active);
      });
    active.abortInFlight = abortInFlight;
    void abortInFlight;
    return { aborted: true, aborting: true, cancelledQueue };
  }

  /**
   * Cancel a summarization the stop is really aimed at.
   *
   * Compaction is a model request of its own, sitting on either side of a turn:
   * Pi runs it before it sends a prompt and again after a run ends, and on a
   * full context it takes minutes. `AgentSession.abort()` does not touch it —
   * it aborts the agent run and then waits for the session to go idle, which a
   * running compaction holds — so a stop pressed during one used to do nothing
   * at all until the summary finished. Cancelling it is what makes the stop
   * land; the context stays uncompacted and the next prompt compacts again.
   */
  protected cancelSummarization(active: ActiveSession): boolean {
    const summary = active.summaryActivity;
    if (summary?.status !== "running") return false;
    if (summary.kind === "branch_summary") active.session.abortBranchSummary();
    else active.session.abortCompaction();
    this.log.info("abort", "summarization_cancelled", { kind: summary.kind, reason: summary.reason });
    return true;
  }

  /**
   * Cancel a summarization that a stop already in flight is aimed at.
   *
   * A stop taken during a long tool call ends the run, but the message Pi then
   * checks is the assistant turn that called the tool, not an aborted one, so
   * the threshold check runs as if nothing had happened and starts a summary
   * for the turn the user just stopped. That summary holds the stop's own wait
   * open for as long as it takes — minutes on a full context, which is the
   * whole of "stop did nothing until the command finished".
   *
   * Pi creates the controller this cancels immediately after it announces the
   * summary, so the cancel is scheduled rather than taken on the spot.
   */
  protected cancelSummarizationForStop(active: ActiveSession): void {
    const timer = setTimeout(() => {
      if (this.active !== active || active.aborting !== true) return;
      this.cancelSummarization(active);
    }, 0);
    timer.unref?.();
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
    this.log.warn("abort", "abort_stalled", { waitingOn: running });
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
    const running = active.session.isStreaming
      || this.promptStarting
      || active.promptQueue.length > 0
      || active.compacting === true;
    this.publishRunning(running, "publish_run_state", {
      aborting: active.aborting === true,
      streaming: active.session.isStreaming,
      promptStarting: this.promptStarting,
      compacting: active.compacting === true,
      queued: active.promptQueue.length,
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
    const [files, changes] = await Promise.all([directoryNodes(active.cwd), readGitChanges(active.cwd)]);
    active.project = {
      cwd: active.cwd,
      files,
      ...changes,
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
    const usage = sessionUsage(active.session, active.contextClearings);
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
      agentMode: active.bridgeState?.agentMode ?? "standard",
      messages,
      promptQueue: active.promptQueue.map((item) => ({
        ...item,
        promptDocument: item.promptDocument ? structuredClone(item.promptDocument) : undefined,
        images: item.images?.map((image) => ({ ...image })),
      })),
      steering: active.steeringMessages.map((item) => ({
        ...item,
        promptDocument: item.promptDocument ? structuredClone(item.promptDocument) : undefined,
        images: item.images?.map((image: PromptImage) => ({ ...image })),
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
      running: active.session.isStreaming
        || this.promptStarting
        || active.promptQueue.length > 0
        || active.compacting === true,
    };
  }

  protected runtimeInspection(active: ActiveSession): RuntimeInspectionSnapshot {
    const snapshot = buildRuntimeInspectionSnapshot(active);
    return {
      ...snapshot,
      subagent: this.readSubagentConfiguration(),
      sessionNaming: this.readSessionNamingConfiguration(),
      summarizationModel: this.summarizationModelState(),
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
    // MCP servers are child processes and a loopback listener; both outlive the
    // runtime unless they are told to go.
    await this.closeMcp();
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
