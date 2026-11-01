import type { DiagnosticLog } from "./log-file.js";
import { diagnosticArgumentValues, diagnosticToolTarget, diagnosticValueSummary, omitArgumentEchoes } from "./metadata.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export interface AgentDiagnosticContext {
  sessionId?: string;
  sessionPath?: string;
  cwd?: string;
  parentSessionId?: string;
  role?: string;
  provider?: string;
  model?: string;
}

interface ToolAttempt {
  sequence: number;
  startedAt: number;
  target: Record<string, string>;
  summary: ReturnType<typeof diagnosticValueSummary>;
  fields: Record<string, string>;
  argumentValues: string[];
}

function failureMessage(result: unknown): string {
  if (!object(result)) return "Tool execution failed";
  if (typeof result.error === "string") return result.error.slice(0, 2_000);
  if (object(result.error) && typeof result.error.message === "string") return result.error.message.slice(0, 2_000);
  if (Array.isArray(result.content)) {
    const text = result.content.find((part) => object(part) && part.type === "text" && typeof part.text === "string");
    if (object(text)) return String(text.text).slice(0, 2_000);
  }
  return "Tool execution failed";
}

function textResultSize(result: unknown): number {
  if (!object(result) || !Array.isArray(result.content)) return 0;
  return result.content.reduce((sum, part) => sum + (object(part) && part.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0);
}

/** One observer per session. Never writes transcripts or changes model context. */
export class AgentDiagnosticRecorder {
  private sequence = 0;
  private turn = 0;
  private runStartedAt = 0;
  private responseStartedAt = 0;
  private firstTokenAt?: number;
  private readonly tools = new Map<string, ToolAttempt>();
  private readonly announced = new Map<string, { name: string; args: unknown }>();
  private readonly failures = new Map<string, { callId: string; attempt: ToolAttempt }>();

  constructor(private readonly log: Pick<DiagnosticLog, "log">, private readonly context: () => AgentDiagnosticContext) {}

  private write(level: "info" | "warn" | "error", scope: string, event: string, data: RecordValue = {}, error?: unknown): void {
    const { sessionPath, ...context } = this.context();
    this.log.log(level, scope, event, { ...context, turn: this.turn, ...data }, { sessionPath, ...(error === undefined ? {} : { error }) });
  }

  record(event: { type: string; [key: string]: unknown }): void {
    if (event.type === "agent_start") {
      this.runStartedAt = Date.now();
      this.failures.clear();
      this.write("info", "agent", "started");
    } else if (event.type === "turn_start") {
      this.turn++;
      this.responseStartedAt = Date.now();
      this.firstTokenAt = undefined;
      this.write("info", "model", "turn_started");
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (this.firstTokenAt === undefined && object(update) && ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(update.type)) && typeof update.delta === "string" && update.delta.length) this.firstTokenAt = Date.now();
    } else if (event.type === "message_end" && object(event.message)) {
      const message = event.message;
      if (message.role === "assistant") {
        const usage = object(message.usage) ? message.usage : {};
        const cost = object(usage.cost) ? usage.cost : {};
        const calls = Array.isArray(message.content) ? message.content.filter((part) => object(part) && part.type === "toolCall") : [];
        for (const call of calls) if (object(call) && typeof call.id === "string") this.announced.set(call.id, { name: String(call.name), args: call.arguments });
        const failed = message.stopReason === "error";
        this.write(failed ? "error" : "info", "model", "response_finished", {
          provider: message.provider, model: message.model, api: message.api, stopReason: message.stopReason,
          inputTokens: number(usage.input), outputTokens: number(usage.output), cacheReadTokens: number(usage.cacheRead), cacheWriteTokens: number(usage.cacheWrite),
          totalTokens: number(usage.totalTokens), cost: number(cost.total), toolCalls: calls.length,
          responseBytes: diagnosticValueSummary(message.content).bytes,
          turnElapsedMs: this.responseStartedAt ? Date.now() - this.responseStartedAt : undefined,
          firstDeltaSinceTurnMs: this.firstTokenAt !== undefined && this.responseStartedAt ? this.firstTokenAt - this.responseStartedAt : undefined,
        }, failed ? string(message.errorMessage) ?? "Model request failed" : undefined);
      } else if (message.role === "user") {
        this.write("info", "conversation", "user_message", { contentBytes: diagnosticValueSummary(message.content).bytes });
      }
    } else if (event.type === "entry_appended" && object(event.entry) && event.entry.type === "custom"
      && event.entry.customType === "coilcoil-response-metrics" && object(event.entry.data)) {
      const metrics = event.entry.data;
      this.write("info", "model", "response_timing", Object.fromEntries(
        ["firstTokenMs", "averageTokensPerSecond", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalMs", "turnDurationMs", "timestamp"]
          .map((key) => [key, number(metrics[key])])));
    } else if (event.type === "tool_execution_start") {
      const id = String(event.toolCallId);
      const attempt = this.newAttempt(String(event.toolName), event.args);
      this.tools.set(id, attempt);
      this.announced.delete(id);
      const previous = this.failures.get(JSON.stringify(attempt.target));
      const changedKeys = previous ? [...new Set([...Object.keys(previous.attempt.fields), ...Object.keys(attempt.fields)])].filter((key) => previous.attempt.fields[key] !== attempt.fields[key]) : undefined;
      this.write("info", "tool", "started", {
        callId: id, sequence: attempt.sequence, ...attempt.target, argumentBytes: attempt.summary.bytes,
        argumentFingerprint: attempt.summary.fingerprint, parameterShape: attempt.summary.shape, measurementBounded: attempt.summary.bounded,
        ...(previous ? { previousFailureCallId: previous.callId, previousFailureSequence: previous.attempt.sequence, changedKeys } : {}),
      });
    } else if (event.type === "tool_execution_end") {
      const id = String(event.toolCallId);
      const announced = this.announced.get(id);
      const started = this.tools.get(id);
      const attempt = started ?? this.newAttempt(String(event.toolName), announced?.args);
      const target = JSON.stringify(attempt.target);
      const previous = this.failures.get(target);
      const summary = diagnosticValueSummary(event.result);
      const chars = textResultSize(event.result);
      this.write(event.isError ? "error" : "info", "tool", "finished", {
        callId: id, sequence: attempt.sequence, ...attempt.target, succeeded: event.isError !== true,
        executed: Boolean(started), durationMs: number(event.durationMs) ?? (started ? Date.now() - attempt.startedAt : 0),
        argumentBytes: attempt.summary.bytes, argumentFingerprint: attempt.summary.fingerprint,
        ...(!started ? { parameterShape: attempt.summary.shape } : {}),
        resultBytes: summary.bytes, resultFingerprint: summary.fingerprint, measurementBounded: summary.bounded,
        textResultEstimatedTokens: Math.ceil(chars / 4), tokenEstimateMethod: "text_chars_div_4",
        ...(previous ? { previousFailureCallId: previous.callId, previousFailureSequence: previous.attempt.sequence } : {}),
      }, event.isError ? omitArgumentEchoes(failureMessage(event.result), attempt.argumentValues) : undefined);
      attempt.argumentValues = [];
      if (event.isError) this.failures.set(target, { callId: id, attempt });
      else this.failures.delete(target);
      this.tools.delete(id);
      this.announced.delete(id);
    } else if (event.type === "agent_settled") {
      for (const [callId, attempt] of this.tools) this.write("error", "tool", "interrupted", { callId, sequence: attempt.sequence, ...attempt.target }, "Agent settled before tool completion");
      this.tools.clear(); this.announced.clear();
      this.write("info", "agent", "settled", { durationMs: this.runStartedAt ? Date.now() - this.runStartedAt : undefined, aborted: event.aborted });
    }
  }

  private newAttempt(name: string, args: unknown): ToolAttempt {
    const fields: Record<string, string> = Object.create(null);
    const visit = (value: unknown, path: string, depth: number): void => {
      if (Object.keys(fields).length >= 100) return;
      if (object(value) && depth < 4 && Object.keys(value).length) {
        for (const [key, child] of Object.entries(value).slice(0, 100)) visit(child, path ? `${path}.${key}` : key, depth + 1);
      } else if (path) fields[path] = diagnosticValueSummary(value).fingerprint;
    };
    visit(args, "", 0);
    return { sequence: ++this.sequence, startedAt: Date.now(), target: diagnosticToolTarget(name, args), summary: diagnosticValueSummary(args), fields, argumentValues: diagnosticArgumentValues(args) };
  }
}
