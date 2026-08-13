import assert from "node:assert/strict";
import test from "node:test";
import {
  browserMcpPathViolation,
  decorateMcpStatusForSession,
  registeredMcpConfiguration,
  requestedMcpServer,
} from "../extensions/mcp-adapter.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("MCP adapter receives the Agent-only configuration registered for this session", () => {
  const symbol = Symbol.for("suocode-workflow.mcp-agent-config-registry");
  const globals = globalThis as Record<PropertyKey, unknown>;
  const previous = globals[symbol];
  const events = {};
  const configuration = { mcpServers: { enabled: { command: "server" } } };
  const registry = new WeakMap<object, typeof configuration>();
  registry.set(events, configuration);
  globals[symbol] = registry;
  try {
    assert.equal(registeredMcpConfiguration(events), configuration);
    assert.equal(registeredMcpConfiguration({}), undefined);
  } finally {
    if (previous === undefined) delete globals[symbol];
    else globals[symbol] = previous;
  }
});

test("session MCP policy resolves explicit and direct-tool server targets", () => {
  const tools = new Map<string, ReadonlySet<string>>([
    ["docs", new Set(["docs_search", "docs_read"])],
    ["browser", new Set(["browser_open"])],
  ]);

  assert.equal(requestedMcpServer({ server: "docs" }, tools), "docs");
  assert.equal(requestedMcpServer({ connect: "browser" }, tools), "browser");
  assert.equal(requestedMcpServer({ tool: "docs_search" }, tools), "docs");
  assert.equal(requestedMcpServer({ tool: "unknown" }, tools), undefined);
});

test("bundled browser file access stays inside the current workspace or temporary directory", () => {
  const cwd = join(tmpdir(), "suocode-workspace");
  assert.equal(browserMcpPathViolation(cwd, { filePath: join(cwd, "trace.heapsnapshot") }), undefined);
  assert.equal(browserMcpPathViolation(cwd, { outputDirPath: join(tmpdir(), "reports") }), undefined);
  if (process.platform !== "win32") assert.equal(browserMcpPathViolation(cwd, { filePath: "/tmp/browser.heapsnapshot" }), undefined);
  assert.match(browserMcpPathViolation(cwd, { filePath: "relative.heapsnapshot" }) ?? "", /必须是绝对路径/);
  assert.match(browserMcpPathViolation(cwd, { filePath: "/etc/passwd" }) ?? "", /只能访问当前工作区或临时目录/);
  assert.equal(browserMcpPathViolation(cwd, { url: "https://example.com/path" }), undefined);
});

test("session MCP status excludes only this session's disabled servers", () => {
  const decorated = decorateMcpStatusForSession({
    mode: "status",
    servers: [
      { name: "docs", status: "connected", toolCount: 5, resourceCount: 2, disabled: false },
      { name: "browser", status: "connected", toolCount: 3, resourceCount: 1, disabled: false },
      { name: "global-off", status: "disabled", toolCount: 0, resourceCount: 0, disabled: true },
    ],
    connectedCount: 2,
    totalTools: 8,
    totalResources: 3,
    disabledCount: 1,
  }, new Set(["browser"])) as any;

  assert.equal(decorated.sessionDisabledCount, 1);
  assert.equal(decorated.connectedCount, 1);
  assert.equal(decorated.totalTools, 5);
  assert.equal(decorated.totalResources, 2);
  assert.equal(decorated.servers.find((server: any) => server.name === "browser").sessionDisabled, true);
  assert.equal(decorated.servers.find((server: any) => server.name === "docs").sessionDisabled, false);
});
