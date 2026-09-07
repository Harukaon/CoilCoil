import type { McpServerRuntimeStatus } from "@coilcoil/runtime-protocol";

/**
 * The inspector panel exposes exactly two concepts, deliberately ignoring
 * connection state: either the Agent can see this MCP Server's tools, or it
 * can never see them. "Hidden" is a durable opt-out, not a transient
 * disconnect — the Agent lazily connects on demand, so "not connected yet"
 * says nothing about whether the tools are on offer.
 */
export type McpVisibility = "visible" | "hidden";

/** Local, optimistic overrides keyed by server name. */
export type McpVisibilityOverrides = Record<string, McpVisibility>;

/**
 * A server reaches the Agent only when it is enabled at both layers: the
 * workspace configuration (`disabled`) and the live session (`sessionDisabled`).
 */
export function mcpVisibility(
  server: McpServerRuntimeStatus,
  overrides: McpVisibilityOverrides = {},
): McpVisibility {
  const override = overrides[server.name];
  if (override) return override;
  return server.disabled || server.sessionDisabled ? "hidden" : "visible";
}

export function mcpVisibilityLabel(visibility: McpVisibility, toolCount = 0): string {
  const base = visibility === "visible" ? "展示给 Agent" : "对 Agent 停用";
  return toolCount > 0 ? `${base} · ${toolCount} 工具` : base;
}

export function mcpVisibleCount(
  servers: McpServerRuntimeStatus[],
  overrides: McpVisibilityOverrides = {},
): number {
  return servers.filter((server) => mcpVisibility(server, overrides) === "visible").length;
}

export function mcpSectionBadge(
  servers: McpServerRuntimeStatus[] | undefined,
  overrides: McpVisibilityOverrides = {},
): string | undefined {
  if (!servers?.length) return undefined;
  return `${mcpVisibleCount(servers, overrides)}/${servers.length} 展示给 Agent`;
}

export type McpToggleStep =
  | { kind: "workspace"; name: string; enabled: boolean }
  | { kind: "session"; name: string; enabled: boolean };

/**
 * Turning a server on or off from the panel must survive an MCP extension that
 * is still booting — or absent entirely. The workspace step is plain file I/O
 * and always lands, so it goes first and is treated as authoritative; the
 * session step only syncs an already-running Pi session and is best-effort.
 *
 * Skipping a redundant workspace write matters: it is the step that triggers an
 * extension reload, which would otherwise drop live connections on every click.
 */
export function mcpTogglePlan(
  server: McpServerRuntimeStatus,
  next: McpVisibility,
): McpToggleStep[] {
  const enabled = next === "visible";
  const steps: McpToggleStep[] = [];
  if (server.disabled === enabled) steps.push({ kind: "workspace", name: server.name, enabled });
  steps.push({ kind: "session", name: server.name, enabled });
  return steps;
}

export function toggledVisibility(current: McpVisibility): McpVisibility {
  return current === "visible" ? "hidden" : "visible";
}

/**
 * What Settings says about one server, in one word.
 *
 * This used to collapse everything into 已启用 / 已停用, which answered a
 * question nobody was asking: the green dot meant "you have not switched this
 * off", never "this works". A server that had never connected, one whose token
 * had expired and one serving tools all looked identical. The runtime already
 * reports what actually happened, so that is what is shown — and 检查状态 is the
 * single action that goes and produces a fresh answer.
 *
 * `cached` folds into 已连接 on purpose: it means the tools are usable, which is
 * the only distinction worth a word here.
 */
export function mcpConnectionLabel(
  server: { disabled: boolean },
  status?: Pick<McpServerRuntimeStatus, "status">,
): string {
  if (server.disabled) return "已停用";
  switch (status?.status) {
    case "connected":
    case "cached":
      return "已连接";
    case "needs-auth":
      return "需要认证";
    case "failed":
      return "连接失败";
    default:
      return "未连接";
  }
}

export function mcpConnectionClass(
  server: { disabled: boolean },
  status?: Pick<McpServerRuntimeStatus, "status">,
): string {
  if (server.disabled) return "disabled";
  switch (status?.status) {
    case "connected":
    case "cached":
      return "connected";
    case "needs-auth":
      return "needs-auth";
    case "failed":
      return "failed";
    default:
      return "not-connected";
  }
}

const importOriginLabel: Record<string, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  opencode: "opencode",
  windsurf: "Windsurf",
  vscode: "VS Code",
};

export type McpOrigin = {
  source?: string;
  sourceKind?: "user" | "project" | "import";
  importKind?: string;
};

/**
 * An imported server's definition lives in another app's config file. CoilCoil
 * can mount it and layer local overrides on top, but editing the definition
 * here would silently fork it — so the origin is surfaced and the fields are
 * locked.
 */
export function isMountedMcpServer(server: Pick<McpOrigin, "sourceKind">): boolean {
  return server.sourceKind === "import";
}

/**
 * Name the app a mounted server came from. This reads `importKind` rather than
 * the path: for imports the adapter points `source` at CoilCoil's own config,
 * because that is where overrides are written, so the path says nothing about
 * where the definition actually lives.
 */
export function mcpOriginLabel(server: McpOrigin): string {
  if (server.sourceKind !== "import") return server.sourceKind === "project" ? "当前项目" : "本地";
  return (server.importKind && importOriginLabel[server.importKind]) || "外部导入";
}

export function mcpMountBadge(server: McpOrigin): string | undefined {
  return isMountedMcpServer(server) ? `挂载 · ${mcpOriginLabel(server)}` : undefined;
}
