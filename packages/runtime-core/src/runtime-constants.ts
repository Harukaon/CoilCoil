import {
  type ProjectMemoryRuntimeStatus,
  type RuntimeEvent,
} from "@coilcoil/runtime-protocol";
import {
  execFile,
} from "node:child_process";
import {
  createRequire,
} from "node:module";
import {
  promisify,
} from "node:util";

export const execFileAsync = promisify(execFile);

export const require = createRequire(import.meta.url);

export const MAX_CHANGE_FILES = 100;

export const MAX_PATCH_CHARS = 16_000;

export const MAX_TERMINAL_OUTPUT = 120_000;

export const MASKED_CONFIGURATION_VALUE = "••••••";

export const WORKFLOW_AUDIT_ENTRY_TYPE = "coilcoil-tool-purpose-audit";

export const RESPONSE_METRICS_ENTRY_TYPE = "coilcoil-response-metrics";

export const PROJECT_MEMORY_STATUS_EVENT = "coilcoil:project-memory:status:v1";

export const FAST_STATE_EVENT = "coilcoil:fast:state:v1";

export const RUNTIME_BRIDGE_COMMAND_EVENT = "coilcoil:runtime-bridge:command:v1";

export const RUNTIME_BRIDGE_REPLY_PREFIX = "coilcoil:runtime-bridge:reply:v1:";

export const RUNTIME_BRIDGE_STATE_EVENT = "coilcoil:runtime-bridge:state:v1";

export const ABANDONED_TOOL_OUTPUT = "工具调用未完成：会话在返回执行结果前中断。";

export const ORIGINAL_SESSION_MUTATION_UNSUPPORTED = "Pi 当前无法安全地从原会话中删除这段历史内容，未执行任何修改。";

export const projectMemoryStatusByCwd = new Map<string, ProjectMemoryRuntimeStatus>();

export const SUBAGENT_ACTIVITY_CHANNEL = "coilcoil:subagents:activity:v1";

export const SUBAGENT_RPC_REQUEST_CHANNEL = "coilcoil:subagents:rpc:v1:request";

export const SUBAGENT_RUN_ENTRY_TYPE = "subagent-run";

/** How long a stop may take before the runtime explains what it is waiting on. */
export const ABORT_STALL_NOTICE_MS = 10_000;

/**
 * Tools the workflow registers but the Agent is not told about.
 *
 * `plan` and `subagent` are half-built: the approval loop and the subagent
 * engine both have known gaps, and an Agent that reaches for them mid-task ends
 * up somewhere worse than one that just does the work. The extensions stay in
 * the manifest — their RPC channels, their session-entry restore, and the cards
 * for sessions that already contain plan or subagent runs all keep working —
 * but Pi is asked to exclude the tools themselves, which drops their schemas
 * and their prompt guidelines before the system prompt is ever built. Empty
 * this list to bring them back once they are rewritten along oh-my-pi's lines.
 */
export const HIDDEN_AGENT_TOOLS: readonly string[] = ["plan", "subagent"];

export const GOAL_STATE_CHANNEL = "coilcoil:goal:state:v1";

export const PLAN_STATE_CHANNEL = "coilcoil:plan:state:v1";

export const PLAN_RPC_REQUEST_CHANNEL = "coilcoil:plan:rpc:v1:request";

export const PLAN_ENTRY_TYPE = "coilcoil-plan";

export const WORKFLOW_PURPOSE_REGISTRY = Symbol.for("coilcoil-workflow.tool-purpose-registry");

export const TOOL_PURPOSE_POLICY_STATE = Symbol.for("coilcoil-workflow.tool-purpose-policy-state");

export const MCP_AGENT_CONFIG_REGISTRY = Symbol.for("coilcoil-workflow.mcp-agent-config-registry");

export const WORKFLOW_PURPOSE_FIELDS = ["purpose", "_auditPurpose", "__auditPurpose"] as const;

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
  "target",
]);

export type EventSink = (event: RuntimeEvent) => void;
