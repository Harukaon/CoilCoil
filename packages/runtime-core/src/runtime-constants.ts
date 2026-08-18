import {
  type ProjectMemoryRuntimeStatus,
  type RuntimeEvent,
} from "@suocode/runtime-protocol";
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

export const WORKFLOW_AUDIT_ENTRY_TYPE = "suocode-tool-purpose-audit";

export const RESPONSE_METRICS_ENTRY_TYPE = "suocode-response-metrics";

export const PROJECT_MEMORY_STATUS_EVENT = "suocode:project-memory:status:v1";

export const FAST_STATE_EVENT = "suocode:fast:state:v1";

export const RUNTIME_BRIDGE_COMMAND_EVENT = "suocode:runtime-bridge:command:v1";

export const RUNTIME_BRIDGE_REPLY_PREFIX = "suocode:runtime-bridge:reply:v1:";

export const RUNTIME_BRIDGE_STATE_EVENT = "suocode:runtime-bridge:state:v1";

export const ABANDONED_TOOL_OUTPUT = "工具调用未完成：会话在返回执行结果前中断。";

export const ORIGINAL_SESSION_MUTATION_UNSUPPORTED = "Pi 当前无法安全地从原会话中删除这段历史内容，未执行任何修改。";

export const projectMemoryStatusByCwd = new Map<string, ProjectMemoryRuntimeStatus>();

export const SUBAGENT_ACTIVITY_CHANNEL = "suocode:subagents:activity:v1";

export const SUBAGENT_RPC_REQUEST_CHANNEL = "suocode:subagents:rpc:v1:request";

export const SUBAGENT_RUN_ENTRY_TYPE = "subagent-run";

export const PLAN_STATE_CHANNEL = "suocode:plan:state:v1";

export const PLAN_RPC_REQUEST_CHANNEL = "suocode:plan:rpc:v1:request";

export const PLAN_ENTRY_TYPE = "suocode-plan";

export const WORKFLOW_PURPOSE_REGISTRY = Symbol.for("suocode-workflow.tool-purpose-registry");

export const TOOL_PURPOSE_POLICY_STATE = Symbol.for("suocode-workflow.tool-purpose-policy-state");

export const MCP_AGENT_CONFIG_REGISTRY = Symbol.for("suocode-workflow.mcp-agent-config-registry");

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
