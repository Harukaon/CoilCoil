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

/** Editor-only metadata for restoring atomic browser nodes without changing Pi's prompt. */
export const PROMPT_DOCUMENT_ENTRY_TYPE = "coilcoil-prompt-document-v1";

export const PROJECT_MEMORY_STATUS_EVENT = "coilcoil:project-memory:status:v1";
/** Where context-clearing announces each batch of tool results it drops. */
export const CONTEXT_CLEARING_EVENT = "coilcoil:context-clearing:v1";
/** CoilCoil 压缩扩展（workflow/extensions/compaction.ts）的进度与结果：哪一层、几块、耗时、失败原因。 */
export const COMPACTION_EVENT = "coilcoil:compaction:v1";
/** Clearings kept per session. Old ones scroll out of the transcript anyway. */
export const MAX_CONTEXT_CLEARINGS = 40;

/**
 * 两条只进日志、不上界面的通道。
 *
 * 上下文这一块出问题的时候，界面上能看到的只有一条「已清理 N 条」和一条「压缩失
 * 败」，中间的判断全是黑的：到底有没有到线、这一轮还有没有机会、交给 pi 去摘要的
 * 那一段到底多大。查一次就得去翻会话文件重算一遍——真发生过。
 */
export const CONTEXT_SUMMARY_TRIM_EVENT = "coilcoil:context-clearing:summary:v1";
export const CONTEXT_CLEARING_SKIPPED_EVENT = "coilcoil:context-clearing:skipped:v1";

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
 * `plan` is half-built: the approval loop has known gaps, and an Agent that
 * reaches for it mid-task ends up somewhere worse than one that just does the
 * work. The extension stays in the manifest — its RPC channels, its
 * session-entry restore, and the cards for sessions that already contain plan
 * runs all keep working — but Pi is asked to exclude the tool itself, which
 * drops its schema and prompt guidelines before the system prompt is ever
 * built. Empty this list to bring it back once it is rewritten along
 * oh-my-pi's lines.
 */
export const HIDDEN_AGENT_TOOLS: readonly string[] = ["plan"];

export const GOAL_STATE_CHANNEL = "coilcoil:goal:state:v1";

export const PLAN_STATE_CHANNEL = "coilcoil:plan:state:v1";

export const PLAN_RPC_REQUEST_CHANNEL = "coilcoil:plan:rpc:v1:request";

export const PLAN_ENTRY_TYPE = "coilcoil-plan";

export const WORKFLOW_PURPOSE_REGISTRY = Symbol.for("coilcoil-workflow.tool-purpose-registry");

export const TOOL_PURPOSE_POLICY_STATE = Symbol.for("coilcoil-workflow.tool-purpose-policy-state");

export const MCP_AGENT_CONFIG_REGISTRY = Symbol.for("coilcoil-workflow.mcp-agent-config-registry");

/**
 * How the MCP adapter extension asks for CoilCoil's own server list.
 *
 * The list used to be looked up in a WeakMap keyed by the session's event bus,
 * which worked only while Pi handed extensions that exact object. Pi now gives
 * each extension a `{emit, on}` wrapper instead, so the lookup silently missed
 * and the adapter fell back to reading the raw config files — dropping the
 * bundled browser server and ignoring CoilCoil's removed-server list.
 *
 * Asking over the bus needs no shared object identity, so it keeps working
 * whatever Pi passes as `events`. Emitting is synchronous, so the answer is
 * filled into the request before `emit` returns.
 */
export const MCP_AGENT_CONFIG_CHANNEL = "coilcoil:mcp:agent-config:v1";

/**
 * How the MCP tools extension reaches the runtime's own MCP client.
 *
 * Same trick as the configuration channel above, and for the same reason: Pi
 * hands extensions a wrapper around the event bus rather than the bus itself,
 * so an identity lookup misses. The extension emits a request object and the
 * runtime fills it in synchronously.
 */
export const MCP_MANAGER_CHANNEL = "coilcoil:mcp:manager:v1";

/**
 * How the `coilcoil` setup tool reaches the runtime's configuration methods.
 *
 * Same direction as the subagent/plan RPC channels, and for the same reason:
 * the extension only gets a `{emit, on}` wrapper, never the runtime object.
 * The extension emits a request, the runtime answers on a per-request reply
 * channel. The runtime installs its listener when the session is created, so
 * it is in place before any tool call can ask.
 *
 * Answers run through the same methods the settings panel uses. Writing the
 * file alone is not enough — the live session must be reloaded and the server
 * actually connected — which is why the tool does not bash the config files
 * itself.
 */
export const SETUP_RPC_REQUEST_CHANNEL = "coilcoil:setup:rpc:v1:request";
export const SETUP_RPC_REPLY_PREFIX = "coilcoil:setup:rpc:v1:reply:";

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

/**
 * Tools whose runs are one shell command and are mirrored into the terminal
 * panel. `powershell` is Pi's native Windows shell tool, active only there.
 */
export const SHELL_TOOL_NAMES: readonly string[] = ["bash", "powershell"];

export function isShellToolName(name: string): boolean {
  return SHELL_TOOL_NAMES.includes(name);
}
