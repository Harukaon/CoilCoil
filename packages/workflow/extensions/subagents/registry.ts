import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  SubagentActivityPayload,
  SubagentMessageEntry,
  SubagentRecentToolEntry,
  SubagentRunStatus,
  SubagentToolCallEntry,
  SubagentToolDetails,
  SubagentTimelineEntry,
} from "./types.ts";
import { SUBAGENT_RUN_STATUSES } from "./types.ts";

const MAX_RECENT_TOOLS = 12;
const MAX_RECENT_OUTPUT = 24;
const MAX_MESSAGES = 40;
const MAX_TOOL_CALLS = 80;
const MAX_TIMELINE_ENTRIES = 120;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_FINAL_OUTPUT_CHARS = 48_000;

export interface ChildRun {
  runId: string;
  parentToolId?: string;
  agent: string;
  task: string;
  model?: string;
  modelInherited?: boolean;
  tools?: string[];
  background: boolean;
  status: SubagentRunStatus;
  session?: AgentSession;
  unsubscribe?: () => void;
  dispose?: () => Promise<void>;
  sessionFile?: string;
  worktreeRequired?: boolean;
  worktreePath?: string;
  worktreeRepoRoot?: string;
  startedAt: number;
  finishedAt?: number;
  currentTool?: string;
  currentPath?: string;
  recentTools: SubagentRecentToolEntry[];
  recentOutput: string[];
  messages: SubagentMessageEntry[];
  toolCalls: SubagentToolCallEntry[];
  timeline: SubagentTimelineEntry[];
  toolCount: number;
  turnCount: number;
  tokens: number;
  finalOutput?: string;
  error?: string;
  stopRequested?: boolean;
  controlOperation?: SubagentControlOperation;
  bashBuffer: string;
  planId?: string;
}

export type SubagentControlOperation = "stop" | "resume";

export function acquireRunControl(run: ChildRun, operation: SubagentControlOperation): () => void {
  if (run.controlOperation) {
    const active = run.controlOperation === "stop" ? "停止" : "恢复";
    throw new Error(`子 Agent ${run.runId} 正在${active}，请稍后重试。`);
  }
  run.controlOperation = operation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (run.controlOperation === operation) run.controlOperation = undefined;
  };
}

export function prepareRunForResume(run: ChildRun, background: boolean, parentToolId?: string): void {
  run.background = background;
  if (parentToolId !== undefined) run.parentToolId = parentToolId;
  run.status = "running";
  run.finishedAt = undefined;
  run.error = undefined;
  run.stopRequested = false;
  run.currentTool = undefined;
  run.currentPath = undefined;
}

export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（已截断）`;
}

export function isSubagentRunStatus(value: unknown): value is SubagentRunStatus {
  return typeof value === "string" && (SUBAGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function runIsLive(run: ChildRun): boolean {
  return run.status === "pending" || run.status === "running";
}

export function runIsTerminal(run: ChildRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "stopped";
}

export class SubagentRegistry {
  private runs = new Map<string, ChildRun>();

  add(run: ChildRun): void {
    this.runs.set(run.runId, run);
  }

  get(runId: string): ChildRun | undefined {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const matches = [...this.runs.keys()].filter((key) => key.startsWith(runId));
    if (matches.length === 1) return this.runs.get(matches[0]);
    return undefined;
  }

  list(): ChildRun[] {
    return [...this.runs.values()].sort((left, right) => left.startedAt - right.startedAt);
  }

  liveCount(): number {
    return this.list().filter(runIsLive).length;
  }

  clear(): void {
    this.runs.clear();
  }

  toActivity(run: ChildRun): SubagentActivityPayload {
    const now = Date.now();
    return {
      id: run.runId,
      runId: run.runId,
      parentToolId: run.parentToolId,
      index: 0,
      agent: run.agent,
      task: run.task,
      model: run.model,
      status: run.status,
      background: run.background,
      controlReady: runIsLive(run) && run.session !== undefined ? true : undefined,
      resumable: runIsTerminal(run) && run.sessionFile !== undefined ? true : undefined,
      currentTool: run.currentTool,
      currentPath: run.currentPath,
      recentTools: run.recentTools.length ? [...run.recentTools] : undefined,
      recentOutput: run.recentOutput.length ? [...run.recentOutput] : undefined,
      messages: run.messages.length ? [...run.messages] : undefined,
      toolCalls: run.toolCalls.length ? [...run.toolCalls] : undefined,
      timeline: run.timeline.length ? [...run.timeline] : undefined,
      finalOutput: run.finalOutput ? clampText(run.finalOutput, MAX_FINAL_OUTPUT_CHARS) : undefined,
      sessionFile: run.sessionFile,
      worktreePath: run.worktreePath,
      toolCount: run.toolCount,
      turnCount: run.turnCount || undefined,
      tokens: run.tokens,
      durationMs: (run.finishedAt ?? now) - run.startedAt,
      error: run.error,
      updatedAt: run.finishedAt ?? now,
      planId: run.planId,
      modelInherited: run.modelInherited,
    };
  }

  toDetails(run: ChildRun): SubagentToolDetails {
    return {
      runId: run.runId,
      background: run.background,
      agent: run.agent,
      task: run.task,
      model: run.model,
      status: run.status,
      sessionFile: run.sessionFile,
      worktreePath: run.worktreePath,
      finalOutput: run.finalOutput ? clampText(run.finalOutput, MAX_FINAL_OUTPUT_CHARS) : undefined,
      error: run.error,
      resumable: runIsTerminal(run) && run.sessionFile !== undefined ? true : undefined,
      toolCount: run.toolCount,
      durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
      usage: { total: run.tokens, turns: run.turnCount || undefined },
      planId: run.planId,
    };
  }

  recordRecentTool(run: ChildRun, tool: string, args: string): void {
    run.recentTools.push({ tool, args: clampText(args, 2_000) });
    if (run.recentTools.length > MAX_RECENT_TOOLS) run.recentTools.splice(0, run.recentTools.length - MAX_RECENT_TOOLS);
  }

  recordRecentOutput(run: ChildRun, output: string): void {
    const trimmed = output.trim();
    if (!trimmed) return;
    run.recentOutput.push(clampText(trimmed, MAX_OUTPUT_CHARS));
    if (run.recentOutput.length > MAX_RECENT_OUTPUT) run.recentOutput.splice(0, run.recentOutput.length - MAX_RECENT_OUTPUT);
  }

  recordMessage(run: ChildRun, message: SubagentMessageEntry): void {
    run.messages.push({
      role: message.role,
      text: clampText(message.text, 24_000),
      thinking: message.thinking ? clampText(message.thinking, 24_000) : undefined,
    });
    if (run.messages.length > MAX_MESSAGES) run.messages.splice(0, run.messages.length - MAX_MESSAGES);
  }

  recordToolCall(run: ChildRun, call: SubagentToolCallEntry): void {
    run.toolCalls.push({
      text: clampText(call.text, 2_000),
      expandedText: call.expandedText ? clampText(call.expandedText, 16_000) : undefined,
    });
    if (run.toolCalls.length > MAX_TOOL_CALLS) run.toolCalls.splice(0, run.toolCalls.length - MAX_TOOL_CALLS);
  }

  recordTimelineMessage(run: ChildRun, message: SubagentMessageEntry): void {
    run.timeline.push({
      id: `message-${run.runId}-${run.timeline.length}`,
      order: run.timeline.length,
      kind: "message",
      role: message.role,
      text: clampText(message.text, 24_000),
      thinking: message.thinking ? clampText(message.thinking, 24_000) : undefined,
    });
    this.trimTimeline(run);
  }

  recordTimelineToolStart(run: ChildRun, input: { id: string; tool: string; args: string; expandedArgs?: string }): void {
    run.timeline.push({
      id: input.id,
      order: run.timeline.length,
      kind: "tool",
      tool: input.tool,
      args: clampText(input.args, 2_000),
      expandedArgs: input.expandedArgs ? clampText(input.expandedArgs, 16_000) : undefined,
      status: "running",
    });
    this.trimTimeline(run);
  }

  recordTimelineToolEnd(run: ChildRun, input: { id: string; output?: string; failed: boolean }): void {
    const entry = run.timeline.find((item) => item.kind === "tool" && item.id === input.id);
    if (!entry || entry.kind !== "tool") return;
    entry.output = input.output ? clampText(input.output, 24_000) : undefined;
    entry.status = input.failed ? "failed" : "succeeded";
  }

  private trimTimeline(run: ChildRun): void {
    if (run.timeline.length <= MAX_TIMELINE_ENTRIES) return;
    run.timeline.splice(0, run.timeline.length - MAX_TIMELINE_ENTRIES);
    run.timeline.forEach((entry, index) => { entry.order = index; });
  }
}

export function createRunId(): string {
  return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
