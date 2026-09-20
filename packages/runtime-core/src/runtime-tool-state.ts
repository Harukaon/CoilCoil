import {
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  type ChatMessage,
  type PlanApprovalState,
  type PlanExecutionTarget,
  type PromptImage,
  type PromptDocument,
  type SubagentActivity,
  type TerminalRun,
  type TodoItem,
  type ToolRun,
} from "@coilcoil/runtime-protocol";
import {
  AssistantToolCall,
  assistantToolCalls,
  contentParts,
  extractExitCode,
  mapMessage,
  promptDocumentFromUnknown,
  messageTimestamp,
  normalizeTodoPlan,
  restoredSubagentActivity,
  subagentActivitiesFromPayload,
  subagentActivityFromDetails,
} from "./message-helpers.js";
import {
  ABANDONED_TOOL_OUTPUT,
  isShellToolName,
  MAX_TERMINAL_OUTPUT,
  PLAN_ENTRY_TYPE,
  PROMPT_DOCUMENT_ENTRY_TYPE,
  PLAN_RPC_REQUEST_CHANNEL,
  SUBAGENT_RPC_REQUEST_CHANNEL,
  SUBAGENT_RUN_ENTRY_TYPE,
} from "./runtime-constants.js";
import { RuntimeSessions } from "./runtime-sessions.js";
import {
  ActiveSession,
  ReconstructedSessionState,
  planApprovalState,
} from "./runtime-state.js";
import {
  clampText,
  isRecord,
  stringValue,
} from "./runtime-utils.js";
import { ToolRunIds } from "./tool-run-ids.js";
import {
  liveToolPurpose,
  purposeFromArgs,
  restoredPurposeFor,
  restoredResponseMetrics,
  restoredToolPurposes,
} from "./session-values.js";
import {
  TERMINAL_RUN_ENTRY_TYPE,
  terminalIdFromResult,
  terminalOwnerToolIdFromData,
  terminalOutputFromResult,
  terminalRunFromData,
  terminalStatusFromResult,
} from "./terminal-values.js";

/**
 * Present a persisted `custom_message` entry in the shape `mapMessage` reads.
 *
 * Pi stores these with the payload on the entry itself instead of under a
 * `message` field, so reconstruction has to rebuild the message around it.
 */
function customEntryMessage(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry) || entry.type !== "custom_message") return undefined;
  return {
    role: "custom",
    customType: entry.customType,
    content: entry.content,
    display: entry.display,
    details: entry.details,
    timestamp: entry.timestamp,
  };
}

export abstract class RuntimeToolState extends RuntimeSessions {
  protected reconstructState(session: AgentSession): ReconstructedSessionState {
    const messages: ChatMessage[] = [];
    const tools = new Map<string, ToolRun>();
    const subagents = new Map<string, SubagentActivity>();
    const terminals = new Map<string, TerminalRun>();
    let plan: TodoItem[] = [];
    let planApproval: PlanApprovalState | undefined;
    const promptDocumentsByEntryId = new Map<string, PromptDocument>();
    // `rawId` is kept because the tool-purpose audit entries are keyed by the id
    // the provider reported, not by the run id derived from it.
    const calls = new Map<string, AssistantToolCall & { order: number; rawId: string; }>();
    const purposes = restoredToolPurposes(session);
    // Replaying in branch order reproduces exactly the begin/end sequence the
    // live projection sees, so a restored session numbers repeated provider tool
    // call ids the same way the running one will continue numbering them.
    const toolRunIds = new ToolRunIds();
    let order = 0;

    // `custom_message` entries carry the cards the workflow raises on its own —
    // a finished background terminal, for one. They are persisted under their own
    // entry type rather than as a message, so a walk that only took `message`
    // rebuilt the transcript without them: the card appeared while the turn ran
    // and vanished the moment the turn's end replaced it with a fresh snapshot.
    const branch = session.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== PROMPT_DOCUMENT_ENTRY_TYPE || !isRecord(entry.data)) continue;
      const messageEntryId = stringValue(entry.data.messageEntryId);
      const document = promptDocumentFromUnknown(entry.data.document);
      if (messageEntryId && document) promptDocumentsByEntryId.set(messageEntryId, document);
    }
    const branchMessages = branch
      .filter((entry) => entry.type === "message" || entry.type === "custom_message");
    for (const [index, entry] of branchMessages.entries()) {
      const rawMessage = customEntryMessage(entry) ?? (entry as { message?: unknown }).message;
      if (!isRecord(rawMessage)) continue;
      const liveMessageId = this.active?.messageIds.get(rawMessage);
      const mapped = mapMessage(rawMessage, liveMessageId ?? `history-${entry.id}`, order, entry.id, promptDocumentsByEntryId.get(entry.id));
      if (mapped && mapped.role !== "tool" && (mapped.role === "user" || mapped.text || mapped.thinking)) {
        messages.push(mapped);
        order += 1;
      }
      for (const call of assistantToolCalls(rawMessage)) {
        const runId = toolRunIds.begin(call.id);
        if (calls.has(runId)) continue;
        calls.set(runId, { ...call, id: runId, rawId: call.id, order: order++ });
      }
      if (rawMessage.role !== "toolResult") continue;
      const rawId = stringValue(rawMessage.toolCallId);
      const id = rawId ? toolRunIds.end(rawId) : `tool-${tools.size + 1}`;
      const call = calls.get(id);
      const name = stringValue(rawMessage.toolName) || call?.name || "tool";
      const args = call?.args ?? {};
      const output = clampText(contentParts(rawMessage.content).text, MAX_TERMINAL_OUTPUT);
      const failed = rawMessage.isError === true;
      tools.set(id, {
        id,
        order: call?.order ?? order++,
        name,
        label: this.toolLabel(name, args, id, restoredPurposeFor(purposes, id, name), session.sessionId),
        args,
        output,
        status: failed ? "failed" : "succeeded",
        startedAt: call?.timestamp ?? messageTimestamp(rawMessage),
        endedAt: messageTimestamp(rawMessage),
      });
      const restoredPlan = normalizeTodoPlan(isRecord(rawMessage.details) ? rawMessage.details.plan : undefined);
      if (name === "todo" && restoredPlan) plan = restoredPlan;
      if (name === "plan") {
        const restoredApproval = planApprovalState(isRecord(rawMessage.details) ? rawMessage.details.plan ?? rawMessage.details : undefined);
        if (restoredApproval) planApproval = restoredApproval;
      }
      if (name === "subagent") {
        const activity = subagentActivityFromDetails(rawMessage.details, id);
        if (activity) subagents.set(activity.id, restoredSubagentActivity(activity));
      }
      if (isShellToolName(name) || (name === "terminal" && args.action === "start")) {
        const terminalId = terminalIdFromResult(rawMessage.details) ?? id;
        const terminalStatus = terminalStatusFromResult(rawMessage.details, failed);
        terminals.set(terminalId, {
          id: terminalId,
          command: stringValue(args.command) || name,
          cwd: stringValue(args.cwd) || this.active?.cwd || session.sessionManager.getCwd(),
          output: clampText(terminalOutputFromResult(rawMessage.details) ?? output, MAX_TERMINAL_OUTPUT),
          status: terminalStatus,
          startedAt: call?.timestamp ?? messageTimestamp(rawMessage),
          endedAt: terminalStatus === "running" ? undefined : messageTimestamp(rawMessage),
          exitCode: extractExitCode(rawMessage.details),
        });
      }
    }
    for (const call of calls.values()) {
      if (tools.has(call.id)) continue;
      const output = ABANDONED_TOOL_OUTPUT;
      tools.set(call.id, {
        id: call.id,
        order: call.order,
        name: call.name,
        label: this.toolLabel(call.name, call.args, call.id, restoredPurposeFor(purposes, call.id, call.name), session.sessionId),
        args: call.args,
        output,
        status: "failed",
        startedAt: call.timestamp,
        endedAt: call.timestamp,
      });
      if (isShellToolName(call.name) || (call.name === "terminal" && call.args.action === "start")) {
        terminals.set(call.id, {
          id: call.id,
          command: stringValue(call.args.command) || call.name,
          cwd: stringValue(call.args.cwd) || this.active?.cwd || session.sessionManager.getCwd(),
          output,
          status: "failed",
          startedAt: call.timestamp,
          endedAt: call.timestamp,
        });
      }
    }
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_RUN_ENTRY_TYPE) continue;
      for (const activity of subagentActivitiesFromPayload({ activities: [entry.data] })) {
        subagents.set(activity.id, restoredSubagentActivity(activity));
      }
    }
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY_TYPE) continue;
      const restored = planApprovalState(entry.data);
      if (restored) planApproval = restored;
    }
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== TERMINAL_RUN_ENTRY_TYPE) continue;
      const terminal = terminalRunFromData(entry.data);
      if (terminal) {
        const ownerToolCallId = terminalOwnerToolIdFromData(entry.data);
        if (ownerToolCallId && ownerToolCallId !== terminal.id) terminals.delete(ownerToolCallId);
        terminals.set(terminal.id, terminal);
      }
    }
    const responseMetricsHistory = restoredResponseMetrics(session);
    return {
      messages,
      tools,
      subagents,
      terminals,
      plan,
      nextTimelineOrder: order,
      toolRunIds,
      responseMetrics: responseMetricsHistory.at(-1),
      responseMetricsHistory,
      planApproval,
      promptDocumentsByEntryId,
    };
  }

  protected toolLabel(
    name: string,
    args: Record<string, unknown>,
    toolCallId?: string,
    restoredPurpose?: string,
    sessionId?: string,
  ): string {
    const purpose = restoredPurpose ?? liveToolPurpose(sessionId, toolCallId) ?? purposeFromArgs(args);
    if (purpose) return purpose;
    if (isShellToolName(name)) return `运行 ${stringValue(args.command) || "命令"}`;
    if (name === "read") return `查看 ${stringValue(args.path) || "文件"}`;
    if (name === "write") return `写入 ${stringValue(args.path) || "文件"}`;
    if (name === "edit") return `编辑 ${stringValue(args.path) || "文件"}`;
    if (name === "grep") return `搜索 ${stringValue(args.pattern) || "项目"}`;
    if (name === "ls") return `查看 ${stringValue(args.path) || "目录"}`;
    if (name === "todo") return "更新 Todo";
    if (name === "plan") return "创建执行计划";
    if (name === "terminal") return `运行 ${stringValue(args.command) || stringValue(args.action) || "终端命令"}`;
    return `调用 ${name.replace(/[_-]+/g, " ")}`;
  }

  protected projectToolStart(active: ActiveSession, call: AssistantToolCall): ToolRun {
    // A call is projected twice — from its assistant message and from
    // tool_execution_start — and `begin` is idempotent for exactly that reason.
    // The purpose registry stays keyed by the provider's own id.
    const id = active.toolRunIds.begin(call.id);
    const existing = active.tools.get(id);
    const tool: ToolRun = {
      id,
      order: existing?.order ?? active.nextTimelineOrder++,
      name: call.name,
      label: this.toolLabel(call.name, call.args, call.id, undefined, active.session.sessionId),
      args: { ...call.args },
      output: existing?.status === "running" ? existing.output : "",
      status: "running",
      startedAt: existing?.startedAt ?? call.timestamp,
    };
    active.tools.set(tool.id, tool);
    if (call.name === "subagent" && (!stringValue(call.args.action) || call.args.action === "run" || call.args.action === "resume")) {
      const placeholderId = `${tool.id}:0`;
      if (!active.subagents.has(placeholderId)) {
        const task = stringValue(call.args.task);
        const agent = stringValue(call.args.agent) || "子 Agent";
        active.subagents.set(placeholderId, {
          id: placeholderId,
          runId: tool.id,
          parentToolId: tool.id,
          index: 0,
          agent,
          task: task || undefined,
          model: stringValue(call.args.model) || undefined,
          status: "running",
          background: call.args.background === true,
          controlReady: false,
          toolCount: 0,
          tokens: 0,
          durationMs: 0,
          updatedAt: tool.startedAt,
        });
        this.publishSubagents();
      }
    }
    if (isShellToolName(call.name) || (call.name === "terminal" && call.args.action === "start")) {
      const terminal = active.terminals.get(tool.id);
      active.terminals.set(tool.id, {
        id: tool.id,
        command: stringValue(call.args.command) || this.toolLabel(call.name, call.args),
        cwd: stringValue(call.args.cwd) || active.cwd,
        output: terminal?.status === "running" ? terminal.output : "",
        status: "running",
        startedAt: terminal?.startedAt ?? tool.startedAt,
      });
    }
    this.emitEvent({ type: "tool_started", tool: { ...tool } });
    this.publishProjectFromMemory();
    return tool;
  }

  /**
   * Close tool cards for calls that were announced but never executed.
   *
   * A response that ends `stopReason: "error"` or `"aborted"` still streams the
   * tool calls it had produced — a dropped stream leaves them with truncated
   * arguments — and Pi's loop returns without running any of them, so no
   * `tool_execution_end` ever arrives. Reopening the session already reports
   * such a call as failed; the live projection has to say the same, or the card
   * keeps spinning under a conversation that has visibly finished.
   */
  protected failAbandonedToolRuns(active: ActiveSession, runIds: Iterable<string>): void {
    let touchedSubagent = false;
    let touchedProject = false;
    for (const runId of runIds) {
      const tool = active.tools.get(runId);
      if (!tool || tool.status !== "running") continue;
      tool.status = "failed";
      // Keep whatever partial output streamed in; it explains more than the notice.
      tool.output = tool.output || ABANDONED_TOOL_OUTPUT;
      tool.endedAt = Date.now();
      active.tools.set(tool.id, tool);
      const terminal = active.terminals.get(tool.id);
      if (terminal && terminal.status === "running") {
        terminal.output = terminal.output || ABANDONED_TOOL_OUTPUT;
        terminal.status = "failed";
        terminal.endedAt = tool.endedAt;
        active.terminals.set(terminal.id, terminal);
        touchedProject = true;
      }
      const placeholder = active.subagents.get(`${tool.id}:0`);
      if (placeholder && placeholder.status === "running") {
        active.subagents.set(placeholder.id, {
          ...placeholder,
          status: "failed",
          controlReady: false,
          error: placeholder.error ?? ABANDONED_TOOL_OUTPUT,
          durationMs: tool.endedAt - placeholder.updatedAt,
          updatedAt: tool.endedAt,
        });
        touchedSubagent = true;
      }
      this.emitEvent({ type: "tool_finished", tool: { ...tool } });
    }
    if (touchedSubagent) this.publishSubagents();
    if (touchedProject) this.publishProjectFromMemory();
  }

  protected messageId(message: unknown, prefix: string): string {
    const active = this.active;
    if (!active || !isRecord(message)) return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = active.messageIds.get(message);
    if (existing) return existing;
    const id = `${prefix}-${messageTimestamp(message)}-${Math.random().toString(36).slice(2, 8)}`;
    active.messageIds.set(message, id);
    return id;
  }

  /**
   * Remember that `text` was sent on this client message's behalf.
   *
   * The text is what correlates Pi's echoed user message back to this id; see
   * {@link matchPendingUserPrompt}.
   */
  protected queueClientMessage(active: ActiveSession, clientMessageId: string | undefined, text: string, promptDocument?: PromptDocument): void {
    if (!clientMessageId || active.pendingUserPrompts.some((prompt) => prompt.id === clientMessageId)) return;
    active.pendingUserPrompts.push({
      id: clientMessageId,
      text,
      ...(promptDocument ? { promptDocument: structuredClone(promptDocument) } : {}),
    });
    if (promptDocument) active.pendingPromptDocuments?.set(clientMessageId, structuredClone(promptDocument));
  }

  protected persistPromptDocument(active: ActiveSession, messageEntryId: string, clientMessageId: string): boolean {
    const document = active.pendingPromptDocuments?.get(clientMessageId) ?? active.promptDocumentsByMessageId?.get(clientMessageId);
    if (!document) return false;
    active.promptDocumentsByEntryId?.set(messageEntryId, structuredClone(document));
    active.pendingPromptDocuments?.delete(clientMessageId);
    active.promptDocumentsByMessageId?.delete(clientMessageId);
    active.session.sessionManager.appendCustomEntry(PROMPT_DOCUMENT_ENTRY_TYPE, { messageEntryId, document });
    return true;
  }

  /**
   * Pi notifies subscribers of `message_end` before it writes the user message.
   * Wait one microtask, then append our display metadata as a child of that
   * real message entry so a later session switch can reconstruct the node.
   */
  protected schedulePromptDocumentPersistence(active: ActiveSession, clientMessageId: string, rawMessage: unknown): void {
    queueMicrotask(() => {
      if (this.active !== active) return;
      const manager = active.session.sessionManager;
      if (!manager) return;
      const entry = [...manager.getBranch()].reverse().find((candidate) =>
        candidate.type === "message" && candidate.message === rawMessage && candidate.message.role === "user");
      if (!entry || entry.type !== "message") return;
      if (!active.pendingPromptDocuments?.has(clientMessageId) && !active.promptDocumentsByMessageId?.has(clientMessageId)) return;
      if (active.promptDocumentsByEntryId?.has(entry.id)) return;
      if (!this.persistPromptDocument(active, entry.id, clientMessageId)) return;
    });
  }

  protected publishPromptQueue(active: ActiveSession): void {
    this.emitEvent({
      type: "prompt_queue_updated",
      queue: active.promptQueue.map((item) => ({
        ...item,
        promptDocument: item.promptDocument ? structuredClone(item.promptDocument) : undefined,
        images: item.images?.map((image) => ({ ...image })),
      })),
      revision: ++active.messageRevision,
    });
  }

  protected enqueuePrompt(
    active: ActiveSession,
    text: string,
    images: PromptImage[] | undefined,
    clientMessageId?: string,
    promptDocument?: PromptDocument,
  ): void {
    const id = clientMessageId || `queued-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (active.promptQueue.some((item) => item.id === id) || active.pendingUserPrompts.some((prompt) => prompt.id === id)) return;
    active.promptQueue.push({
      id,
      text,
      promptDocument: promptDocument ? structuredClone(promptDocument) : undefined,
      images: images?.map((image) => ({ ...image })),
      queuedAt: Date.now(),
    });
    this.log.info("prompt-queue", "enqueued", { id, queued: active.promptQueue.length });
    this.publishPromptQueue(active);
    // Protect this session runtime from idle retirement during the small gap
    // between one Pi run settling and the next queued prompt starting.
    this.publishRunning(true, "prompt_enqueued", { id });
  }

  protected removeQueuedPrompt(active: ActiveSession, id: string): boolean {
    const index = active.promptQueue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    active.promptQueue.splice(index, 1);
    this.log.info("prompt-queue", "removed", { id, queued: active.promptQueue.length });
    this.publishPromptQueue(active);
    return true;
  }

  /**
   * Drop the messages Pi has already taken for the turn that is being stopped.
   *
   * A steered message waits inside Pi's own queue until the agent loop pulls it
   * in, and `AgentSession.abort()` leaves it there — so a stop pressed just
   * after a steer still delivered that message on the next turn, which reads as
   * the stop having been ignored. Clearing the queue hands the text back, and
   * every message a composer is still waiting on is returned to it.
   */
  protected clearSteeredQueue(active: ActiveSession): number {
    const cleared = active.session.clearQueue();
    const texts = [...cleared.steering, ...cleared.followUp];
    for (const text of texts) {
      const pending = active.pendingUserPrompts.find((prompt) => prompt.text === text);
      if (pending) this.rejectClientMessage(active, pending.id, text);
    }
    if (texts.length > 0) this.log.info("prompt-queue", "steered_cleared", { cleared: texts.length });
    return texts.length;
  }

  protected rejectClientMessage(active: ActiveSession, clientMessageId?: string, text?: string): void {
    if (!clientMessageId) return;
    const promptDocument = active.pendingPromptDocuments?.get(clientMessageId);
    const index = active.pendingUserPrompts.findIndex((prompt) => prompt.id === clientMessageId);
    if (index >= 0) active.pendingUserPrompts.splice(index, 1);
    active.pendingPromptDocuments?.delete(clientMessageId);
    // 被拒掉的介入不会再落进对话，快照里那份投影也要一起收掉。
    const steeringIndex = active.steeringMessages.findIndex((item) => item.id === clientMessageId);
    if (steeringIndex >= 0) active.steeringMessages.splice(steeringIndex, 1);
    this.emitEvent({ type: "message_rejected", id: clientMessageId, revision: ++active.messageRevision, text, promptDocument });
  }

  protected publishSubagents(): void {
    const active = this.active;
    if (!active) return;
    this.emitEvent({
      type: "subagents_updated",
      subagents: [...active.subagents.values()].sort((left, right) => left.updatedAt - right.updatedAt || left.index - right.index),
    });
  }

  protected mergeSubagentActivities(activities: SubagentActivity[]): void {
    const active = this.active;
    if (!active || activities.length === 0) return;
    for (const activity of activities) {
      const existing = active.subagents.get(activity.id);
      active.subagents.set(activity.id, existing ? {
        ...existing,
        ...activity,
        task: activity.task ?? existing.task,
        currentTool: activity.currentTool,
        currentPath: activity.currentPath,
        model: activity.model ?? existing.model,
        modelInherited: activity.modelInherited ?? existing.modelInherited,
        recentTools: activity.recentTools ?? existing.recentTools,
        recentOutput: activity.recentOutput ?? existing.recentOutput,
        messages: activity.messages ?? existing.messages,
        toolCalls: activity.toolCalls ?? existing.toolCalls,
        timeline: activity.timeline ?? existing.timeline,
        finalOutput: activity.finalOutput ?? existing.finalOutput,
        transcriptPath: activity.transcriptPath ?? existing.transcriptPath,
        sessionFile: activity.sessionFile ?? existing.sessionFile,
        parentToolId: activity.parentToolId ?? existing.parentToolId,
        turnCount: activity.turnCount ?? existing.turnCount,
        error: activity.error ?? existing.error,
      } : activity);
    }
    this.publishSubagents();
  }

  protected subagentRpc(method: "stop" | "status" | "resume", id: string): Promise<unknown> {
    const active = this.requireActive();
    const requestId = `coilcoil-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `coilcoil:subagents:rpc:v1:reply:${requestId}`;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        callback();
      };
      const unsubscribe = active.eventBus.on(replyChannel, (raw) => {
        if (!isRecord(raw)) return;
        if (raw.success === true) {
          finish(() => resolvePromise(raw.data));
          return;
        }
        const rpcError = isRecord(raw.error) ? stringValue(raw.error.message) : "子 Agent 控制请求失败。";
        finish(() => rejectPromise(new Error(rpcError || "子 Agent 控制请求失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("子 Agent 控制请求超时。"))), 8_000);
      active.eventBus.emit(SUBAGENT_RPC_REQUEST_CHANNEL, {
        version: 1,
        requestId,
        method,
        params: { id },
        source: { client: "coilcoil-desktop" },
      });
    });
  }

  protected planRpc(method: "approve" | "reject", params: { planId: string; target?: PlanExecutionTarget; agent?: string; }): Promise<unknown> {
    const active = this.requireActive();
    const requestId = `coilcoil-plan-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `coilcoil:plan:rpc:v1:reply:${requestId}`;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        callback();
      };
      const unsubscribe = active.eventBus.on(replyChannel, (raw) => {
        if (!isRecord(raw)) return;
        if (raw.success === true) {
          finish(() => resolvePromise(raw.data));
          return;
        }
        const rpcError = isRecord(raw.error) ? stringValue(raw.error.message) : "计划操作失败。";
        finish(() => rejectPromise(new Error(rpcError || "计划操作失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("计划操作请求超时。"))), 20_000);
      active.eventBus.emit(PLAN_RPC_REQUEST_CHANNEL, {
        version: 1,
        requestId,
        method,
        params,
        source: { client: "coilcoil-desktop" },
      });
    });
  }

  async approvePlan(planId: string, target: PlanExecutionTarget, agent?: string): Promise<PlanApprovalState> {
    const normalized = planId.trim();
    if (!normalized) throw new Error("缺少计划标识。");
    const reply = await this.planRpc("approve", { planId: normalized, target, agent });
    const plan = isRecord(reply) && isRecord(reply.plan) ? planApprovalState(reply.plan) : undefined;
    if (!plan) throw new Error("计划审批响应缺少有效状态。");
    const active = this.requireActive();
    if (active.planApproval?.id !== plan.id || active.planApproval.revision !== plan.revision) {
      active.planApproval = plan;
      active.project = { ...active.project, planApproval: plan, refreshedAt: Date.now() };
      this.emitEvent({ type: "plan_approval_updated", plan });
      this.emitEvent({ type: "project_updated", project: active.project });
    }
    return plan;
  }

  async rejectPlan(planId: string): Promise<PlanApprovalState> {
    const normalized = planId.trim();
    if (!normalized) throw new Error("缺少计划标识。");
    const reply = await this.planRpc("reject", { planId: normalized });
    const plan = isRecord(reply) && isRecord(reply.plan) ? planApprovalState(reply.plan) : undefined;
    if (!plan) throw new Error("计划拒绝响应缺少有效状态。");
    const active = this.requireActive();
    if (active.planApproval?.id !== plan.id || active.planApproval.revision !== plan.revision) {
      active.planApproval = plan;
      active.project = { ...active.project, planApproval: plan, refreshedAt: Date.now() };
      this.emitEvent({ type: "plan_approval_updated", plan });
      this.emitEvent({ type: "project_updated", project: active.project });
    }
    return plan;
  }

  async stopSubagent(id: string, _background: boolean): Promise<{ stopped: true; }> {
    if (!id.trim()) throw new Error("缺少子 Agent 标识。");
    const reply = await this.subagentRpc("stop", id.trim());
    const activity = isRecord(reply) && isRecord(reply.activity) ? subagentActivitiesFromPayload({ activities: [reply.activity] })[0] : undefined;
    if (!activity) throw new Error("子 Agent 停止响应缺少运行状态。");
    this.mergeSubagentActivities([activity]);
    return { stopped: true };
  }

  async resumeSubagent(id: string): Promise<{ resumed: true; }> {
    if (!id.trim()) throw new Error("缺少子 Agent 标识。");
    const reply = await this.subagentRpc("resume", id.trim());
    const activity = isRecord(reply) && isRecord(reply.activity) ? subagentActivitiesFromPayload({ activities: [reply.activity] })[0] : undefined;
    if (activity) this.mergeSubagentActivities([activity]);
    return { resumed: true };
  }
}
