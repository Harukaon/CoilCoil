import {
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  type PromptImage,
  type PromptDocument,
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
import {
  buildSessionTitlePrompt,
  sanitizeSessionTitle,
  SESSION_TITLE_SYSTEM_PROMPT,
} from "./session-title.js";
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
          // 第一轮跑完了，去单独问一次模型要个标题。不 await：命名慢一点无所谓，
          // 不能让它挡住这一轮的收尾。
          if (active.titlePending) void this.nameSessionFromFirstTurn(active);
          if (active.promptQueue.length === 0) this.publishRunning(false, "agent_settled");
          // Settling is the second, independent chance to start queued work.
          // Relying only on the owning run's `finally` deadlocks a prompt that
          // was accepted after that callback had already been and gone, which
          // happens because `isStreaming` can still read true at that point.
          // The drain is guarded, so an early attempt is simply a no-op.
          else queueMicrotask(() => { void this.drainPromptQueue(active); });
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot })).catch(() => undefined);
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
          const branch = active.session.sessionManager.getBranch();
          const activeIds = new Set(branch.map((entry) => entry.id));
          const persisted = leaf ? summaryEventFromEntry(leaf, activeIds, branch) : undefined;
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
          // A threshold compaction that does not land is not a detail. It is the
          // one thing standing between a long session and a context past the
          // model's window, and it used to fail in silence: one session ran
          // twenty hours and reached 24% over the window with nothing said.
          const missed = event.reason === "threshold" && !event.result;
          this.log.log(missed ? "error" : "info", "compaction", "compaction_end", {
            reason: event.reason,
            succeeded: Boolean(event.result),
            aborted: event.aborted,
            willRetry: event.willRetry,
            tokensBefore: event.result?.tokensBefore,
            estimatedTokensAfter: event.result?.estimatedTokensAfter,
            error: event.errorMessage,
          });
          if (missed && !event.willRetry) {
            this.emitEvent({
              type: "runtime_notice",
              level: "error",
              message: event.aborted
                ? "上下文压缩被中断，这轮没压成。会话会继续变长，必要时手动 /compact。"
                : `上下文压缩失败，会话会继续变长：${event.errorMessage ?? "未知原因"}`,
            });
          }
          this.publishRuntimeInspection(active);
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot })).catch(() => undefined);
          break;
        }
        case "auto_retry_start":
        case "auto_retry_end":
          this.emitEvent(agentRetryRuntimeEvent(event, this.log));
          break;
        case "summarization_retry_scheduled":
          // 一次压缩会在里面自己重试八次，退避加起来能跑七八分钟。不记下来，外面
          // 看到的就只有「整理上下文」转了很久，分不清是在重试还是卡死了——用户
          // 问过一次「是不是挂了，重试几次了」，那时候只能拿耗时倒推。
          this.log.warn("compaction", "summarization_retry", {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            error: event.errorMessage,
          });
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
            if (correlatedId && this.persistPromptDocument(active, event.entry.id, correlatedId)) {
              void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot })).catch(() => undefined);
            }
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
            const entryBranch = active.session.sessionManager.getBranch();
            const activeIds = new Set(entryBranch.map((entry) => entry.id));
            active.summaryActivity = summaryEventFromEntry(event.entry, activeIds, entryBranch);
            this.publishRuntimeInspection(active);
          }
          break;
        case "session_info_changed":
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot })).catch(() => undefined);
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
          const pendingPrompt = pendingIndex >= 0 ? active.pendingUserPrompts[pendingIndex] : undefined;
          const clientMessageId = pendingPrompt?.id;
          if (pendingIndex >= 0) active.pendingUserPrompts.splice(pendingIndex, 1);
          if (role === "user" && pendingIndex < 0 && active.pendingUserPrompts.length > 0) {
            // Expected for a `/goal` round, which nobody is waiting on. Anywhere
            // else it means a prompt's bubble is about to lose its identity.
            this.log.warn("message-correlation", "user_message_claimed_nothing", {
              pending: active.pendingUserPrompts.map((prompt) => prompt.id),
              textPreview: contentParts(isRecord(raw) ? raw.content : undefined).text.slice(0, 120),
            });
          }
          const id = clientMessageId || this.messageId(raw, role || "message");
          const promptDocument = clientMessageId ? active.pendingPromptDocuments?.get(clientMessageId) ?? pendingPrompt?.promptDocument : undefined;
          if (promptDocument) active.promptDocumentsByMessageId?.set(id, promptDocument);
          if (clientMessageId && isRecord(raw)) active.messageIds.set(raw, clientMessageId);
          const order = active.nextTimelineOrder++;
          if (role === "user") {
            active.activeUserId = id;
            active.activeUserOrder = order;
          } else if (role === "assistant") {
            active.activeAssistantId = id;
            active.activeAssistantOrder = order;
          }
          const mapped = mapMessage(raw, id, order, undefined, promptDocument);
          if (mapped && mapped.role !== "tool") {
            this.emitEvent({ type: "message_started", message: mapped, revision: ++active.messageRevision });
          }
          // Confirm the user bubble before removing its queued projection, so
          // the renderer never observes a frame where the message disappears.
          if (role === "user" && clientMessageId) {
            this.removeQueuedPrompt(active, clientMessageId);
            // 这条介入已经落进对话了，快照里那份投影就该收掉，否则界面上会同时
            // 出现「等待介入」和它本身。
            const steeringIndex = active.steeringMessages.findIndex((item) => item.id === clientMessageId);
            if (steeringIndex >= 0) active.steeringMessages.splice(steeringIndex, 1);
          }
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
          const mapped = mapMessage(raw, id, order, undefined, active.promptDocumentsByMessageId?.get(id));
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
            active.activeUserOrder = undefined; if (active.promptDocumentsByMessageId?.has(id)) this.schedulePromptDocumentPersistence(active, id, raw);
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
  /**
   * 第一轮跑完后单独问一次模型：这段对话该叫什么。
   *
   * 标题原来就是第一句话截断，一屏侧栏全是「继续」「帮我看一下」，等于没有标题。
   * 这里发一次独立请求——不是主对话里的工具调用，所以不占记录、不会因为模型
   * 不配合而要重发，也不会把命名变成两个来回。
   *
   * 整个过程是尽力而为：拿不到、模型没配好、请求失败，都保留兜底的那个截断标题，
   * 绝不把错误抛给用户——命名失败不该影响这次对话。
   */
  private async nameSessionFromFirstTurn(active: ActiveSession): Promise<void> {
    // 只试一次。失败了也不留着标记，否则每一轮结束都会再试一遍。
    active.titlePending = false;
    try {
      const messages = active.session.messages;
      const firstUser = messages.find((message) => isRecord(message) && message.role === "user");
      if (!firstUser) return;
      const firstAssistant = messages.find((message) => isRecord(message) && message.role === "assistant");
      const userText = contentParts(isRecord(firstUser) ? firstUser.content : undefined).text;
      if (!userText.trim()) return;
      const assistantText = firstAssistant
        ? contentParts(isRecord(firstAssistant) ? firstAssistant.content : undefined).text
        : "";

      const modelRuntime = await this.ready();
      const configured = this.readSessionNamingConfiguration().model;
      const separator = configured.indexOf("/");
      const model = configured && separator > 0
        ? modelRuntime.getModel(configured.slice(0, separator), configured.slice(separator + 1))
        : active.session.model;
      if (!model) {
        this.log.warn("session-title", "model_unavailable", { configured });
        return;
      }

      // 命名不应该继承主会话的思考预算：Muse Spark 这类模型会把整段输出额度
      // 消耗在 thinking 里，最后不给可见标题。把 reasoning 关掉比传一个特定的
      // "off" 更可靠，因为有些模型的 thinkingLevelMap.off 是 null，provider
      // 无法通过普通的 off 映射关闭它。
      const titleModel = model.reasoning ? { ...model, reasoning: false } : model;
      // 不在这里覆盖 maxTokens。省略 options 让 ModelRuntime 使用模型/配置中已有的
      // 最大输出设置；命名只改变用途，不应该偷偷带一套专用的 token 上限。
      const reply = await modelRuntime.completeSimple(titleModel, {
        systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildSessionTitlePrompt(userText, assistantText), timestamp: Date.now() }],
      });
      const title = sanitizeSessionTitle(contentParts(reply.content).text);
      if (!title) {
        this.log.info("session-title", "unusable_reply", { preview: contentParts(reply.content).text.slice(0, 120) });
        return;
      }
      if (this.active !== active) return;
      active.session.setSessionName(title);
      this.log.info("session-title", "named", { title, model: `${model.provider}/${model.id}` });
      void this.listSessions(active.cwd);
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    } catch (error) {
      // 命名失败保留兜底标题就好，不要打扰这次对话。
      this.log.warn("session-title", "naming_failed", { error: errorMessage(error) });
    }
  }

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
    promptDocument?: PromptDocument,
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
      if (!hasUserMessage) {
        // 先用第一句话兜底，第一轮结束后再让模型起个像样的名字。
        active.session.setSessionName(titleFromText(prompt));
        active.titlePending = true;
      }
      this.queueClientMessage(active, clientMessageId, expandedPrompt, promptDocument);
      const run = active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        preflightResult: () => { this.promptStarting = false; },
      });
      void run.then(() => {
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
      await this.startPrompt(active, next.text, next.images, next.id, true, next.promptDocument);
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
