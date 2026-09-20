import {
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeInspectionSnapshot,
  RuntimeSkillState,
  RuntimeToolDefinition,
} from "@coilcoil/runtime-protocol";
import {
  resolve,
} from "node:path";
import {
  ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
  projectMemoryStatusByCwd,
} from "./runtime-constants.js";
import {
  buildRuntimeInspection,
} from "./runtime-inspection.js";
import {
  type ActiveSession,
  hydrateProjectMemoryStatus,
  memoryStatusForInspection,
} from "./runtime-state.js";
import {
  estimatedTextTokens,
  safeRealPath,
} from "./runtime-utils.js";
import {
  buildRuntimeTokenBreakdown,
  runtimeToolCategory,
  runtimeToolDefinitionTokens,
} from "./runtime-token-breakdown.js";
import {
  sessionCacheInspection,
  sessionUsage,
} from "./session-values.js";

export function buildRuntimeInspectionSnapshot(active: ActiveSession): RuntimeInspectionSnapshot {
  const base = buildRuntimeInspection(
    active.session.sessionManager,
    active.sessionRevision,
    active.summaryActivity,
  );
  const messages: readonly unknown[] = active.session.isStreaming && active.bridgeState?.contextMessages?.length
    ? active.bridgeState.contextMessages
    : active.session.messages;
  const estimatedMessages = messages.reduce<number>((total, message) => {
    try {
      return total + estimateTokens(message as Parameters<typeof estimateTokens>[0]);
    } catch {
      return total + estimatedTextTokens(message);
    }
  }, 0);
  const activeToolNames = new Set(active.session.getActiveToolNames());
  const mcpServerNames = active.mcpStatus?.servers.map((server) => server.name) ?? [];
  const tools: RuntimeToolDefinition[] = active.session.getAllTools().map((tool) => {
    const source = tool.sourceInfo.source || tool.sourceInfo.path || "unknown";
    const category = runtimeToolCategory(tool, mcpServerNames);
    return {
      name: tool.name,
      description: tool.description,
      source,
      active: activeToolNames.has(tool.name),
      category,
      estimatedTokens: runtimeToolDefinitionTokens(tool),
    };
  }).sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
  const disabledSkills = new Set(active.bridgeState?.disabledSkills ?? []);
  const readSkills = new Set((active.bridgeState?.readSkills ?? []).map((path) => resolve(path)));
  const skills: RuntimeSkillState[] = (active.skillConfiguration?.skills ?? []).map((skill) => {
    const resolvedPath = resolve(skill.filePath);
    const sessionEnabled = skill.enabled && !disabledSkills.has(skill.filePath) && !disabledSkills.has(resolvedPath);
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      source: skill.source,
      globallyEnabled: skill.enabled,
      sessionEnabled,
      publishedToModel: sessionEnabled && !skill.disableModelInvocation,
      readInSession: readSkills.has(resolvedPath),
      estimatedMetadataTokens: estimatedTextTokens({
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
      }),
    };
  });
  const effectiveSystemPrompt = active.bridgeState?.effectiveSystemPrompt || active.session.systemPrompt || undefined;
  const systemPromptTokens = effectiveSystemPrompt ? estimatedTextTokens(effectiveSystemPrompt) : undefined;
  const toolDefinitionTokens = tools.filter((tool) => tool.active).reduce((total, tool) => total + tool.estimatedTokens, 0);
  const tokenBreakdown = buildRuntimeTokenBreakdown(
    messages,
    systemPromptTokens ?? 0,
    tools,
    mcpServerNames,
  );
  const usage = sessionUsage(active.session);
  const { cacheHitRate, cache } = sessionCacheInspection(active.session, active.responseMetrics);
  const sharedMemoryStatus = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
  const memoryStatus = memoryStatusForInspection(active.memoryStatus, sharedMemoryStatus);
  return {
    ...base,
    effectiveSystemPrompt,
    systemPromptOverride: Boolean(active.bridgeState?.systemPromptOverride),
    estimates: {
      systemPrompt: systemPromptTokens,
      toolDefinitions: toolDefinitionTokens || undefined,
      messages: estimatedMessages || undefined,
      total: usage.contextUsage?.tokens ?? (((systemPromptTokens ?? 0) + toolDefinitionTokens + estimatedMessages) || undefined),
    },
    cacheHitRate,
    cache,
    tokenBreakdown,
    tools,
    skills,
    contextClearings: active.contextClearings?.length ? active.contextClearings : undefined,
    mcp: active.mcpStatus,
    memory: memoryStatus ? hydrateProjectMemoryStatus(memoryStatus) : undefined,
    capabilities: {
      editSystemPrompt: active.bridgeState?.agentMode !== "unrestricted",
      removeOriginalSessionItems: false,
      removeOriginalSessionItemsReason: ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
    },
  };
}
