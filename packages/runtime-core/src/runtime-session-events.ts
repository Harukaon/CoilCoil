import {
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  type PromptImage,
  type SubagentActivity,
} from "@coilcoil/runtime-protocol";
import {
  assistantToolCalls,
  contentParts,
  extractExitCode,
  mapMessage,
  matchPendingUserPrompt,
  planFromResult,
  preparePromptImages,
  subagentActivityFromDetails,
  titleFromText,
  toolResultText,
} from "./message-helpers.js";
import { agentRetryRuntimeEvent } from "./runtime-agent-retry.js";
import { beginStreamingToolRun } from "./streaming-tool-call.js";
import {
  isShellToolName,
  MAX_TERMINAL_OUTPUT,
  RESPONSE_METRICS_ENTRY_TYPE,
} from "./runtime-constants.js";
import {
  summaryEventFromEntry,
} from "./runtime-inspection.js";
import {
  ActiveSession,
  planApprovalState,
} from "./runtime-state.js";
import { RuntimeToolState } from "./runtime-tool-state.js";
import {
  clampText,
  errorDetail,
  errorMessage,
  isRecord,
  stringValue,
} from "./runtime-utils.js";
import {
  responseMetricsFromData,
  sessionUsage,
  usageIncludingPendingResponse,
} from "./session-values.js";
import {
  TERMINAL_RUN_ENTRY_TYPE,
  terminalIdFromResult,
  terminalOwnerToolIdFromData,
  terminalOutputFromResult,
  terminalRunFromData,
  terminalStatusFromResult,
} from "./terminal-values.js";

/** How soon to re-check a queue that only Pi's streaming flag is holding. */
const DRAIN_RETRY_MS = 200;

export abstract class RuntimeSessionEvents extends RuntimeToolState {
  protected handleSessionEvent(event: AgentSessionEvent): void {
    const active = this.active;
    if (!active) return;
    try {
      switch (event.type) {
        case "agent_start":
          this.publishRunning(true, "agent_start");
          this.applyPendingAbort(active);
          break;
        case "agent_settled":
          // Nothing is in flight once the agent has settled, so any card still
          // marked running belongs to a call that was announced and never
          // executed. Sweep before the run_state below, so the UI never paints
          // a frame where the composer is free but a tool still spins.
          // `endAll` releases the raw provider ids so a repeated `call_0` opens a
          // fresh card later; the sweep itself covers every running card, including
          // any that no longer has an in-flight id.
          active.toolRunIds.endAll();
          // The run this stop was aimed at is over, whatever the abort promise
          // is still waiting on.
          active.aborting = false;
          this.failAbandonedToolRuns(active, [...active.tools.keys()]);
          active.activeAssistantId = undefined;
          active.activeAssistantOrder = undefined;
          active.activeAssistantMessage = undefined;
          // Keep the runtime visibly busy while accepted FIFO work remains.
          // The promise that owns the completed Pi run starts the next item only
          // after AgentSession.prompt() has fully resolved.
          this.log.info("run-state", "agent_settled", { queued: active.promptQueue.length });
          if (active.promptQueue.length === 0) this.publishRunning(false, "agent_settled");
          // Settling is the second, independent chance to start queued work.
          // Relying only on the owning run's `finally` deadlocks a prompt that
          // was accepted after that callback had already been and gone, which
          // happens because `isStreaming` can still read true at that point.
          // The drain is guarded, so an early attempt is simply a no-op.
          else queueMicrotask(() => { void this.drainPromptQueue(active); });
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          this.scheduleProjectRefresh();
          void this.listSessions(active.cwd);
          break;
        case "compaction_start":
          this.log.info("compaction", "compaction_start", { reason: event.reason });
          active.summaryActivity = {
            id: `compaction-${active.sessionRevision}-${Date.now()}`,
            kind: "compaction",
            status: "running",
            timestamp: Date.now(),
            active: true,
            reason: event.reason,
          };
          // A stop already in flight owns this turn, and the summary Pi has just
          // announced belongs to it: cancel it instead of waiting it out.
          if (active.aborting) this.cancelSummarizationForStop(active);
          this.publishRuntimeInspection(active);
          break;
        case "compaction_end": {
          const leaf = active.session.sessionManager.getLeafEntry();
          const activeIds = new Set(active.session.sessionManager.getBranch().map((entry) => entry.id));
          const persisted = leaf ? summaryEventFromEntry(leaf, activeIds) : undefined;
          if (event.result) {
            active.summaryActivity = {
              ...(persisted ?? active.summaryActivity ?? {
                id: `compaction-${active.sessionRevision}-${Date.now()}`,
                kind: "compaction" as const,
                timestamp: Date.now(),
                active: true,
              }),
              status: "succeeded",
              reason: event.reason,
              summary: event.result.summary,
              tokensBefore: event.result.tokensBefore,
              estimatedTokensAfter: event.result.estimatedTokensAfter,
              firstKeptEntryId: event.result.firstKeptEntryId,
              willRetry: event.willRetry,
            };
          } else {
            active.summaryActivity = {
              ...(active.summaryActivity ?? {
                id: `compaction-${active.sessionRevision}-${Date.now()}`,
                kind: "compaction" as const,
                timestamp: Date.now(),
                active: true,
              }),
              status: event.aborted ? "aborted" : "failed",
              reason: event.reason,
              error: event.errorMessage,
              willRetry: event.willRetry,
            };
          }
          this.log.info("compaction", "compaction_end", {
            reason: event.reason,
            succeeded: Boolean(event.result),
            aborted: event.aborted,
            willRetry: event.willRetry,
            tokensBefore: event.result?.tokensBefore,
            estimatedTokensAfter: event.result?.estimatedTokensAfter,
            error: event.errorMessage,
          });
          this.publishRuntimeInspection(active);
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          break;
        }
        case "auto_retry_start":
        case "auto_retry_end":
          this.emitEvent(agentRetryRuntimeEvent(event, this.log));
          break;
        case "summarization_retry_scheduled":
          active.summaryActivity = {
            ...(active.summaryActivity ?? {
              id: `summary-retry-${active.sessionRevision}-${Date.now()}`,
              kind: "compaction" as const,
              status: "running" as const,
              timestamp: Date.now(),
              active: true,
            }),
            status: "running",
            retryAttempt: event.attempt,
            retryMaxAttempts: event.maxAttempts,
            error: event.errorMessage,
          };
          this.publishRuntimeInspection(active);
          break;
        case "summarization_retry_attempt_start":
          active.summaryActivity = {
            ...(active.summaryActivity ?? {
              id: `summary-retry-${active.sessionRevision}-${Date.now()}`,
              kind: event.source === "branchSummary" ? "branch_summary" as const : "compaction" as const,
              timestamp: Date.now(),
              active: true,
            }),
            status: "running",
            ...(event.source === "compaction" ? { reason: event.reason } : {}),
          };
          this.publishRuntimeInspection(active);
          break;
        case "entry_appended":
          if (event.entry.type === "message" && isRecord(event.entry.message) && event.entry.message.role === "user") {
            const correlatedId = active.activeUserId ?? active.lastUserId;
            if (correlatedId) active.messageIds.set(event.entry.message, correlatedId);
            active.lastUserId = undefined;
          }
          if (event.entry.type === "custom" && event.entry.customType === RESPONSE_METRICS_ENTRY_TYPE) {
            const metrics = responseMetricsFromData(event.entry.data);
            if (metrics) {
              active.responseMetrics = metrics;
              active.responseMetricsHistory = [...active.responseMetricsHistory, metrics].slice(-60);
            }
            const usage = sessionUsage(active.session);
            // Pi emits this custom entry from message_end immediately before it
            // persists the assistant message. Include that just-finished response
            // so the UI is live without double-counting later session snapshots.
            const tokenUsage = metrics
              ? usageIncludingPendingResponse(usage.tokenUsage, metrics)
              : usage.tokenUsage;
            this.emitEvent({
              type: "metrics_updated",
              responseMetrics: active.responseMetrics,
              responseMetricsHistory: active.responseMetricsHistory,
              contextUsage: usage.contextUsage,
              tokenUsage,
            });
            this.publishRuntimeInspection(active);
          }
          if (event.entry.type === "custom" && event.entry.customType === TERMINAL_RUN_ENTRY_TYPE) {
            const terminal = terminalRunFromData(event.entry.data);
            if (terminal) {
              const ownerToolCallId = terminalOwnerToolIdFromData(event.entry.data);
              if (ownerToolCallId && ownerToolCallId !== terminal.id) active.terminals.delete(ownerToolCallId);
              active.terminals.set(terminal.id, terminal);
              this.publishProjectFromMemory();
            }
          }
          if (event.entry.type === "compaction" || event.entry.type === "branch_summary") {
            active.sessionRevision += 1;
            const activeIds = new Set(active.session.sessionManager.getBranch().map((entry) => entry.id));
            active.summaryActivity = summaryEventFromEntry(event.entry, activeIds);
            this.publishRuntimeInspection(active);
          }
          break;
        case "session_info_changed":
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          void this.listSessions(active.cwd);
          break;
        case "message_start": {
          const raw = event.message as unknown;
          const role = isRecord(raw) ? stringValue(raw.role) : "message";
          // Not every user message came from a client. A running `/goal` loop
          // sends itself one each round, and claiming a pending id for it stole
          // the identity of a message the user was still waiting to send.
          const pendingIndex = role === "user"
            ? matchPendingUserPrompt(active.pendingUserPrompts, contentParts(isRecord(raw) ? raw.content : undefined).text)
            : -1;
          const clientMessageId = pendingIndex >= 0
            ? active.pendingUserPrompts.splice(pendingIndex, 1)[0]!.id
            : undefined;
          if (role === "user" && pendingIndex < 0 && active.pendingUserPrompts.length > 0) {
            // Expected for a `/goal` round, which nobody is waiting on. Anywhere
            // else it means a prompt's bubble is about to lose its identity.
            this.log.warn("message-correlation", "user_message_claimed_nothing", {
              pending: active.pendingUserPrompts.map((prompt) => prompt.id),
              textPreview: contentParts(isRecord(raw) ? raw.content : undefined).text.slice(0, 120),
            });
          }
          const id = clientMessageId || this.messageId(raw, role || "message");
          if (clientMessageId && isRecord(raw)) active.messageIds.set(raw, clientMessageId);
          const order = active.nextTimelineOrder++;
          if (role === "user") {
            active.activeUserId = id;
            active.activeUserOrder = order;
          } else if (role === "assistant") {
            active.activeAssistantId = id;
            active.activeAssistantOrder = order;
          }
          const mapped = mapMessage(raw, id, order);
          if (mapped && mapped.role !== "tool") {
            this.emitEvent({ type: "message_started", message: mapped, revision: ++active.messageRevision });
          }
          // Confirm the user bubble before removing its queued projection, so
          // the renderer never observes a frame where the message disappears.
          if (role === "user" && clientMessageId) this.removeQueuedPrompt(active, clientMessageId);
          if (mapped && mapped.role === "assistant") {
            active.activeAssistantMessage = { ...mapped, status: "running" };
          }
          if (role === "user") void this.listSessions(active.cwd);
          break;
        }
        case "message_update": {
          const update = event.assistantMessageEvent;
          const id = active.activeAssistantId ?? this.messageId(event.message as unknown, "assistant");
          active.activeAssistantId = id;
          const mapped = mapMessage(event.message as unknown, id, active.activeAssistantOrder ?? active.nextTimelineOrder);
          if (mapped && mapped.role === "assistant") {
            active.activeAssistantMessage = { ...mapped, status: "running" };
          }
          if (update.type === "text_delta") {
            this.emitEvent({ type: "message_delta", id, field: "text", delta: update.delta, revision: ++active.messageRevision });
          } else if (update.type === "thinking_delta") {
            this.emitEvent({ type: "message_delta", id, field: "thinking", delta: update.delta, revision: ++active.messageRevision });
          } else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
            // The card belongs on screen while the arguments stream, not after.
            const started = beginStreamingToolRun(active, update, (name, args, callId) =>
              this.toolLabel(name, args, callId, undefined, active.session.sessionId));
            if (started) this.emitEvent(started);
          }
          break;
        }
        case "message_end": {
          const raw = event.message as unknown;
          const role = isRecord(raw) ? stringValue(raw.role) : "message";
          const id = role === "user" && active.activeUserId
            ? active.activeUserId
            : role === "assistant" && active.activeAssistantId
              ? active.activeAssistantId
              : this.messageId(raw, role || "message");
          const order = role === "user" && active.activeUserOrder !== undefined
            ? active.activeUserOrder
            : role === "assistant" && active.activeAssistantOrder !== undefined
              ? active.activeAssistantOrder
              : active.nextTimelineOrder++;
          const mapped = mapMessage(raw, id, order);
          if (mapped && mapped.role !== "tool") {
            this.emitEvent({ type: "message_finished", message: mapped, revision: ++active.messageRevision });
          }
          if (role === "assistant") {
            // A response that ended in an error or an abort still carries the
            // tool calls it had streamed, and Pi returns without executing any
            // of them. Project them so the timeline shows what the model tried,
            // then close them in the same breath — leaving them open is what
            // used to spin a card forever under a finished conversation.
            const stopReason = isRecord(raw) ? stringValue(raw.stopReason) : "";
            const abandoned = stopReason === "error" || stopReason === "aborted";
            const runIds: string[] = [];
            for (const call of assistantToolCalls(raw)) {
              this.projectToolStart(active, call);
              if (abandoned) runIds.push(active.toolRunIds.end(call.id));
            }
            if (runIds.length) this.failAbandonedToolRuns(active, runIds);
          }
          if (role === "user") {
            active.lastUserId = id;
            active.activeUserId = undefined;
            active.activeUserOrder = undefined;
          } else if (role === "assistant") {
            active.activeAssistantMessage = undefined;
          }
          break;
        }
        case "tool_execution_start": {
          const args = isRecord(event.args) ? { ...event.args } : {};
          this.projectToolStart(active, {
            id: event.toolCallId,
            name: event.toolName,
            args,
            timestamp: Date.now(),
          });
          break;
        }
        case "tool_execution_update": {
          const tool = active.tools.get(active.toolRunIds.current(event.toolCallId));
          if (!tool) break;
          if (isRecord(event.args)) tool.args = { ...event.args };
          const output = toolResultText(event.partialResult);
          if (output) tool.output = clampText(output, MAX_TERMINAL_OUTPUT);
          const terminal = active.terminals.get(tool.id);
          if (terminal && output) terminal.output = clampText(output, MAX_TERMINAL_OUTPUT);
          if (tool.name === "subagent") {
            const details = isRecord(event.partialResult) ? event.partialResult.details : undefined;
            const activity = subagentActivityFromDetails(details, tool.id);
            if (activity) {
              active.subagents.delete(`${tool.id}:0`);
              this.mergeSubagentActivities([activity]);
            }
          }
          this.emitEvent({ type: "tool_updated", tool: { ...tool } });
          this.publishProjectFromMemory();
          break;
        }
        case "tool_execution_end": {
          // Closing the run here is what lets a provider that restarts its tool
          // call ids every turn (`call_0`, `call_1`, … on OpenAI-compatible chat
          // completions) start a fresh card instead of overwriting this one.
          const runId = active.toolRunIds.end(event.toolCallId);
          const tool = active.tools.get(runId) ?? {
            id: runId,
            order: active.nextTimelineOrder++,
            name: event.toolName,
            label: this.toolLabel(event.toolName, {}, event.toolCallId, undefined, active.session.sessionId),
            args: {},
            output: "",
            status: "running" as const,
            startedAt: Date.now(),
          };
          tool.output = clampText(toolResultText(event.result), MAX_TERMINAL_OUTPUT);
          tool.status = event.isError ? "failed" : "succeeded";
          tool.endedAt = Date.now();
          active.tools.set(tool.id, tool);
          const terminal = active.terminals.get(tool.id);
          if (terminal) {
            const terminalId = terminalIdFromResult(event.result) ?? tool.id;
            const status = terminalStatusFromResult(event.result, event.isError);
            if (terminalId !== tool.id) active.terminals.delete(tool.id);
            terminal.id = terminalId;
            terminal.output = clampText(terminalOutputFromResult(event.result) ?? tool.output, MAX_TERMINAL_OUTPUT);
            terminal.status = status;
            terminal.endedAt = status === "running" ? undefined : tool.endedAt;
            terminal.exitCode = extractExitCode(event.result);
            active.terminals.set(terminalId, terminal);
          }
          if (event.toolName === "todo") {
            const plan = planFromResult(event.result);
            if (plan) {
              active.plan = plan;
              this.emitEvent({ type: "plan_updated", plan: [...plan] });
            }
          }
          if (event.toolName === "plan") {
            const details = isRecord(event.result) ? event.result.details : undefined;
            const approval = planApprovalState(isRecord(details) ? details.plan ?? details : undefined);
            if (approval) {
              active.planApproval = approval;
              active.project = { ...active.project, planApproval: approval, refreshedAt: Date.now() };
              this.emitEvent({ type: "plan_approval_updated", plan: approval });
            }
          }
          if (event.toolName === "subagent") {
            const details = isRecord(event.result) ? event.result.details : undefined;
            const activity = subagentActivityFromDetails(details, tool.id);
            if (activity) {
              active.subagents.delete(`${tool.id}:0`);
              this.mergeSubagentActivities([activity]);
            } else {
              const placeholder = active.subagents.get(`${tool.id}:0`);
              if (placeholder) {
                const updated = {
                  ...placeholder,
                  status: event.isError ? "failed" : placeholder.background ? "running" : "completed",
                  controlReady: false,
                  error: event.isError ? tool.output : placeholder.error,
                  durationMs: Date.now() - placeholder.updatedAt,
                  updatedAt: Date.now(),
                } satisfies SubagentActivity;
                active.subagents.set(placeholder.id, updated);
                this.publishSubagents();
              }
            }
          }
          this.emitEvent({ type: "tool_finished", tool: { ...tool } });
          this.publishProjectFromMemory();
          if (["write", "edit", "terminal"].includes(event.toolName) || isShellToolName(event.toolName)) this.scheduleProjectRefresh();
          break;
        }
        case "bash_execution_update": {
          const id = event.id ?? "session-bash";
          const current = active.terminals.get(id) ?? {
            id,
            command: "Shell 命令",
            cwd: active.cwd,
            output: "",
            status: "running" as const,
            startedAt: Date.now(),
          };
          current.output = clampText(`${current.output}${event.delta}`, MAX_TERMINAL_OUTPUT);
          active.terminals.set(id, current);
          this.publishProjectFromMemory();
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.log.error("session-event", "handler_failed", error, { eventType: event.type });
      this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
    }
  }

  /**
   * Deliver a stop that was pressed before this run existed.
   *
   * The window Pi spends preparing a prompt has no run to abort: summarization
   * owns it, `isStreaming` still reads false, and the prompt is sent the moment
   * the summary ends. A stop taken there is remembered instead of dropped, and
   * lands here on `agent_start`, which Pi awaits before it sends anything to
   * the model — so the turn the user stopped never reaches the provider.
   */
  private applyPendingAbort(active: ActiveSession): void {
    if (!active.abortOnStart) return;
    active.abortOnStart = false;
    active.aborting = true;
    this.publishRunning(true, "abort_applied_at_start", { aborting: true });
    void active.session.abort().catch((error) => {
      this.log.error("abort", "abort_at_start_failed", error);
    });
  }

  protected async startPrompt(
    active: ActiveSession,
    prompt: string,
    images: PromptImage[] | undefined,
    clientMessageId: string | undefined,
    queued: boolean,
  ): Promise<void> {
    // A stop belongs to the prompt it was pressed against, never to this one.
    active.abortOnStart = false;
    active.aborting = false;
    this.promptStarting = true;
    this.publishRunning(true, "prompt_starting", { queued });
    try {
      // A model selected while the previous turn was running is committed at
      // this prompt boundary, never in the middle of the previous turn.
      await this.applyPendingSessionModel(active);
      const prepared = await preparePromptImages(images);
      const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
      const hasUserMessage = active.session.messages.some((message) => isRecord(message) && message.role === "user");
      if (!hasUserMessage) active.session.setSessionName(titleFromText(prompt));

      this.queueClientMessage(active, clientMessageId, expandedPrompt);
      const run = active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        preflightResult: () => { this.promptStarting = false; },
      });
      void run.then(() => {
        // Extension commands may complete without producing a Pi user message.
        // Such an item must still leave the queue instead of blocking all later
        // prompts, and its optimistic chat bubble must be withdrawn.
        if (clientMessageId && active.pendingUserPrompts.some((prompt) => prompt.id === clientMessageId)) {
          if (queued) this.removeQueuedPrompt(active, clientMessageId);
          this.rejectClientMessage(active, clientMessageId);
        }
      }).catch((error) => {
        this.log.error("prompt", "prompt_failed", error, { clientMessageId, queued });
        if (clientMessageId && queued) this.removeQueuedPrompt(active, clientMessageId);
        this.rejectClientMessage(active, clientMessageId);
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      }).finally(() => {
        this.promptStarting = false;
        if (queued) active.promptDrainInProgress = false;
        if (this.active !== active) return;
        if (active.promptQueue.length > 0) void this.drainPromptQueue(active);
        // The turn is over as far as this prompt is concerned. Whether the
        // spinner clears here is exactly the question "回复结束了输入框还在转"
        // asks, so record what this saw even when it decides to leave it on.
        else if (!active.session.isStreaming) this.publishRunning(false, "prompt_finished", { clientMessageId });
        else this.log.info("run-state", "run_state_held", { reason: "prompt_finished", streaming: true });
      });
    } catch (error) {
      this.promptStarting = false;
      throw error;
    }
  }

  /**
   * Re-check a queue that only Pi's streaming flag is holding back.
   *
   * `agent_settled` normally wakes the drain, but a prompt accepted in the
   * window after a run resolved while `isStreaming` still reads true has
   * already missed both that event and the run's own `finally`. Without a
   * re-check such a prompt waits forever — the queue-stuck bug. The timer only
   * exists while a queue is genuinely unowned, and is unref'd so it can never
   * hold the process open.
   */
  private scheduleDrainRetry(active: ActiveSession): void {
    if (active.drainRetryTimer) return;
    const timer = setTimeout(() => {
      active.drainRetryTimer = undefined;
      void this.drainPromptQueue(active);
    }, DRAIN_RETRY_MS);
    timer.unref?.();
    active.drainRetryTimer = timer;
  }

  protected async drainPromptQueue(active: ActiveSession): Promise<void> {
    if (this.active !== active || active.promptQueue.length === 0) return;
    // Something already owns starting the next item; a second start would
    // duplicate it.
    if (active.promptDrainInProgress || this.promptStarting) return;
    if (active.session.isStreaming) {
      this.scheduleDrainRetry(active);
      return;
    }
    const next = active.promptQueue[0]!;
    // A promoted entry is mid-steer and still sitting in the queue so the UI can
    // show it leaving; starting it here would send the same message twice.
    if (next.promoting) return;
    this.log.info("prompt-queue", "drain_start", { id: next.id, queued: active.promptQueue.length });
    active.promptDrainInProgress = true;
    try {
      if (this.modelTransition) await this.modelTransition;
      if (this.active !== active) return;
      await this.startPrompt(active, next.text, next.images, next.id, true);
    } catch (error) {
      active.promptDrainInProgress = false;
      this.log.error("prompt-queue", "drain_failed", error, { id: next.id });
      this.removeQueuedPrompt(active, next.id);
      this.rejectClientMessage(active, next.id);
      this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      if (active.promptQueue.length > 0) queueMicrotask(() => { void this.drainPromptQueue(active); });
      else this.publishRunning(false, "drain_failed");
    }
  }
}
