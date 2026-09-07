import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerRuntimeStatus } from "@coilcoil/runtime-protocol";
import {
  isMountedMcpServer,
  mcpConnectionClass,
  mcpConnectionLabel,
  mcpMountBadge,
  mcpOriginLabel,
  mcpSectionBadge,
  mcpTogglePlan,
  mcpVisibility,
  mcpVisibilityLabel,
  mcpVisibleCount,
  toggledVisibility,
} from "../src/renderer/src/features/runtime/mcpPolicy.ts";

function server(overrides: Partial<McpServerRuntimeStatus> = {}): McpServerRuntimeStatus {
  return {
    name: "github",
    status: "not connected",
    toolCount: 0,
    resourceCount: 0,
    failedAgo: null,
    disabled: false,
    sessionDisabled: false,
    ...overrides,
  };
}

test("a server the Agent can use reads as visible regardless of connection state", () => {
  for (const status of ["not connected", "cached", "connected", "failed", "needs-auth"] as const) {
    assert.equal(mcpVisibility(server({ status })), "visible", `status ${status} should not hide the server`);
  }
});

test("either layer opting out hides the server from the Agent", () => {
  assert.equal(mcpVisibility(server({ disabled: true })), "hidden");
  assert.equal(mcpVisibility(server({ sessionDisabled: true })), "hidden");
  assert.equal(mcpVisibility(server({ disabled: true, sessionDisabled: true })), "hidden");
});

test("an optimistic override wins until the runtime catches up", () => {
  const disabled = server({ name: "github", disabled: true });
  assert.equal(mcpVisibility(disabled), "hidden");
  assert.equal(mcpVisibility(disabled, { github: "visible" }), "visible");
});

test("labels describe Agent visibility, never connection state", () => {
  assert.equal(mcpVisibilityLabel("visible"), "展示给 Agent");
  assert.equal(mcpVisibilityLabel("hidden"), "对 Agent 停用");
  assert.equal(mcpVisibilityLabel("visible", 7), "展示给 Agent · 7 工具");
  assert.equal(mcpVisibilityLabel("hidden", 0), "对 Agent 停用");
});

test("turning on a workspace-disabled server enables it at both layers", () => {
  assert.deepEqual(mcpTogglePlan(server({ disabled: true }), "visible"), [
    { kind: "workspace", name: "github", enabled: true },
    { kind: "session", name: "github", enabled: true },
  ]);
});

test("turning a server off makes the opt-out durable, not session-only", () => {
  assert.deepEqual(mcpTogglePlan(server(), "hidden"), [
    { kind: "workspace", name: "github", enabled: false },
    { kind: "session", name: "github", enabled: false },
  ]);
});

test("a redundant workspace write is skipped so live connections survive a click", () => {
  // Already enabled in the workspace and only hidden for this session: the
  // workspace step would reload the extension for no reason.
  assert.deepEqual(mcpTogglePlan(server({ sessionDisabled: true }), "visible"), [
    { kind: "session", name: "github", enabled: true },
  ]);
  assert.deepEqual(mcpTogglePlan(server({ disabled: true }), "hidden"), [
    { kind: "session", name: "github", enabled: false },
  ]);
});

test("every toggle plan ends up syncing the running session", () => {
  const cases: McpServerRuntimeStatus[] = [
    server(),
    server({ disabled: true }),
    server({ sessionDisabled: true }),
    server({ disabled: true, sessionDisabled: true }),
  ];
  for (const candidate of cases) {
    for (const next of ["visible", "hidden"] as const) {
      const plan = mcpTogglePlan(candidate, next);
      assert.equal(plan.at(-1)?.kind, "session");
      assert.ok(plan.every((step) => step.enabled === (next === "visible")));
    }
  }
});

test("toggling twice returns a server to where it started", () => {
  const current = mcpVisibility(server({ disabled: true }));
  assert.equal(toggledVisibility(current), "visible");
  assert.equal(toggledVisibility(toggledVisibility(current)), current);
});

test("the section badge counts what the Agent can actually see", () => {
  const servers = [
    server({ name: "a" }),
    server({ name: "b", disabled: true }),
    server({ name: "c", sessionDisabled: true }),
  ];
  assert.equal(mcpVisibleCount(servers), 1);
  assert.equal(mcpSectionBadge(servers), "1/3 展示给 Agent");
  assert.equal(mcpSectionBadge(servers, { b: "visible" }), "2/3 展示给 Agent");
});

test("no servers means no badge at all", () => {
  assert.equal(mcpSectionBadge(undefined), undefined);
  assert.equal(mcpSectionBadge([]), undefined);
});

test("each connection outcome gets its own word", () => {
  // The panel used to answer "已启用" to every one of these, so a server that had
  // never connected was indistinguishable from one serving tools.
  const cases: Array<[McpServerRuntimeStatus["status"], string, string]> = [
    ["connected", "已连接", "connected"],
    ["cached", "已连接", "connected"],
    ["needs-auth", "需要认证", "needs-auth"],
    ["failed", "连接失败", "failed"],
    ["not connected", "未连接", "not-connected"],
  ];
  for (const [status, label, className] of cases) {
    assert.equal(mcpConnectionLabel({ disabled: false }, { status }), label);
    assert.equal(mcpConnectionClass({ disabled: false }, { status }), className);
  }
});

test("a disabled server reads as disabled even if a connection lingers", () => {
  assert.equal(mcpConnectionLabel({ disabled: true }, { status: "connected" }), "已停用");
  assert.equal(mcpConnectionClass({ disabled: true }, { status: "connected" }), "disabled");
  // …and an opt-out is never overridden by something the user could act on.
  assert.equal(mcpConnectionLabel({ disabled: true }, { status: "needs-auth" }), "已停用");
});

test("a server with no runtime status yet reads as not connected", () => {
  // Nothing has been checked, so claiming a connection would be a guess.
  assert.equal(mcpConnectionLabel({ disabled: false }), "未连接");
  assert.equal(mcpConnectionClass({ disabled: false }), "not-connected");
});

test("both surfaces agree on whether the Agent can use a server", () => {
  const cases: McpServerRuntimeStatus[] = [
    server({ name: "on" }),
    server({ name: "off", disabled: true }),
    server({ name: "connected-on", status: "connected" }),
    server({ name: "auth", status: "needs-auth" }),
  ];
  for (const candidate of cases) {
    const settingsSaysEnabled = mcpConnectionLabel(candidate, candidate) !== "已停用";
    const panelSaysVisible = mcpVisibility({ ...candidate, sessionDisabled: false }) === "visible";
    assert.equal(settingsSaysEnabled, panelSaysVisible, `${candidate.name} disagrees across surfaces`);
  }
});

test("only imported servers count as mounted", () => {
  assert.equal(isMountedMcpServer({ sourceKind: "import" }), true);
  assert.equal(isMountedMcpServer({ sourceKind: "user" }), false);
  assert.equal(isMountedMcpServer({ sourceKind: "project" }), false);
  assert.equal(isMountedMcpServer({}), false);
});

test("a mounted server names the app its definition really lives in", () => {
  const cases: Array<[string, string]> = [
    ["codex", "Codex"],
    ["claude-desktop", "Claude Desktop"],
    ["claude-code", "Claude Code"],
    ["opencode", "opencode"],
    ["cursor", "Cursor"],
  ];
  for (const [importKind, expected] of cases) {
    assert.equal(mcpOriginLabel({ sourceKind: "import", importKind }), expected, importKind);
  }
});

test("the origin ignores `source`, which points at CoilCoil's own config for imports", () => {
  // pi-mcp-adapter sets `path` to the Pi-owned config for every import, because
  // that is where overrides get written. Reading it would label everything the
  // same — `importKind` is the only field that identifies the real origin.
  const coilcoilConfig = "/tmp/coilcoil-test/Application Support/@coilcoil/desktop/agent/mcp.json";
  assert.equal(
    mcpOriginLabel({ source: coilcoilConfig, sourceKind: "import", importKind: "codex" }),
    "Codex",
  );
});

test("an unrecognised import still reports that it is external", () => {
  assert.equal(mcpOriginLabel({ sourceKind: "import", importKind: "something-new" }), "外部导入");
  assert.equal(mcpOriginLabel({ sourceKind: "import" }), "外部导入");
});

test("locally defined servers are never labelled as imported", () => {
  assert.equal(mcpOriginLabel({ sourceKind: "user" }), "本地");
  assert.equal(mcpOriginLabel({ sourceKind: "project" }), "当前项目");
  assert.equal(mcpMountBadge({ sourceKind: "user" }), undefined);
  assert.equal(mcpMountBadge({ sourceKind: "project" }), undefined);
  // An importKind on a local server must not promote it to "mounted".
  assert.equal(mcpMountBadge({ sourceKind: "user", importKind: "codex" }), undefined);
});

test("the mount badge shows where an imported server came from", () => {
  assert.equal(mcpMountBadge({ sourceKind: "import", importKind: "codex" }), "挂载 · Codex");
});
