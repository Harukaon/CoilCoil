import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UNRESTRICTED_SYSTEM_PROMPT } from "./unrestricted-system-prompt.ts";

type AgentMessage = ContextEvent["messages"][number];
type AgentMode = "standard" | "unrestricted";

export const RUNTIME_BRIDGE_COMMAND_EVENT = "coilcoil:runtime-bridge:command:v1";
export const RUNTIME_BRIDGE_REPLY_PREFIX = "coilcoil:runtime-bridge:reply:v1:";
export const RUNTIME_BRIDGE_STATE_EVENT = "coilcoil:runtime-bridge:state:v1";
export const RUNTIME_BRIDGE_POLICY_ENTRY = "coilcoil-runtime-bridge-policy";

interface RuntimeBridgeCommand {
  version: 1;
  requestId: string;
  method: "get" | "set-agent-mode" | "set-system-prompt" | "set-skill-enabled";
  agentMode?: AgentMode;
  prompt?: string;
  filePath?: string;
  enabled?: boolean;
}

export interface RuntimeBridgeState {
  version: 1;
  agentMode: AgentMode;
  effectiveSystemPrompt?: string;
  systemPromptOverride?: string;
  disabledSkills: string[];
  readSkills: string[];
  contextMessages?: AgentMessage[];
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function filterDisabledSkillsFromPrompt(prompt: string, disabledSkills: ReadonlySet<string>): string {
  if (!disabledSkills.size || !prompt.includes("<available_skills>")) return prompt;
  return prompt.replace(/\n?\s*<skill>\s*[\s\S]*?<location>([\s\S]*?)<\/location>\s*<\/skill>/g, (block, rawLocation: string) => (
    disabledSkills.has(decodeXml(rawLocation.trim())) ? "" : block
  ));
}

function commandFrom(raw: unknown): RuntimeBridgeCommand {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.requestId !== "string" || !raw.requestId.trim()) {
    throw new Error("运行时桥接请求无效。");
  }
  if (raw.method !== "get" && raw.method !== "set-agent-mode" && raw.method !== "set-system-prompt" && raw.method !== "set-skill-enabled") {
    throw new Error("运行时桥接方法无效。");
  }
  return raw as unknown as RuntimeBridgeCommand;
}

function restorePolicy(entries: readonly unknown[]): {
  agentMode: AgentMode;
  systemPromptOverride?: string;
  disabledSkills: string[];
} {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== RUNTIME_BRIDGE_POLICY_ENTRY || !isRecord(entry.data)) continue;
    return {
      agentMode: entry.data.agentMode === "unrestricted" ? "unrestricted" : "standard",
      systemPromptOverride: typeof entry.data.systemPromptOverride === "string" && entry.data.systemPromptOverride.trim()
        ? entry.data.systemPromptOverride
        : undefined,
      disabledSkills: Array.isArray(entry.data.disabledSkills)
        ? entry.data.disabledSkills.filter((path): path is string => typeof path === "string" && Boolean(path.trim()))
        : [],
    };
  }
  return { agentMode: "standard", disabledSkills: [] };
}

export default function runtimeBridgeExtension(pi: ExtensionAPI): void {
  let effectiveSystemPrompt: string | undefined;
  let baseSystemPrompt: string | undefined;
  let sessionContext: { getSystemPrompt(): string } | undefined;
  let agentMode: AgentMode = "standard";
  let systemPromptOverride: string | undefined;
  let contextMessages: AgentMessage[] | undefined;
  const disabledSkills = new Set<string>();
  const readSkills = new Set<string>();

  /**
   * Re-read the prompt the session would actually start from.
   *
   * `session_start` fires before the session is finished being configured, and
   * the prompt keeps changing afterwards — the MCP adapter discovers its
   * servers asynchronously and activates their tools, which rebuilds it. A
   * value cached at session start therefore describes a session that no longer
   * exists, and the runtime inspector was reporting it as the effective prompt.
   *
   * During a turn Pi's own `systemPrompt` is already the per-turn one, so this
   * stays correct there too and does not fight `before_agent_start`.
   */
  const refreshBaseSystemPrompt = (): void => {
    const live = sessionContext?.getSystemPrompt();
    if (live) baseSystemPrompt = live;
  };

  const recomputeEffectiveSystemPrompt = (): void => {
    if (agentMode === "unrestricted") {
      effectiveSystemPrompt = UNRESTRICTED_SYSTEM_PROMPT;
      return;
    }
    const filteredBase = baseSystemPrompt === undefined
      ? undefined
      : filterDisabledSkillsFromPrompt(baseSystemPrompt, disabledSkills);
    effectiveSystemPrompt = systemPromptOverride ?? filteredBase;
  };

  const state = (): RuntimeBridgeState => ({
    version: 1,
    agentMode,
    effectiveSystemPrompt,
    systemPromptOverride,
    disabledSkills: [...disabledSkills],
    readSkills: [...readSkills],
    contextMessages,
    updatedAt: Date.now(),
  });
  const publish = (): void => pi.events.emit(RUNTIME_BRIDGE_STATE_EVENT, state());
  const persistPolicy = (): void => pi.appendEntry(RUNTIME_BRIDGE_POLICY_ENTRY, {
    version: 1,
    agentMode,
    systemPromptOverride,
    disabledSkills: [...disabledSkills].sort(),
  });

  const unsubscribe = pi.events.on(RUNTIME_BRIDGE_COMMAND_EVENT, (raw) => {
    let requestId = "unknown";
    try {
      const command = commandFrom(raw);
      requestId = command.requestId;
      if (command.method === "set-agent-mode") {
        if (command.agentMode !== "standard" && command.agentMode !== "unrestricted") {
          throw new Error("会话模式无效。");
        }
        agentMode = command.agentMode;
        if (agentMode === "unrestricted") systemPromptOverride = undefined;
      } else if (command.method === "set-system-prompt") {
        if (agentMode === "unrestricted") throw new Error("Unrestricted 模式下不能编辑 System Prompt。");
        const value = command.prompt?.trim();
        systemPromptOverride = value || undefined;
      } else if (command.method === "set-skill-enabled") {
        const filePath = command.filePath?.trim();
        if (!filePath) throw new Error("缺少 Skill 路径。");
        if (command.enabled === false) disabledSkills.add(filePath);
        else disabledSkills.delete(filePath);
      }
      refreshBaseSystemPrompt();
      recomputeEffectiveSystemPrompt();
      if (command.method !== "get") persistPolicy();
      publish();
      pi.events.emit(`${RUNTIME_BRIDGE_REPLY_PREFIX}${requestId}`, { ok: true, state: state() });
    } catch (error) {
      pi.events.emit(`${RUNTIME_BRIDGE_REPLY_PREFIX}${requestId}`, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("before_agent_start", async (event) => {
    baseSystemPrompt = event.systemPrompt;
    recomputeEffectiveSystemPrompt();
    publish();
    if (effectiveSystemPrompt !== event.systemPrompt) return { systemPrompt: effectiveSystemPrompt };
    return undefined;
  });

  pi.on("context", async (event) => {
    contextMessages = structuredClone(event.messages);
    publish();
    return undefined;
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "read") return undefined;
    const path = isRecord(event.input) && typeof event.input.path === "string" ? event.input.path : "";
    if (/SKILL\.md$/i.test(path)) {
      readSkills.add(path);
      publish();
    }
    return undefined;
  });

  pi.on("session_start", async (_event, context) => {
    const restored = restorePolicy(context.sessionManager.getBranch());
    agentMode = restored.agentMode;
    systemPromptOverride = restored.systemPromptOverride;
    disabledSkills.clear();
    for (const path of restored.disabledSkills) disabledSkills.add(path);
    sessionContext = context;
    refreshBaseSystemPrompt();
    recomputeEffectiveSystemPrompt();
    publish();
  });
  pi.on("session_tree", async (_event, context) => {
    const restored = restorePolicy(context.sessionManager.getBranch());
    agentMode = restored.agentMode;
    systemPromptOverride = restored.systemPromptOverride;
    disabledSkills.clear();
    for (const path of restored.disabledSkills) disabledSkills.add(path);
    sessionContext = context;
    refreshBaseSystemPrompt();
    recomputeEffectiveSystemPrompt();
    publish();
  });
  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    unsubscribe();
  });
}
