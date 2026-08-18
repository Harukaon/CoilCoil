import {
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeTokenBreakdown,
  RuntimeToolDefinition,
} from "@suocode/runtime-protocol";
import {
  estimatedTextTokens,
  isRecord,
  stringValue,
} from "./runtime-utils.js";

type RuntimeToolInfo = {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo?: {
    source?: string;
    path?: string;
  };
};

type RuntimeMessage = Record<string, unknown>;

function sanitizedServerName(name: string): string {
  return name.replace(/-/g, "_");
}

/** Return whether a tool name/source belongs to an MCP server. */
export function isMcpTool(
  name: string,
  sourceInfo?: { source?: string; path?: string },
  serverNames: readonly string[] = [],
): boolean {
  if (name === "mcp") return true;
  const source = `${sourceInfo?.source ?? ""} ${sourceInfo?.path ?? ""}`.toLowerCase();
  if (source.includes("mcp-adapter") || source.includes("/mcp.")) return true;

  return serverNames.some((serverName) => {
    const sanitized = sanitizedServerName(serverName);
    return [sanitized, `mcp__${sanitized}`].some((prefix) => name.startsWith(`${prefix}_`));
  });
}

export function runtimeToolCategory(
  tool: RuntimeToolInfo,
  serverNames: readonly string[] = [],
): "tool" | "mcp" {
  return isMcpTool(tool.name, tool.sourceInfo, serverNames) ? "mcp" : "tool";
}

export function runtimeToolDefinitionTokens(tool: RuntimeToolInfo): number {
  return estimatedTextTokens({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
}

function messageRole(message: RuntimeMessage): string {
  return stringValue(message.role);
}

function messageToolName(message: RuntimeMessage): string {
  return stringValue(message.toolName) || stringValue(message.name);
}

function messageTokens(message: RuntimeMessage): number {
  try {
    return Math.max(0, estimateTokens(message as never));
  } catch {
    return Math.max(0, estimatedTextTokens(message));
  }
}

function addMessageTokens(
  breakdown: RuntimeTokenBreakdown,
  raw: unknown,
  serverNames: readonly string[],
): void {
  if (!isRecord(raw)) return;
  const tokens = messageTokens(raw);
  if (tokens <= 0) return;

  const role = messageRole(raw);
  if (role === "user") {
    breakdown.userPrompt += tokens;
  } else if (role === "toolResult" || role === "tool") {
    if (isMcpTool(messageToolName(raw), undefined, serverNames)) breakdown.mcpResults += tokens;
    else breakdown.toolResults += tokens;
  } else {
    breakdown.history += tokens;
  }
}

/**
 * Count the content that is actually injected into the current prompt. Tool
 * definitions are the same name/description/schema shape Pi passes to the
 * provider; tool results are existing messages in the current context.
 */
export function buildRuntimeTokenBreakdown(
  messages: readonly unknown[],
  systemPromptTokens: number,
  tools: readonly RuntimeToolDefinition[],
  serverNames: readonly string[] = [],
): RuntimeTokenBreakdown {
  const breakdown: RuntimeTokenBreakdown = {
    userPrompt: 0,
    toolDefinitions: 0,
    mcpDefinitions: 0,
    toolResults: 0,
    mcpResults: 0,
    systemPrompt: Math.max(0, systemPromptTokens),
    history: 0,
    total: 0,
  };

  for (const message of messages) addMessageTokens(breakdown, message, serverNames);
  for (const tool of tools) {
    if (!tool.active) continue;
    if (tool.category === "mcp") breakdown.mcpDefinitions += Math.max(0, tool.estimatedTokens);
    else breakdown.toolDefinitions += Math.max(0, tool.estimatedTokens);
  }

  breakdown.total = breakdown.userPrompt
    + breakdown.toolDefinitions
    + breakdown.mcpDefinitions
    + breakdown.toolResults
    + breakdown.mcpResults
    + breakdown.systemPrompt
    + breakdown.history;
  return breakdown;
}
