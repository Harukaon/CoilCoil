import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const STATUS_KEY = "coilcoil-mcp-health";
const STANDARD_CONFIG = join(homedir(), ".config", "mcp", "mcp.json");

function piConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? configured === "~"
      ? homedir()
      : configured.startsWith("~/")
        ? join(homedir(), configured.slice(2))
        : resolve(configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "mcp.json");
}

type AuthState = "unknown" | "env-ready" | "verified" | "failed";

interface ServerHealth {
  name: string;
  configured: boolean;
  auth: AuthState;
  missingEnv: string[];
  failure?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readServers(path: string): Record<string, Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {};
    return Object.fromEntries(
      Object.entries(parsed.mcpServers).filter(([, value]) => isRecord(value)),
    ) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

function configuredServers(cwd: string): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const path of [
    STANDARD_CONFIG,
    piConfigPath(),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json"),
  ]) {
    for (const [name, definition] of Object.entries(readServers(path))) {
      merged[name] = { ...(merged[name] ?? {}), ...definition };
    }
  }
  return merged;
}

function collectEnvPlaceholders(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)/g)) {
      output.add(match[1] ?? match[2]);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvPlaceholders(item, output);
    return output;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectEnvPlaceholders(item, output);
  }
  return output;
}

function buildInitialHealth(
  servers: Record<string, Record<string, unknown>>,
  environment: NodeJS.ProcessEnv = process.env,
): Map<string, ServerHealth> {
  const health = new Map<string, ServerHealth>();
  for (const [name, definition] of Object.entries(servers)) {
    const placeholders = [...collectEnvPlaceholders(definition)];
    const missingEnv = placeholders.filter((key) => !environment[key]);
    const hasAuthShape =
      definition.headers !== undefined ||
      definition.bearerToken !== undefined ||
      definition.bearerTokenEnv !== undefined ||
      placeholders.length > 0;
    health.set(name, {
      name,
      configured: true,
      auth: missingEnv.length > 0
        ? "failed"
        : hasAuthShape
          ? "env-ready"
          : "unknown",
      missingEnv,
    });
  }
  return health;
}

function initialHealth(cwd: string): Map<string, ServerHealth> {
  return buildInitialHealth(configuredServers(cwd));
}

function setHealthStatus(ctx: ExtensionContext, health: Map<string, ServerHealth>): void {
  if (!ctx.hasUI) return;
  const missing = [...health.values()].filter((item) => item.missingEnv.length > 0);
  const failed = [...health.values()].filter((item) => item.auth === "failed" && item.missingEnv.length === 0);
  const verified = [...health.values()].filter((item) => item.auth === "verified");

  if (missing.length > 0) {
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("warning", `MCP 认证⚠ ${missing.map((item) => item.name).join(",")}`),
    );
  } else if (failed.length > 0) {
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("error", `MCP 失败✗ ${failed.map((item) => item.name).join(",")}`),
    );
  } else if (verified.length > 0) {
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("success", `MCP 已验证✓ ${verified.map((item) => item.name).join(",")}`),
    );
  } else {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function markToolResult(
  health: Map<string, ServerHealth>,
  toolName: string,
  content: unknown,
  isError: boolean,
): void {
  const text = `${toolName} ${JSON.stringify(content)}`;
  const target = [...health.values()].find((item) =>
    text.toLowerCase().includes(item.name.toLowerCase()),
  ) ?? (toolName.toLowerCase().includes("firecrawl") ? health.get("firecrawl") : undefined);
  if (!target) return;

  if (isError || /invalid_token|credentials required|unauthorized|401\b/i.test(text)) {
    target.auth = "failed";
    target.failure = /invalid_token|credentials required/i.test(text)
      ? "凭证无效或未继承"
      : "MCP 调用失败";
  } else {
    target.auth = "verified";
    target.failure = undefined;
  }
}

export default function mcpHealthExtension(pi: ExtensionAPI): void {
  let health = new Map<string, ServerHealth>();

  const refresh = (ctx: ExtensionContext, notify = false): void => {
    health = initialHealth(ctx.cwd);
    setHealthStatus(ctx, health);
    if (!ctx.hasUI || !notify) return;

    const missing = [...health.values()].filter((item) => item.missingEnv.length > 0);
    if (missing.length > 0) {
      ctx.ui.notify(
        `MCP 认证环境未就绪：${missing
          .map((item) => `${item.name}（缺少 ${item.missingEnv.join(", ")}）`)
          .join("；")}。重新加载扩展不会刷新环境变量，请完全重启 Pi。`,
        "warning",
      );
    }
  };

  pi.on("session_start", (_event, ctx) => refresh(ctx, true));
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "mcp" && !event.toolName.toLowerCase().includes("firecrawl")) return;
    markToolResult(health, event.toolName, event.content, event.isError);
    setHealthStatus(ctx, health);
  });

  pi.registerCommand("mcp-health", {
    description: "查看 MCP 配置和认证状态",
    handler: async (_args, ctx) => {
      refresh(ctx);
      if (!ctx.hasUI) return;
      const lines = [...health.values()].map((item) => {
        const status = item.missingEnv.length > 0
          ? `已配置 · 环境变量缺失：${item.missingEnv.join(",")}`
          : item.auth === "verified"
            ? "已配置 · 调用已验证"
            : item.auth === "failed"
              ? `已配置 · ${item.failure ?? "认证失败"}`
              : item.auth === "env-ready"
                ? "已配置 · 认证配置已就绪（尚未调用验证）"
                : "已配置 · 连接待验证";
        return `${item.name}: ${status}`;
      });
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "没有发现 MCP 配置", "info");
    },
  });
}

export {
  buildInitialHealth,
  collectEnvPlaceholders,
  initialHealth,
  markToolResult,
  piConfigPath,
};
