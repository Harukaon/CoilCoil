import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionFactory,
  type InlineExtension,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import fileDiffExtension from "../file-diff.ts";
import readCacheExtension from "../read-cache.ts";
import runtimeBridgeExtension from "../runtime-bridge.ts";
import { AnthropicCacheController } from "../cache/controller.ts";
import { CACHE_LEDGER_ENTRY, cacheLedgerCheckpoint, restoreCacheLedger } from "../cache/ledger.ts";
import coilcoilMcpTools, { MCP_MANAGER_CHANNEL } from "../mcp-tools.ts";
import { COILCOIL_BACKGROUND_WAIT_STANDARDS, COILCOIL_SUBAGENT_GIT_SAFETY, COILCOIL_WINDOWS_SHELL_STANDARDS } from "../system/engineering-standards.ts";
import terminalExtension from "../terminal/extension.ts";
import { DEFAULT_CHILD_TOOLS } from "./profiles.ts";
import { createChildRunDriver, type ChildRunDriver } from "./child-run.ts";
import type { SubagentChildMeta } from "./types.ts";
import { SUBAGENT_META_ENTRY_TYPE } from "./types.ts";

// The table lives in profiles.ts, which the runtime can load without pulling in Pi.
export { DEFAULT_CHILD_TOOLS };
export const CHILD_SESSION_SUBDIR = "subagents";

const POWERSHELL_TOOL = "powershell";

/**
 * 按平台调整子会话的工具，规则和主会话一致（见 default-tools.ts）。
 *
 * Windows 上 shell 工作优先交给 powershell，所以被授予 bash 的子 Agent 同时拿到
 * powershell；没给 shell 权限的 profile 不会因此放宽。其他平台上 pi 的 powershell
 * 每次调用都会报「只在 Windows 上可用」，放进工具清单只会让模型白白试错，所以无论
 * profile 怎么写、恢复的是哪个平台上保存的运行，一律去掉。
 */
export function childToolsForPlatform(
  tools: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return tools.filter((tool) => tool !== POWERSHELL_TOOL);
  if (tools.includes("bash") && !tools.includes(POWERSHELL_TOOL)) return [...tools, POWERSHELL_TOOL];
  return [...tools];
}

/** 能改文件的工具：有其中任何一个的子 Agent 会拿到 Git 安全规则。 */
const FILE_CHANGING_TOOLS = ["edit", "write"];

/**
 * 追加到子会话系统提示词末尾的内容。
 *
 * 子会话不加载 default-tools，拿不到主会话那份工程规范，要靠这里补：
 * - 被授予 powershell 的（只会在 Windows 上）：Windows shell 规范。给了 powershell 却不说
 *   优先用它，模型照样会去用 bash、跟 POSIX 引号较劲。
 * - 能改文件的（有 edit 或 write）：Git 安全。整份规范不能原样给——它教模型向用户提问，
 *   而子 Agent 没法直接问用户——所以只给 Git 安全，措辞改成「在报告里说明」。
 * profile 的提示词放最后。
 */
export function childPromptAdditions(
  tools: readonly string[],
  profilePrompt: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const additions: string[] = [];
  if (platform === "win32" && tools.includes(POWERSHELL_TOOL)) additions.push(COILCOIL_WINDOWS_SHELL_STANDARDS);
  if (tools.includes("monitor")) additions.push(COILCOIL_BACKGROUND_WAIT_STANDARDS);
  if (FILE_CHANGING_TOOLS.some((tool) => tools.includes(tool))) {
    additions.push(`<git_safety>\n${COILCOIL_SUBAGENT_GIT_SAFETY}\n</git_safety>`);
  }
  const trimmed = profilePrompt?.trim();
  if (trimmed) additions.push(trimmed);
  return additions;
}

/**
 * 父会话的事件总线里，子会话需要的那一小部分。
 *
 * 就是扩展里拿到的 `pi.events`。只用来转发 MCP 客户端的请求，不把整条总线交给
 * 子会话：父会话总线上还跑着子 Agent 活动、runtime bridge 这些频道，子会话的
 * 扩展往上面发东西，界面就会把它当成主会话的事。
 */
export interface ParentEvents {
  emit(channel: string, data: unknown): void;
}

/**
 * 子会话里那些不是 pi 内置、而是由 CoilCoil 扩展提供的工具。
 *
 * 子会话用 `noExtensions` 建，不读用户的扩展列表，所以这些工具要显式带上，否则
 * 工具清单里写着 `terminal`、`mcp`，模型实际却拿不到。`bash` 也在这里：terminal
 * 扩展会用带后台接管的版本替换内置 bash，和主会话保持一致，内置 profile 的提示词
 * 也是按这个行为写的。
 */
const CHILD_TOOL_EXTENSIONS: Record<string, { name: string; factory: ExtensionFactory }> = {
  read: { name: "coilcoil-subagent-read-cache", factory: readCacheExtension },
  bash: { name: "coilcoil-subagent-terminal", factory: terminalExtension },
  terminal: { name: "coilcoil-subagent-terminal", factory: terminalExtension },
  monitor: { name: "coilcoil-subagent-terminal", factory: terminalExtension },
  mcp: { name: "coilcoil-subagent-mcp", factory: coilcoilMcpTools },
  // edit / write 返回真实 diff，子 Agent 和主会话一样。
  edit: { name: "coilcoil-subagent-file-diff", factory: fileDiffExtension },
  write: { name: "coilcoil-subagent-file-diff", factory: fileDiffExtension },
};

/** 按子会话被授予的工具，挑出要加载的扩展；同一个扩展只加载一次。 */
export function childToolExtensions(tools: readonly string[]): InlineExtension[] {
  const selected = new Map<string, InlineExtension>();
  for (const tool of tools) {
    const extension = CHILD_TOOL_EXTENSIONS[tool];
    if (extension && !selected.has(extension.name)) {
      selected.set(extension.name, { name: extension.name, hidden: true, factory: extension.factory });
    }
  }
  return [...selected.values()];
}

export interface CreateChildSessionOptions {
  cwd: string;
  agentDir: string;
  parentSessionDir: string;
  parentSessionId: string;
  model?: Model<never>;
  tools?: string[];
  systemPrompt?: string;
  meta?: SubagentChildMeta;
  parentEvents?: ParentEvents;
  onEvent: (event: AgentSessionEvent) => void;
}

export interface ChildSessionHandle {
  session: AgentSession;
  sessionFile?: string;
  prompt(task: string, signal?: AbortSignal): Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * 子会话自己的事件总线，只把 MCP 客户端的请求转给父会话。
 *
 * 运行时在父会话总线上应答这个请求，交出设置面板用的同一个 MCP 客户端。子 Agent
 * 用同一个客户端，连接和凭据才是共享的；另起一个就会再弹一遍认证。总线的 emit 是
 * 同步的，父会话那边填好的 `manager` 在转发返回时就已经在请求对象上了。
 */
function createChildEventBus(parentEvents?: ParentEvents) {
  const bus = createEventBus();
  if (parentEvents) {
    bus.on(MCP_MANAGER_CHANNEL, (data) => {
      parentEvents.emit(MCP_MANAGER_CHANNEL, data);
      const request = data as { manager?: unknown };
      if (request.manager && typeof request.manager === "object") {
        request.manager = withoutBrowserServer(request.manager as ChildMcpManager);
      }
    });
  }
  return bus;
}

/** 内置浏览器在 MCP 里的名字，由 runtime-core 的 withBundledBrowserMcp 注册。 */
export const BROWSER_MCP_SERVER = "coilcoil-browser";

type ChildMcpManager = {
  listServers(): Promise<Array<{ server: string }>>;
  directTools(): Promise<Array<{ server: string }>>;
  serverTools(server: string, ...rest: unknown[]): Promise<unknown>;
  callTool(server: string, ...rest: unknown[]): Promise<unknown>;
};

function browserRefused(): Error {
  return new Error("子 Agent 不能使用内置浏览器。需要看网页、点页面的工作请交回主 Agent 来做。");
}

/**
 * 子 Agent 看到的 MCP 客户端：同一个客户端，只是没有内置浏览器。
 *
 * 浏览器是用户和主 Agent 共用、正显示在右侧面板里的那一个。子 Agent 可以好几个同时
 * 跑，各自开页、切页、点击，标签页会被抢来抢去，用户看着的页面也会被它们翻走。所以
 * 不给：列表里不出现，按名字直接调也拒绝。
 */
export function withoutBrowserServer<T extends ChildMcpManager>(manager: T): T {
  return new Proxy(manager, {
    get(target, property, receiver) {
      if (property === "listServers") {
        return async () => (await target.listServers()).filter((entry) => entry.server !== BROWSER_MCP_SERVER);
      }
      if (property === "directTools") {
        return async () => (await target.directTools()).filter((entry) => entry.server !== BROWSER_MCP_SERVER);
      }
      if (property === "serverTools" || property === "callTool") {
        const original = target[property].bind(target) as (server: string, ...rest: unknown[]) => Promise<unknown>;
        return async (server: string, ...rest: unknown[]) => {
          if (server === BROWSER_MCP_SERVER) throw browserRefused();
          return original(server, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function buildChildSession(options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  model?: Model<never>;
  tools?: string[];
  systemPrompt?: string;
  parentEvents?: ParentEvents;
}): Promise<{ session: AgentSession; driver: ChildRunDriver }> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
  // 平台调整放在这里而不只在派发时做：新建和恢复都经过这一处，恢复的运行可能是在
  // 另一个平台上保存的。
  const tools = childToolsForPlatform(options.tools ?? DEFAULT_CHILD_TOOLS);
  const promptAdditions = childPromptAdditions(tools, options.systemPrompt);
  const extensionFactories: InlineExtension[] = childToolExtensions(tools);
  if (promptAdditions.length > 0) {
    const appended = promptAdditions.join("\n\n");
    extensionFactories.push({
      name: "coilcoil-subagent-prompt",
      hidden: true,
      factory: (pi) => {
        pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${appended}` }));
      },
    });
  }
  extensionFactories.push({ name: "coilcoil-subagent-prompt-snapshot", hidden: true, factory: runtimeBridgeExtension });
  const eventBus = createChildEventBus(options.parentEvents);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    eventBus,
    noExtensions: true,
    noThemes: true,
    extensionFactories,
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    sessionManager: options.sessionManager,
    resourceLoader: loader,
    model: options.model,
    tools,
    excludeTools: ["subagent"],
  });
  const cache = new AnthropicCacheController(restoreCacheLedger(created.session.sessionManager.getBranch()),
    (state) => { created.session.sessionManager.appendCustomEntry(CACHE_LEDGER_ENTRY, cacheLedgerCheckpoint(state)); });
  const stream = created.session.agent.streamFunction;
  created.session.agent.streamFunction = (selected, context, options) => {
    if (selected.api !== "anthropic-messages") return stream(selected, context, options);
    const purpose = options?.sessionId === created.session.sessionId ? "conversation" : "branch_summary";
    const prepared = cache.options(selected, options, purpose);
    return cache.observe(stream(selected, context, prepared.options), prepared.pending, purpose);
  };
  const driver = createChildRunDriver(created.session, eventBus);
  await created.session.bindExtensions({ onError: (error) => driver.onExtensionError(error) });
  return { session: created.session, driver };
}

function wrapHandle(session: AgentSession, driver: ChildRunDriver, onEvent: (event: AgentSessionEvent) => void): ChildSessionHandle {
  const unsubscribe = session.subscribe(onEvent);
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      driver.dispose();
      unsubscribe();
      const failures: unknown[] = [];
      try { await session.abort(); } catch (error) { failures.push(error); }
      // Disposing Pi alone does not emit shutdown; managed monitors must release their processes first.
      try {
        const runner = session.extensionRunner;
        if (runner.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
      } catch (error) { failures.push(error); }
      failures.push(...driver.shutdownErrors);
      try { session.dispose(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, `子 Agent 会话清理失败：${failures.map((error) => error instanceof Error ? error.message : String(error)).join("；")}`);
    })();
    return disposePromise;
  };
  return {
    session,
    sessionFile: session.sessionFile,
    prompt: async (task, signal) => {
      try { await driver.prompt(task, signal); }
      catch (error) {
        if (signal?.aborted) {
          try { await dispose(); }
          catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `${error instanceof Error ? error.message : String(error)}\n子 Agent 清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
        throw error;
      }
    },
    dispose,
  };
}

function assertParentSessionId(parentSessionId: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(parentSessionId)) {
    throw new Error(`父会话标识无效：${parentSessionId}`);
  }
}

export function childSessionDirectory(parentSessionDir: string, parentSessionId: string): string {
  assertParentSessionId(parentSessionId);
  return join(parentSessionDir, CHILD_SESSION_SUBDIR, parentSessionId);
}

export async function createChildSession(options: CreateChildSessionOptions): Promise<ChildSessionHandle> {
  const childSessionDir = childSessionDirectory(options.parentSessionDir, options.parentSessionId);
  const sessionManager = SessionManager.create(options.cwd, childSessionDir);
  if (options.meta) sessionManager.appendCustomEntry(SUBAGENT_META_ENTRY_TYPE, options.meta);
  const created = await buildChildSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager,
    model: options.model,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    parentEvents: options.parentEvents,
  });
  return wrapHandle(created.session, created.driver, options.onEvent);
}

export interface ReopenChildSessionOptions {
  sessionFile: string;
  cwd: string;
  agentDir: string;
  tools?: string[];
  systemPrompt?: string;
  parentEvents?: ParentEvents;
  onEvent: (event: AgentSessionEvent) => void;
}

export async function reopenChildSession(options: ReopenChildSessionOptions): Promise<ChildSessionHandle> {
  const sessionManager = SessionManager.open(options.sessionFile, dirname(options.sessionFile), options.cwd);
  const created = await buildChildSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    parentEvents: options.parentEvents,
  });
  return wrapHandle(created.session, created.driver, options.onEvent);
}

export interface ResumableChild {
  meta: SubagentChildMeta;
  sessionFile: string;
}

export interface ResumableChildScope {
  parentSessionId: string;
}

function isChildMeta(value: unknown): value is SubagentChildMeta {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.runId === "string"
    && typeof record.task === "string"
    && typeof record.parentSessionId === "string"
    && typeof record.background === "boolean"
    && typeof record.startedAt === "number"
    && (record.tools === undefined || (Array.isArray(record.tools) && record.tools.every((tool) => typeof tool === "string")))
    && (record.worktreePath === undefined || typeof record.worktreePath === "string");
}

export function readChildMeta(sessionFile: string): SubagentChildMeta | undefined {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n", 60)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; customType?: string; data?: unknown };
      if (entry.type === "custom" && entry.customType === SUBAGENT_META_ENTRY_TYPE && isChildMeta(entry.data)) {
        return entry.data;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function scanResumableChildren(childSessionDir: string, scope?: ResumableChildScope): ResumableChild[] {
  if (!existsSync(childSessionDir)) return [];
  const files = readdirSync(childSessionDir).filter((name) => name.endsWith(".jsonl")).sort();
  const children: ResumableChild[] = [];
  for (const name of files) {
    const sessionFile = join(childSessionDir, name);
    const meta = readChildMeta(sessionFile);
    if (meta && (!scope || meta.parentSessionId === scope.parentSessionId)) {
      children.push({ meta, sessionFile });
    }
  }
  return children;
}
