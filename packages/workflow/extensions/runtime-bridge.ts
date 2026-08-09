import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

export const RUNTIME_BRIDGE_COMMAND_EVENT = "suocode:runtime-bridge:command:v1";
export const RUNTIME_BRIDGE_REPLY_PREFIX = "suocode:runtime-bridge:reply:v1:";
export const RUNTIME_BRIDGE_STATE_EVENT = "suocode:runtime-bridge:state:v1";

interface RuntimeBridgeCommand {
  version: 1;
  requestId: string;
  method: "get" | "set-system-prompt" | "set-skill-enabled";
  prompt?: string;
  filePath?: string;
  enabled?: boolean;
}

export interface RuntimeBridgeState {
  version: 1;
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
  if (raw.method !== "get" && raw.method !== "set-system-prompt" && raw.method !== "set-skill-enabled") {
    throw new Error("运行时桥接方法无效。");
  }
  return raw as unknown as RuntimeBridgeCommand;
}

export default function runtimeBridgeExtension(pi: ExtensionAPI): void {
  let effectiveSystemPrompt: string | undefined;
  let systemPromptOverride: string | undefined;
  let contextMessages: AgentMessage[] | undefined;
  const disabledSkills = new Set<string>();
  const readSkills = new Set<string>();

  const state = (): RuntimeBridgeState => ({
    version: 1,
    effectiveSystemPrompt,
    systemPromptOverride,
    disabledSkills: [...disabledSkills],
    readSkills: [...readSkills],
    contextMessages,
    updatedAt: Date.now(),
  });
  const publish = (): void => pi.events.emit(RUNTIME_BRIDGE_STATE_EVENT, state());

  const unsubscribe = pi.events.on(RUNTIME_BRIDGE_COMMAND_EVENT, (raw) => {
    let requestId = "unknown";
    try {
      const command = commandFrom(raw);
      requestId = command.requestId;
      if (command.method === "set-system-prompt") {
        const value = command.prompt?.trim();
        systemPromptOverride = value || undefined;
      } else if (command.method === "set-skill-enabled") {
        const filePath = command.filePath?.trim();
        if (!filePath) throw new Error("缺少 Skill 路径。");
        if (command.enabled === false) disabledSkills.add(filePath);
        else disabledSkills.delete(filePath);
      }
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
    const filtered = filterDisabledSkillsFromPrompt(event.systemPrompt, disabledSkills);
    effectiveSystemPrompt = systemPromptOverride ?? filtered;
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

  pi.on("session_start", async () => publish());
  pi.on("session_shutdown", async () => unsubscribe());
}
