import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MCP_MANAGER_CHANNEL } from "../extensions/mcp-tools.ts";
import {
  type ChildSessionHandle,
  childToolExtensions,
  createChildSession,
  DEFAULT_CHILD_TOOLS,
  type ParentEvents,
} from "../extensions/subagents/child.ts";

function childWorkspace(context: test.TestContext): { cwd: string; agentDir: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-child-tools-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { cwd: root, agentDir: join(root, "agent"), sessionDir: join(root, "sessions") };
}

async function openChild(
  context: test.TestContext,
  options: { tools?: string[]; parentEvents?: ParentEvents } = {},
): Promise<{ handle: ChildSessionHandle; cwd: string }> {
  const workspace = childWorkspace(context);
  const handle = await createChildSession({
    cwd: workspace.cwd,
    agentDir: workspace.agentDir,
    parentSessionDir: workspace.sessionDir,
    parentSessionId: "parent-a",
    tools: options.tools,
    parentEvents: options.parentEvents,
    onEvent: () => undefined,
  });
  context.after(() => handle.dispose());
  return { handle, cwd: workspace.cwd };
}

async function execute(handle: ChildSessionHandle, name: string, params: Record<string, unknown>, cwd: string) {
  const tool = handle.session.getToolDefinition(name);
  assert.ok(tool, `${name} must be registered in the child session`);
  return tool.execute(`call-${name}`, params as never, undefined, undefined, { cwd } as never) as Promise<{
    content: Array<{ type: string; text?: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

function processAlive(pid: number): boolean {
  try {
    return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

test("default child tools include MCP", () => {
  assert.ok(DEFAULT_CHILD_TOOLS.includes("mcp"));
  assert.ok(DEFAULT_CHILD_TOOLS.includes("terminal"));
});

test("child tool extensions load once per extension and only for granted tools", () => {
  assert.deepEqual(childToolExtensions(["read", "grep"]), []);
  const names = childToolExtensions(["bash", "terminal", "mcp"]).map((extension) =>
    typeof extension === "function" ? "<anonymous>" : extension.name);
  assert.deepEqual(names, ["coilcoil-subagent-terminal", "coilcoil-subagent-mcp"]);
});

test("a child session actually gets the extension-provided tools it is granted", async (context) => {
  const { handle } = await openChild(context);
  const active = handle.session.getActiveToolNames();
  for (const tool of DEFAULT_CHILD_TOOLS) {
    assert.ok(active.includes(tool), `child must have ${tool}, got ${active.join(",")}`);
  }
  // terminal 扩展会换掉内置 bash；子 Agent 的 bash 要和主会话一样带后台接管。
  assert.match(handle.session.getToolDefinition("bash")?.description ?? "", /background/);
  assert.ok(!active.includes("subagent"), "children must never dispatch further children");
});

test("a child session without the grant gets no MCP tool", async (context) => {
  const { handle } = await openChild(context, { tools: ["read", "grep", "ls"] });
  assert.deepEqual(handle.session.getActiveToolNames().sort(), ["grep", "ls", "read"]);
});

test("the child's MCP tool reaches the parent runtime's MCP client", async (context) => {
  const manager = {
    listServers: async () => [{ server: "github", status: "connected", tools: [{ name: "search" }] }],
    directTools: async () => [],
  };
  const requests: unknown[] = [];
  const parentEvents: ParentEvents = {
    emit(channel, data) {
      if (channel !== MCP_MANAGER_CHANNEL) return;
      requests.push(data);
      (data as { manager?: unknown }).manager = manager;
    },
  };
  const { handle, cwd } = await openChild(context, { parentEvents });
  const result = await execute(handle, "mcp", { action: "list" }, cwd);
  assert.notEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /github（已连接，1 个工具）/);
  assert.ok(requests.length > 0, "the request must be forwarded to the parent bus");
});

test("without a parent bus the child's MCP tool reports the client as unavailable", async (context) => {
  const { handle, cwd } = await openChild(context);
  const result = await execute(handle, "mcp", { action: "list" }, cwd);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /MCP 客户端当前不可用/);
});

test("disposing a child stops the terminals it left running", { skip: process.platform === "win32" }, async (context) => {
  const { handle, cwd } = await openChild(context, { tools: ["bash", "terminal"] });
  const started = await execute(handle, "terminal", { action: "start", command: "sleep 30" }, cwd);
  const pid = started.details.pid as number;
  assert.equal(typeof pid, "number");
  assert.ok(processAlive(pid), "the background terminal must be running before dispose");

  await handle.dispose();

  const deadline = Date.now() + 5_000;
  while (processAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!processAlive(pid), "dispose must stop the child's background terminals");
});
