import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SubagentChildMeta } from "./types.ts";
import { SUBAGENT_META_ENTRY_TYPE } from "./types.ts";

export const DEFAULT_CHILD_TOOLS = ["read", "bash", "edit", "write", "grep", "ls"];
export const CHILD_SESSION_SUBDIR = "subagents";

export interface CreateChildSessionOptions {
  cwd: string;
  agentDir: string;
  parentSessionDir: string;
  parentSessionId: string;
  model?: Model<never>;
  tools?: string[];
  systemPrompt?: string;
  meta?: SubagentChildMeta;
  onEvent: (event: AgentSessionEvent) => void;
}

export interface ChildSessionHandle {
  session: AgentSession;
  sessionFile?: string;
  dispose: () => Promise<void>;
}

async function buildChildSession(options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  model?: Model<never>;
  tools?: string[];
  systemPrompt?: string;
}): Promise<{ session: AgentSession }> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
  const profilePrompt = options.systemPrompt?.trim();
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    extensionFactories: profilePrompt
      ? [{
          name: "suocode-subagent-prompt",
          hidden: true,
          factory: (pi) => {
            pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${profilePrompt}` }));
          },
        }]
      : [],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    sessionManager: options.sessionManager,
    resourceLoader: loader,
    model: options.model,
    tools: options.tools ?? DEFAULT_CHILD_TOOLS,
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
  });
  return wrapHandle(created.session, options.onEvent);
}

export interface ReopenChildSessionOptions {
  sessionFile: string;
  cwd: string;
  agentDir: string;
  tools?: string[];
  systemPrompt?: string;
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
