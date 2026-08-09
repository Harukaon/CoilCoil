import assert from "node:assert/strict";
import test from "node:test";
import {
  decorateMcpStatusForSession,
  requestedMcpServer,
} from "../extensions/mcp-adapter.ts";

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
