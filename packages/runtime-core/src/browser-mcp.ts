import {
  type McpImportConfiguration,
  type McpServerConfiguration,
} from "@coilcoil/runtime-protocol";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import {
  join,
} from "node:path";
import { resolvePackageDirectory } from "./package-resolution.js";
import {
  MCP_AGENT_CONFIG_CHANNEL,
  MCP_AGENT_CONFIG_REGISTRY,
  MCP_MANAGER_CHANNEL,
  require
} from "./runtime-constants.js";
import {
  isRecord
} from "./runtime-utils.js";

/**
 * 内置浏览器的 MCP 闲置多久就放手（分钟）。
 *
 * 它以前是 `eager`：每个会话运行时一开就连，而运行时最多留着 6 个空闲的，于是一台
 * 机器上常年挂着五六个 chrome-devtools-mcp 子进程，各占三十来兆，其中好几个的会话
 * 用户当天根本没再打开过。`eager` 对它也没换来什么——工具检索本来就会按需连接，
 * 直接工具面又始终不含浏览器 schema，预连接只是把代价提前付了。
 *
 * 改成按需连接之后还需要一个上限：连上的是本机 stdio 子进程，重连很快，所以放手
 * 得比一般服务器果断些。十五分钟大约是「刚才那一步做完，接着还要点下一步」和
 * 「这个会话今天不会再用浏览器了」之间的分界。
 */
export const BROWSER_IDLE_TIMEOUT_MINUTES = 15;

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

export interface McpAgentConfigRequest {
  configuration?: McpAdapterEffectiveConfig;
}

/**
 * Answer the adapter extension's request for CoilCoil's server list.
 *
 * Registered once per session against the same bus the extension will emit on.
 * The handler is synchronous on purpose: the extension reads the answer the
 * moment `emit` returns.
 */
export function serveMcpAgentConfig(
  bus: { on?(channel: string, handler: (data: unknown) => void): () => void },
  read: () => McpAdapterEffectiveConfig | undefined,
): () => void {
  // A host that offers no subscription simply never gets asked.
  if (typeof bus.on !== "function") return () => undefined;
  return bus.on(MCP_AGENT_CONFIG_CHANNEL, (data) => {
    if (!data || typeof data !== "object") return;
    (data as McpAgentConfigRequest).configuration = read();
  });
}

export interface McpManagerRequest {
  manager?: unknown;
}

/**
 * Hand the Agent's side the very same MCP client the settings panel uses.
 *
 * One client, two callers. Running a second one for the Agent is what made
 * pi-mcp-adapter's connections invisible to the panel — and would put the
 * keychain-style credential prompt back, since two clients means two sets of
 * stored credentials.
 */
export function serveMcpManager(
  bus: { on?(channel: string, handler: (data: unknown) => void): () => void },
  read: () => unknown,
): () => void {
  if (typeof bus.on !== "function") return () => undefined;
  return bus.on(MCP_MANAGER_CHANNEL, (data) => {
    if (!data || typeof data !== "object") return;
    (data as McpManagerRequest).manager = read();
  });
}

/**
 * Everything the MCP extension is allowed to ask the runtime for.
 *
 * Both answers are registered together because they are one contract: the
 * extension needs the server list and the client that connects to them, and a
 * bus that has one but not the other is a state nobody should have to reason
 * about.
 */
export function serveMcpToExtension(
  bus: { on?(channel: string, handler: (data: unknown) => void): () => void },
  read: { configuration: () => McpAdapterEffectiveConfig | undefined; manager: () => unknown },
): void {
  serveMcpAgentConfig(bus, read.configuration);
  serveMcpManager(bus, read.manager);
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

/**
 * Drop imported Chrome DevTools servers that drive a browser CoilCoil does not own.
 *
 * CoilCoil imports MCP servers from other tools' configs, and those configs
 * commonly carry a plain `chrome-devtools-mcp` entry with no endpoint, which
 * attaches to whatever Chrome is on the machine. Side by side with the bundled
 * server the Agent has two indistinguishable sets of browser tools, and picking
 * the imported one silently drives the user's real Chrome instead of the
 * built-in browser the panel shows. The bundled server is the one CoilCoil can
 * show, scope per session, and clean up, so it wins.
 *
 * An entry that names its own `--wsEndpoint` is left alone: it was pointed at a
 * specific browser on purpose.
 */
export function withoutRivalBrowserServers(
  servers: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(servers).filter(([, definition]) => {
    const args = Array.isArray(definition.args) ? definition.args.map(String) : [];
    const command = typeof definition.command === "string" ? definition.command : "";
    const usesDevtoolsMcp = /chrome-devtools-mcp/i.test([command, ...args].join(" "));
    if (!usesDevtoolsMcp) return true;
    return args.includes("--wsEndpoint") || args.includes("--browserUrl");
  }));
}

export function withBundledBrowserMcp(
  configuration: McpAdapterEffectiveConfig,
  environment: NodeJS.ProcessEnv = process.env,
  /** 作用域是**工作区**，不是会话：一个工作区一个浏览器，用户和 Agent 共用。 */
  workspaceScopeId?: string,
): McpAdapterEffectiveConfig {
  const scopedEndpoint = (value: string): string => {
    if (!workspaceScopeId) return value;
    try {
      const url = new URL(value);
      url.searchParams.set("scope", workspaceScopeId);
      return url.toString();
    } catch {
      return value;
    }
  };
  const parseServer = (): { command: string; args: string[]; env: Record<string, string>; } | undefined => {
    const command = environment.COILCOIL_BROWSER_MCP_COMMAND?.trim();
    const rawArgs = environment.COILCOIL_BROWSER_MCP_ARGS;
    if (!command || !rawArgs) return undefined;
    const parsedArgs = JSON.parse(rawArgs) as unknown;
    const args = Array.isArray(parsedArgs)
      ? parsedArgs.map((value, index) => typeof value === "string" && value === "--wsEndpoint"
        ? value
        : typeof value === "string" && index > 0 && parsedArgs[index - 1] === "--wsEndpoint"
          ? scopedEndpoint(value)
          : value)
      : parsedArgs;
    const env = environment.COILCOIL_BROWSER_MCP_ENV
      ? JSON.parse(environment.COILCOIL_BROWSER_MCP_ENV) as unknown
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
        ...withoutRivalBrowserServers(configuration.mcpServers),
        "coilcoil-browser": {
          ...browser,
          // Opened when the Agent first reaches for the browser and let go once
          // it stops — see BROWSER_IDLE_TIMEOUT_MINUTES. Every browser schema
          // stays off the model's default direct-tool surface either way.
          lifecycle: "lazy",
          idleTimeout: BROWSER_IDLE_TIMEOUT_MINUTES,
          requestTimeoutMs: 300_000,
          directTools: false,
          description: "通过 Chrome DevTools MCP 按需控制和调试 CoilCoil 右侧可见网页。",
          builtin: true,
        },
      },
    };
  } catch {
    return configuration;
  }
}

/**
 * The bundled browser server, in the shape the MCP client speaks.
 *
 * `withBundledBrowserMcp` above builds the same entry for the raw configuration
 * document. This is the same server expressed as an `McpServerConfiguration`,
 * because CoilCoil's own MCP client reads a typed server list rather than that
 * document — and when the client stopped going through the document, the
 * built-in browser quietly stopped being offered to the Agent at all.
 *
 * A browser server the user configured themselves is dropped for the same
 * reason it always was: two Chrome DevTools servers fighting over one browser
 * is worse than either alone. One pointed at a specific browser is left be.
 */
export function bundledBrowserServerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  workspaceScopeId?: string,
): McpServerConfiguration | undefined {
  const built = withBundledBrowserMcp({ mcpServers: {} }, environment, workspaceScopeId);
  const entry = built.mcpServers["coilcoil-browser"];
  if (!entry) return undefined;
  return {
    name: "coilcoil-browser",
    scope: "global",
    transport: "stdio",
    command: typeof entry.command === "string" ? entry.command : "",
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: entry.env && typeof entry.env === "object" ? entry.env as Record<string, string> : {},
    headers: {},
    lifecycle: "lazy",
    idleTimeout: BROWSER_IDLE_TIMEOUT_MINUTES,
    requestTimeoutMs: 300_000,
    exposeResources: false,
    directTools: false,
    excludeTools: [],
    debug: false,
    disabled: false,
    source: "builtin",
  } as McpServerConfiguration;
}

/** Drop a user-configured browser server that would fight with the bundled one. */
export function withoutRivalBrowserConfigurations(
  servers: readonly McpServerConfiguration[],
): McpServerConfiguration[] {
  return servers.filter((server) => {
    const args = server.args.map(String);
    const usesDevtoolsMcp = /chrome-devtools-mcp/i.test([server.command ?? "", ...args].join(" "));
    if (!usesDevtoolsMcp) return true;
    return args.includes("--wsEndpoint") || args.includes("--browserUrl");
  });
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
