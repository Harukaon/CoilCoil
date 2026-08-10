export const SUBAGENT_ACTIVITY_CHANNEL = "suocode:subagents:activity:v1";
export const SUBAGENT_RPC_REQUEST_CHANNEL = "suocode:subagents:rpc:v1:request";
export const SUBAGENT_RUN_ENTRY_TYPE = "subagent-run";
export const SUBAGENT_META_ENTRY_TYPE = "suocode-subagent-meta";

export function subagentRpcReplyChannel(requestId: string): string {
  return `suocode:subagents:rpc:v1:reply:${requestId}`;
}

export type SubagentRunStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export const SUBAGENT_RUN_STATUSES: readonly SubagentRunStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "stopped",
];

export interface SubagentRecentToolEntry {
  tool: string;
  args: string;
}

export interface SubagentToolCallEntry {
  text: string;
  expandedText?: string;
}

export interface SubagentMessageEntry {
  role: string;
  text: string;
  thinking?: string;
}

export type SubagentTimelineEntry =
  | {
      id: string;
      order: number;
      kind: "message";
      role: string;
      text: string;
      thinking?: string;
    }
  | {
      id: string;
      order: number;
      kind: "tool";
      tool: string;
      args: string;
      expandedArgs?: string;
      output?: string;
      status: "running" | "succeeded" | "failed";
    };

export interface SubagentActivityPayload {
  id: string;
  runId: string;
  parentToolId?: string;
  index: number;
  agent: string;
  task?: string;
  model?: string;
  status: SubagentRunStatus;
  background: boolean;
  controlReady?: boolean;
  resumable?: boolean;
  currentTool?: string;
  currentPath?: string;
  recentTools?: SubagentRecentToolEntry[];
  recentOutput?: string[];
  messages?: SubagentMessageEntry[];
  toolCalls?: SubagentToolCallEntry[];
  timeline?: SubagentTimelineEntry[];
  finalOutput?: string;
  sessionFile?: string;
  worktreePath?: string;
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  error?: string;
  updatedAt: number;
  /** Durable plan that requested this run, when dispatched from the plan tool. */
  planId?: string;
}

export interface SubagentUsageDetails {
  total: number;
  turns?: number;
}

export interface SubagentToolDetails {
  runId: string;
  background: boolean;
  agent: string;
  task?: string;
  model?: string;
  status: SubagentRunStatus;
  sessionFile?: string;
  worktreePath?: string;
  finalOutput?: string;
  error?: string;
  resumable?: boolean;
  toolCount?: number;
  durationMs?: number;
  usage?: SubagentUsageDetails;
  planId?: string;
}

export type SubagentRpcMethod = "run" | "stop" | "status" | "resume";

export interface SubagentRpcRequest {
  version: number;
  requestId: string;
  method: SubagentRpcMethod;
  params?: {
    id?: string;
    agent?: string;
    task?: string;
    model?: string;
    background?: boolean;
    worktree?: boolean;
    planId?: string;
  };
  source?: { client?: string };
}

export interface SubagentChildMeta {
  runId: string;
  agent: string;
  task: string;
  model?: string;
  tools?: string[];
  background: boolean;
  parentSessionId: string;
  parentSessionFile?: string;
  worktree?: boolean;
  worktreePath?: string;
  startedAt: number;
  planId?: string;
}
