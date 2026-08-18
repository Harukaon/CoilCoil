import {
  type McpImportConfiguration,
} from "@suocode/runtime-protocol";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import {
  join,
} from "node:path";
import { resolvePackageDirectory } from "./package-resolution.js";
import {
  MCP_AGENT_CONFIG_REGISTRY,
  require
} from "./runtime-constants.js";
import {
  isRecord
} from "./runtime-utils.js";

export interface McpAdapterEffectiveConfig {
  imports?: McpImportConfiguration["kind"][];
  mcpServers: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

export interface McpAdapterConfigModule {
  ensureCompatibilityImports(imports: McpImportConfiguration["kind"][], overridePath?: string): { path: string; added: McpImportConfiguration["kind"][]; };
  getMcpDiscoverySummary(overridePath?: string, cwd?: string): {
    imports: Array<{ kind: McpImportConfiguration["kind"]; path: string; serverCount: number; }>;
  };
  getPiGlobalConfigPath(overridePath?: string): string;
  getProjectPiConfigPath(cwd?: string): string;
  getServerProvenance(overridePath?: string, cwd?: string): Map<string, { path: string; kind: "user" | "project" | "import"; importKind?: string; }>;
  loadMcpConfig(overridePath?: string, cwd?: string): McpAdapterEffectiveConfig;
  writeSharedServerEntry(path: string, serverName: string, entry: Record<string, unknown>): string;
  writeProjectServerDisabledOverride(overridePath: string | undefined, cwd: string, serverName: string, disabled: boolean): { path: string; changed: boolean; };
}

export function mcpAgentConfigRegistry(): WeakMap<object, McpAdapterEffectiveConfig> {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const existing = globals[MCP_AGENT_CONFIG_REGISTRY];
  if (existing instanceof WeakMap) return existing as WeakMap<object, McpAdapterEffectiveConfig>;
  const registry = new WeakMap<object, McpAdapterEffectiveConfig>();
  globals[MCP_AGENT_CONFIG_REGISTRY] = registry;
  return registry;
}

export function mcpConfigurationForAgent(
  configuration: McpAdapterEffectiveConfig,
  hiddenNames: ReadonlySet<string>,
): McpAdapterEffectiveConfig {
  return {
    ...configuration,
    ...(configuration.imports ? { imports: [...configuration.imports] } : {}),
    ...(configuration.settings ? { settings: { ...configuration.settings } } : {}),
    mcpServers: Object.fromEntries(
      Object.entries(configuration.mcpServers)
        .filter(([name, definition]) => !hiddenNames.has(name) && definition.disabled !== true)
        .map(([name, definition]) => [name, { ...definition }]),
    ),
  };
}

export function withBundledBrowserMcp(
  configuration: McpAdapterEffectiveConfig,
  environment: NodeJS.ProcessEnv = process.env,
  browserScopeId?: string,
): McpAdapterEffectiveConfig {
  const scopedEndpoint = (value: string): string => {
    if (!browserScopeId) return value;
    try {
      const url = new URL(value);
      url.searchParams.set("scope", browserScopeId);
      return url.toString();
    } catch {
      return value;
    }
  };
  const parseServer = (): { command: string; args: string[]; env: Record<string, string>; } | undefined => {
    const command = environment.SUOCODE_BROWSER_MCP_COMMAND?.trim();
    const rawArgs = environment.SUOCODE_BROWSER_MCP_ARGS;
    if (!command || !rawArgs) return undefined;
    const parsedArgs = JSON.parse(rawArgs) as unknown;
    const args = Array.isArray(parsedArgs)
      ? parsedArgs.map((value, index) => typeof value === "string" && value === "--wsEndpoint"
        ? value
        : typeof value === "string" && index > 0 && parsedArgs[index - 1] === "--wsEndpoint"
          ? scopedEndpoint(value)
          : value)
      : parsedArgs;
    const env = environment.SUOCODE_BROWSER_MCP_ENV
      ? JSON.parse(environment.SUOCODE_BROWSER_MCP_ENV) as unknown
      : {};
    if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) return undefined;
    if (!env || typeof env !== "object" || Array.isArray(env) || !Object.values(env).every((value) => typeof value === "string")) return undefined;
    return { command, args, env: env as Record<string, string> };
  };

  try {
    const browser = parseServer();
    if (!browser) return configuration;
    return {
      ...configuration,
      mcpServers: {
        ...configuration.mcpServers,
        "suocode-browser": {
          ...browser,
          // Preload Chrome DevTools metadata for gateway search, while keeping
          // every browser schema off the model's default direct-tool surface.
          lifecycle: "eager",
          requestTimeoutMs: 300_000,
          directTools: false,
          description: "通过 Chrome DevTools MCP 按需控制和调试 SuoCode 右侧可见网页。",
          builtin: true,
        },
      },
    };
  } catch {
    return configuration;
  }
}

export let mcpAdapterConfigModule: Promise<McpAdapterConfigModule> | undefined;

export function loadMcpAdapterConfigModule(): Promise<McpAdapterConfigModule> {
  const { createJiti } = require("jiti") as typeof import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  mcpAdapterConfigModule ??= jiti.import(join(resolvePackageDirectory("pi-mcp-adapter"), "config.ts")) as Promise<McpAdapterConfigModule>;
  return mcpAdapterConfigModule;
}

export const MCP_IMPORT_KINDS = new Set<McpImportConfiguration["kind"]>([
  "cursor", "claude-code", "claude-desktop", "codex", "opencode", "windsurf", "vscode",
]);

export function mcpImportKind(value: string | undefined): McpImportConfiguration["kind"] | undefined {
  return value && MCP_IMPORT_KINDS.has(value as McpImportConfiguration["kind"])
    ? value as McpImportConfiguration["kind"]
    : undefined;
}

export function mcpServerDefinitions(path: string | undefined): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return new Set();
    const rawServers = isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed["mcp-servers"])
        ? parsed["mcp-servers"]
        : {};
    return new Set(Object.entries(rawServers).flatMap(([name, value]) => {
      if (!isRecord(value)) return [];
      return Object.keys(value).some((key) => key !== "disabled") ? [name] : [];
    }));
  } catch {
    return new Set();
  }
}
