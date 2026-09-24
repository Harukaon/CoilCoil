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
import coilcoilMcpTools, { MCP_MANAGER_CHANNEL } from "../mcp-tools.ts";
import terminalExtension from "../terminal/extension.ts";
import type { SubagentChildMeta } from "./types.ts";
import { SUBAGENT_META_ENTRY_TYPE } from "./types.ts";

export const DEFAULT_CHILD_TOOLS = ["read", "bash", "terminal", "edit", "write", "grep", "ls", "mcp"];
export const CHILD_SESSION_SUBDIR = "subagents";

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
  bash: { name: "coilcoil-subagent-terminal", factory: terminalExtension },
  terminal: { name: "coilcoil-subagent-terminal", factory: terminalExtension },
  mcp: { name: "coilcoil-subagent-mcp", factory: coilcoilMcpTools },
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
    });
  }
  return bus;
}

async function buildChildSession(options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  model?: Model<never>;
  tools?: string[];
  systemPrompt?: string;
  parentEvents?: ParentEvents;
}): Promise<{ session: AgentSession }> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
  const tools = options.tools ?? DEFAULT_CHILD_TOOLS;
  const profilePrompt = options.systemPrompt?.trim();
  const extensionFactories: InlineExtension[] = childToolExtensions(tools);
  if (profilePrompt) {
    extensionFactories.push({
      name: "coilcoil-subagent-prompt",
      hidden: true,
      factory: (pi) => {
        pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${profilePrompt}` }));
      },
    });
  }
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    eventBus: createChildEventBus(options.parentEvents),
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
  await created.session.bindExtensions({});
  return { session: created.session };
}

function wrapHandle(session: AgentSession, onEvent: (event: AgentSessionEvent) => void): ChildSessionHandle {
  const unsubscribe = session.subscribe(onEvent);
  let disposePromise: Promise<void> | undefined;
  return {
    session,
    sessionFile: session.sessionFile,
    dispose: () => {
      disposePromise ??= (async () => {
        unsubscribe();
        await session.abort().catch(() => undefined);
        // `session.dispose()` 不会通知扩展。terminal 扩展要靠 session_shutdown 才会
        // 停掉子 Agent 转入后台的进程，不先发这一下，子 Agent 结束后那些进程就没人管了。
        try {
          const runner = session.extensionRunner;
          if (runner.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
        } catch {
          // 扩展清理失败不能挡住会话释放。
        }
        session.dispose();
      })();
      return disposePromise;
    },
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
  return wrapHandle(created.session, options.onEvent);
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
  return wrapHandle(created.session, options.onEvent);
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
