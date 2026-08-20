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
 * Settings and the inspector must not describe the same server differently.
 * Both reduce to enabled/disabled: a configured server is on offer to the Agent
 * unless the user turned it off. Lifecycle (`lazy` / `keep-alive` / `eager`)
 * decides when it connects and is not a third state — so transient connection
 * results never appear here. `needs-auth` is the one exception, because it is
 * the only one the user can act on.
 */
export function mcpEnablementLabel(
  server: { disabled: boolean },
  status?: Pick<McpServerRuntimeStatus, "status">,
): string {
  if (server.disabled) return "已停用";
  return status?.status === "needs-auth" ? "需要认证" : "已启用";
}

export function mcpEnablementClass(
  server: { disabled: boolean },
  status?: Pick<McpServerRuntimeStatus, "status">,
): string {
  if (server.disabled) return "disabled";
  return status?.status === "needs-auth" ? "needs-auth" : "connected";
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
