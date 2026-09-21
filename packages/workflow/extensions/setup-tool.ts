/**
 * The Agent's door to CoilCoil itself: what this app can do, plus doing it.
 *
 * One tool, three areas — deliberately. Configuring an MCP server is a config
 * edit, installing a skill is a file copy, and the model already owns file
 * tools; what it lacks is *where* and *how*, plus the half no file edit can
 * do (reload the live session, connect the server, run the OAuth loop). So
 * `guide` serves that knowledge as text, and `mcp` / `skill` run the very
 * methods the settings panel uses, over an RPC channel the runtime answers.
 * Nothing here touches config files directly: writing the file without the
 * reload leaves the Agent staring at the old world, and the removed/disabled
 * bookkeeping disagrees with the panel.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readBundledDoc,
  setupGuide,
  summarizeBundledDoc,
  type GuideTopic,
} from "./setup-guide.ts";

export const SETUP_RPC_REQUEST_CHANNEL = "coilcoil:setup:rpc:v1:request";
export const SETUP_RPC_REPLY_PREFIX = "coilcoil:setup:rpc:v1:reply:";
export const COILCOIL_TOOL_NAME = "coilcoil";
const SETUP_RPC_TIMEOUT_MS = 120_000;
const DOC_PREVIEW_CHARS = 8_000;

const CoilcoilParams = Type.Object({
  area: StringEnum(["guide", "mcp", "skill"], {
    description: "guide：先看教程（装 skill / 配 MCP / 认证怎么走）；mcp：查配改连 MCP（含认证）；skill：列装启停 Skill",
  }),
  op: Type.Optional(Type.String({
    description: "guide: skill / mcp / auth / read_doc；mcp: list/save/get_json/save_json/remove/enable/discover/import/parse_snippet/connect/auth_start/auth_await_each/auth_finish/auth_cancel/auth_complete/logout/session_enable；skill: list/install/enable/disable/remove/delete/session_enable/session_disable",
  })),
  topic: Type.Optional(Type.String({ description: "area=guide 且 op 不为 read_doc 时：skill / mcp / auth" })),
  doc: Type.Optional(Type.String({ description: "area=guide + op=read_doc 时：文档名，如 architecture、readme" })),
  name: Type.Optional(Type.String({ description: "mcp 的 Server 名（connect/认证/logout/enable/remove 用）" })),
  filePath: Type.Optional(Type.String({ description: "skill 的文件路径（enable/disable/remove/delete 用）" })),
  path: Type.Optional(Type.String({ description: "skill 的本地目录（install 用）" })),
  server: Type.Optional(Type.Any({ description: "mcp save 时的服务器定义（name/scope/transport/command/url/env/headers…）" })),
  text: Type.Optional(Type.String({ description: "parse_snippet 的配置 JSON；save_json 的 mcp.json 全文；auth_complete 粘贴的回调内容" })),
  input: Type.Optional(Type.String({ description: "auth_complete 粘贴的回调内容的别名，和 text 二选一" })),
  enabled: Type.Optional(Type.Boolean({ description: "enable/disable/session_enable/session_disable 的开关" })),
  scope: Type.Optional(Type.String({ description: "save/remove 的作用域：global / project" })),
  previousName: Type.Optional(Type.String({ description: "改名保存时填旧名" })),
  servers: Type.Optional(Type.Any({ description: "import 时的 origin+name 列表" })),
  imports: Type.Optional(Type.Any({ description: "enable_imports 时的来源列表" })),
});

type CoilcoilParamsValue = {
  area: "guide" | "mcp" | "skill";
  op?: string;
  topic?: string;
  doc?: string;
  name?: string;
  filePath?: string;
  path?: string;
  server?: unknown;
  text?: string;
  input?: string;
  enabled?: boolean;
  scope?: string;
  previousName?: string;
  servers?: unknown;
  imports?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textResult(text: string, details: Record<string, unknown>, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
} {
  return { content: [{ type: "text", text }], details, isError };
}

function workflowDir(): string {
  // The document shelf lives next to the workflow *package*, not the agent
  // *data* directory: <repo>/packages/workflow. getAgentDir() points at the
  // data dir, so resolve the package through the extension file itself.
  try {
    const here = fileURLToPath(import.meta.url);
    return resolve(here, "..", "..");
  } catch {
    return "";
  }
}

function setupRequestFrom(raw: unknown): { requestId?: string; success?: boolean; data?: unknown; error?: unknown } {
  return isRecord(raw) ? raw as { requestId?: string; success?: boolean; data?: unknown; error?: unknown } : {};
}

/**
 * Ask the runtime to run one of its own configuration methods.
 *
 * Same shape as the subagent/plan RPC calls: emit a request, wait for the
 * per-request reply channel, time out out loud. Auth waits ride on this too,
 * which is why the timeout is minutes rather than seconds.
 */
async function setupRpc(
  pi: ExtensionAPI,
  method: string,
  params: Record<string, unknown> | undefined,
  cwd: string | undefined,
): Promise<unknown> {
  const requestId = `coilcoil-setup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const replyChannel = `${SETUP_RPC_REPLY_PREFIX}${requestId}`;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      callback();
    };
    const unsubscribe = pi.events.on(replyChannel, (raw) => {
      const reply = setupRequestFrom(raw);
      if (!isRecord(raw)) return;
      if (reply.success === true) {
        finish(() => resolvePromise(reply.data));
        return;
      }
      const message = isRecord(reply.error) && typeof reply.error.message === "string"
        ? reply.error.message
        : "配置请求失败。";
      finish(() => rejectPromise(new Error(message)));
    });
    const timer = setTimeout(
      () => finish(() => rejectPromise(new Error("配置请求超时：运行时没有应答。"))),
      SETUP_RPC_TIMEOUT_MS,
    );
    try {
      pi.events.emit(SETUP_RPC_REQUEST_CHANNEL, {
        version: 1,
        requestId,
        method,
        params,
        cwd,
      });
    } catch (error) {
      finish(() => rejectPromise(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

function renderMcpConfiguration(configuration: unknown): string {
  if (!isRecord(configuration) || !Array.isArray(configuration.servers)) return "没能读到 MCP 配置。";
  const servers = configuration.servers as Array<Record<string, unknown>>;
  if (!servers.length) return "当前没有配任何 MCP Server。用 op=save 按 guide 里 mcp 那节配第一个。";
  const lines = servers.map((server) => {
    const name = typeof server.name === "string" ? server.name : "?";
    const transport = server.transport === "http" ? String(server.url ?? "http") : String(server.command ?? "stdio");
    const scope = server.scope === "project" ? "项目" : "全局";
    const state = server.disabled === true ? "已停用" : "启用中";
    return `- ${name}（${scope} · ${state} · ${transport}）`;
  });
  return ["已配置的 MCP Server：", ...lines].join("\n");
}

function renderSkillConfiguration(configuration: unknown): string {
  if (!isRecord(configuration) || !Array.isArray(configuration.skills)) return "没能读到 Skill 配置。";
  const skills = configuration.skills as Array<Record<string, unknown>>;
  if (!skills.length) return "当前没有装任何 Skill。用 op=install 按 guide 里 skill 那节从本地目录装。";
  const lines = skills.map((skill) => {
    const name = typeof skill.name === "string" ? skill.name : "?";
    const source = typeof skill.source === "string" ? skill.source : "";
    const state = skill.enabled === false ? "已停用" : "启用中";
    const path = typeof skill.filePath === "string" ? skill.filePath : "";
    return `- ${name}（${state}${source ? ` · ${source}` : ""}）${path ? `\n  ${path}` : ""}`;
  });
  return ["已安装的 Skill：", ...lines].join("\n");
}

function renderSnippets(snippets: unknown): string {
  if (!Array.isArray(snippets) || !snippets.length) return "这段配置里没认出 MCP 服务器：需要 command（stdio）或 url（HTTP）。";
  return [
    `认出 ${snippets.length} 个服务器，确认后用 mcp op=save 逐个保存：`,
    ...snippets.map((entry, index) => {
      if (!isRecord(entry)) return `${index + 1}. （无法解析）`;
      const name = typeof entry.name === "string" ? entry.name : "（还没起名，save 时补一个 name）";
      const how = entry.transport === "http" ? String(entry.url ?? "") : String(entry.command ?? "");
      return `${index + 1}. ${name} · ${String(entry.transport ?? "?")} · ${how}`;
    }),
  ].join("\n");
}

/** `op` aliases: what people actually type, mapped to the runtime method. */
function resolveMcpMethod(op: string): string | undefined {
  const normalized = op.trim().toLowerCase();
  const table: Record<string, string> = {
    list: "mcp_list",
    save: "mcp_save_server",
    get_json: "mcp_get_json",
    save_json: "mcp_save_json",
    remove: "mcp_remove",
    delete: "mcp_remove",
    enable: "mcp_set_enabled",
    disable: "mcp_set_enabled",
    discover: "mcp_discover",
    import: "mcp_import",
    enable_imports: "mcp_enable_imports",
    parse_snippet: "mcp_parse_snippet",
    parse: "mcp_parse_snippet",
    connect: "mcp_connect",
    check: "mcp_connect",
    auth_start: "mcp_auth_start",
    auth: "mcp_auth_start",
    auth_await_each: "mcp_auth_await_callback",
    auth_await_callback: "mcp_auth_await_callback",
    auth_finish: "mcp_auth_finish",
    auth_await: "mcp_auth_await",
    auth_cancel: "mcp_auth_cancel",
    auth_complete: "mcp_auth_complete",
    logout: "mcp_logout",
    session_enable: "mcp_set_session_enabled",
    session_disable: "mcp_set_session_enabled",
  };
  return table[normalized];
}

function resolveSkillMethod(op: string): string | undefined {
  const normalized = op.trim().toLowerCase();
  const table: Record<string, string> = {
    list: "skill_list",
    install: "skill_install",
    add: "skill_install",
    enable: "skill_set_enabled",
    disable: "skill_set_enabled",
    remove: "skill_remove",
    delete: "skill_delete",
    remove_path: "skill_remove_path",
    session_enable: "skill_set_session_enabled",
    session_disable: "skill_set_session_enabled",
  };
  return table[normalized];
}

async function executeGuide(params: CoilcoilParamsValue): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean }> {
  const op = (params.op ?? "mcp").trim().toLowerCase();
  if (op === "read_doc") {
    const doc = params.doc?.trim() || params.topic?.trim() || "readme";
    try {
      const found = readBundledDoc(workflowDir(), doc);
      const preview = summarizeBundledDoc(found.path, found.content, DOC_PREVIEW_CHARS);
      return textResult(preview.content, {
        area: "guide",
        op: "read_doc",
        doc,
        path: preview.path,
        truncated: preview.truncated,
        totalChars: preview.totalChars,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(message, { area: "guide", op: "read_doc", doc, error: "doc_not_found" }, true);
    }
  }
  const topic = (params.topic ?? op) as GuideTopic;
  if (topic !== "skill" && topic !== "mcp" && topic !== "auth") {
    return textResult(
      `topic 只能是 skill / mcp / auth；要读自带文档用 op=read_doc + doc=文档名。`,
      { area: "guide", error: "bad_topic", topic: params.topic ?? params.op },
      true,
    );
  }
  const agentDir = (() => {
    try {
      return getAgentDir();
    } catch {
      return process.env.PI_CODING_AGENT_DIR?.trim() || "(拿不到 agent 目录)";
    }
  })();
  return textResult(setupGuide(topic, agentDir), { area: "guide", topic });
}

async function executeMcp(
  pi: ExtensionAPI,
  params: CoilcoilParamsValue,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean }> {
  const op = (params.op ?? "list").trim();
  const method = resolveMcpMethod(op);
  if (!method) {
    return textResult(
      `mcp 没有这个 op「${op}」。先用 area=guide + topic=mcp 看看该怎么配。`,
      { area: "mcp", error: "bad_op", op },
      true,
    );
  }
  const cwd = ctx.cwd || undefined;
  const callParams: Record<string, unknown> = {};
  if (params.name?.trim()) callParams.name = params.name.trim();
  if (params.server !== undefined) callParams.server = params.server;
  if (params.text !== undefined) callParams.text = params.text;
  if (params.input !== undefined) callParams.input = params.input;
  if (params.enabled !== undefined) callParams.enabled = params.enabled;
  if (params.scope?.trim()) callParams.scope = params.scope.trim();
  if (params.previousName?.trim()) callParams.previousName = params.previousName.trim();
  if (params.servers !== undefined) callParams.servers = params.servers;
  if (params.imports !== undefined) callParams.imports = params.imports;
  // `disable` / `session_disable` spell false without making the model say it.
  if ((method === "mcp_set_enabled" || method === "mcp_set_session_enabled") && params.enabled === undefined) {
    const lowered = op.trim().toLowerCase();
    if (lowered === "disable" || lowered === "session_disable") callParams.enabled = false;
    if (lowered === "enable" || lowered === "session_enable") callParams.enabled = true;
  }
  if (method === "mcp_auth_complete" && callParams.input === undefined && typeof callParams.text === "string") {
    callParams.input = callParams.text;
  }
  try {
    const data = await setupRpc(pi, method, callParams, cwd);
    if (!isRecord(data)) return textResult("运行时回了个看不懂的应答。", { area: "mcp", op, method }, true);
    if (method === "mcp_list") {
      const configuration = (data as { configuration?: unknown }).configuration;
      return textResult(renderMcpConfiguration(configuration), { area: "mcp", op, method, configuration });
    }
    if (method === "mcp_get_json") {
      const document = (data as { document?: { path?: string; content?: string } }).document;
      return textResult(
        typeof document?.content === "string" ? document.content : "没能读到 mcp.json。",
        { area: "mcp", op, method, path: document?.path, document },
      );
    }
    if (method === "mcp_parse_snippet") {
      const snippets = (data as { snippets?: unknown }).snippets;
      return textResult(renderSnippets(snippets), { area: "mcp", op, method, snippets });
    }
    if (method === "mcp_save_server" || method === "mcp_save_json" || method === "mcp_remove"
      || method === "mcp_set_enabled" || method === "mcp_import" || method === "mcp_enable_imports") {
      const configuration = (data as { configuration?: unknown }).configuration;
      return textResult(
        `${renderMcpConfiguration(configuration)}\n\n已保存并 reload，Agent 侧已生效。`,
        { area: "mcp", op, method, configuration },
      );
    }
    if (method === "mcp_discover") {
      const discovery = (data as { discovery?: { servers?: Array<{ origin?: string; name?: string; alreadyPresent?: boolean }> } }).discovery;
      const servers = discovery?.servers ?? [];
      const text = servers.length
        ? ["在别的工具里发现这些，还没搬过来（同名的不会覆盖）：",
          ...servers.map((entry) => `- ${entry.origin ?? "?"} · ${entry.name ?? "?"}${entry.alreadyPresent ? "（已在 CoilCoil 里有同名）" : ""}`),
        ].join("\n")
        : "别的工具里没发现可搬的 MCP 服务器。";
      return textResult(text, { area: "mcp", op, method, discovery });
    }
    const result = (data as { result?: { text?: string; details?: unknown } }).result;
    const text = typeof result?.text === "string" ? result.text : "做完了，但运行时没说什么。";
    const details = isRecord(result?.details) ? result.details as Record<string, unknown> : {};
    if (method === "mcp_connect") {
      const error = typeof details.error === "string" ? details.error : undefined;
      const hint = error === "auth_required"
        ? "\n\n这不是失败：去走 topic=auth 那四步（op=auth_start 先拿链接给用户点）。"
        : "";
      return textResult(`${text}${hint}`, { area: "mcp", op, method, ...details }, error !== undefined && error !== "auth_required");
    }
    if (method === "mcp_auth_start") {
      const url = typeof details.authorizationUrl === "string" ? details.authorizationUrl : undefined;
      const hint = url ? `\n\n把这个链接给用户去浏览器里点：${url}` : "";
      return textResult(`${text}${hint}`, { area: "mcp", op, method, ...details });
    }
    return textResult(text, { area: "mcp", op, method, ...details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(message, { area: "mcp", op, method, error: "rpc_failed", message }, true);
  }
}

async function executeSkill(
  pi: ExtensionAPI,
  params: CoilcoilParamsValue,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean }> {
  const op = (params.op ?? "list").trim();
  const method = resolveSkillMethod(op);
  if (!method) {
    return textResult(
      `skill 没有这个 op「${op}」。先用 area=guide + topic=skill 看看该装到哪。`,
      { area: "skill", error: "bad_op", op },
      true,
    );
  }
  const cwd = ctx.cwd || undefined;
  const callParams: Record<string, unknown> = {};
  if (params.filePath?.trim()) callParams.filePath = params.filePath.trim();
  if (params.path?.trim()) callParams.path = params.path.trim();
  if (params.enabled !== undefined) callParams.enabled = params.enabled;
  if (method === "skill_set_enabled" || method === "skill_set_session_enabled") {
    if (params.enabled === undefined) {
      const lowered = op.trim().toLowerCase();
      if (lowered === "disable" || lowered === "session_disable") callParams.enabled = false;
      if (lowered === "enable" || lowered === "session_enable") callParams.enabled = true;
    }
  }
  try {
    const data = await setupRpc(pi, method, callParams, cwd);
    if (!isRecord(data)) return textResult("运行时回了个看不懂的应答。", { area: "skill", op, method }, true);
    if (method === "skill_set_session_enabled") {
      const enabled = callParams.enabled === true;
      return textResult(
        enabled ? "这个 Skill 在当前会话恢复启用（配置没动）。" : "这个 Skill 在当前会话已停用（配置没动，切个会话就回来）。",
        { area: "skill", op, method },
      );
    }
    const configuration = (data as { configuration?: unknown }).configuration;
    const suffix = method === "skill_list" ? "" : "\n\n已生效（装完自动 reload，不用再调别的）。";
    return textResult(`${renderSkillConfiguration(configuration)}${suffix}`, { area: "skill", op, method, configuration });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(message, { area: "skill", op, method, error: "rpc_failed", message }, true);
  }
}

export default function coilcoilSetupTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: COILCOIL_TOOL_NAME,
    label: "CoilCoil",
    description:
      "CoilCoil 自己的说明书和配置口：guide 先看教程（装 skill / 配 MCP / 认证怎么走、自带文档怎么读），mcp 查配改连 MCP（含浏览器认证全套），skill 列装启停 Skill。配 MCP 改 Skill 永远走这个工具，不要自己 bash 改配置文件——写了文件不会 reload，Agent 照样看不到。",
    promptSnippet: "coilcoil: CoilCoil 自己的配置（MCP/Skill）和自带文档",
    promptGuidelines: [
      "用户让你配 MCP、装 Skill、登录某个 MCP，或问 CoilCoil 自己怎么用时，先用 area=guide 看对应教程，再动手；不要上来就 bash 改配置文件。",
      "自带文档（架构、需求、路线图）用 area=guide + op=read_doc 按名读，不要整目录扫。",
      "mcp op=connect 报 needs-auth 不是失败，是去走 auth_start → 拿链接给用户点 → auth_await_each → auth_finish 那四步；Agent 永远不要自己 curl 授权地址。",
      "敏感值读出来是 ••••••（掩码，不是值）：原样传回去就是不改，真要换再填新值；永远不要把 token 明文写进配置文件，能用 bearerTokenEnv 就用它。",
    ],
    parameters: CoilcoilParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const value = params as CoilcoilParamsValue;
      if (value.area === "guide") return executeGuide(value);
      if (value.area === "mcp") return executeMcp(pi, value, ctx);
      return executeSkill(pi, value, ctx);
    },
  });
}
