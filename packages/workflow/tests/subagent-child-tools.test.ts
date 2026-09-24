import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MCP_MANAGER_CHANNEL } from "../extensions/mcp-tools.ts";
import { COILCOIL_WINDOWS_SHELL_STANDARDS } from "../extensions/system/engineering-standards.ts";
import {
  type ChildSessionHandle,
  childPromptAdditions,
  childToolExtensions,
  childToolsForPlatform,
  createChildSession,
  DEFAULT_CHILD_TOOLS,
  type ParentEvents,
} from "../extensions/subagents/child.ts";
import { loadProfiles } from "../extensions/subagents/profiles.ts";

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

test("PowerShell is never granted to a child outside Windows", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.ok(!childToolsForPlatform(DEFAULT_CHILD_TOOLS, platform).includes("powershell"));
    assert.deepEqual(
      childToolsForPlatform(["read", "bash", "powershell"], platform),
      ["read", "bash"],
      "an explicit grant, e.g. from a run saved on Windows, must still be dropped",
    );
  }
});

test("on Windows a child with shell access gets PowerShell, a narrow one does not", () => {
  assert.ok(childToolsForPlatform(DEFAULT_CHILD_TOOLS, "win32").includes("powershell"));
  assert.deepEqual(childToolsForPlatform(["read", "grep", "ls"], "win32"), ["read", "grep", "ls"]);
  assert.deepEqual(childToolsForPlatform(["read", "powershell"], "win32"), ["read", "powershell"]);
  assert.deepEqual(childToolsForPlatform(["bash", "powershell"], "win32"), ["bash", "powershell"], "no duplicates");
});

test("builtin profiles follow the platform rule for PowerShell", () => {
  const builtinDir = join(import.meta.dirname, "..", "agents");
  const profiles = loadProfiles({ builtinDir, userDir: join(builtinDir, "none"), projectDir: join(builtinDir, "none") });
  for (const name of ["explore", "reviewer", "worker"]) {
    const tools = profiles.get(name)?.tools ?? [];
    assert.ok(childToolsForPlatform(tools, "win32").includes("powershell"), `${name} must get PowerShell on Windows`);
    assert.ok(!childToolsForPlatform(tools, "darwin").includes("powershell"), `${name} must not get PowerShell on macOS`);
  }
});

test("the Windows shell guidance goes to children that have PowerShell, before the profile prompt", () => {
  assert.deepEqual(
    childPromptAdditions(["bash", "powershell"], " 你是侦察子 Agent。 ", "win32"),
    [COILCOIL_WINDOWS_SHELL_STANDARDS, "你是侦察子 Agent。"],
  );
  assert.deepEqual(childPromptAdditions(["bash"], "profile", "darwin"), ["profile"]);
  assert.deepEqual(childPromptAdditions(["read"], undefined, "win32"), []);
});

test("a child session on this platform gets PowerShell exactly when Windows would allow it", async (context) => {
  const { handle } = await openChild(context, { tools: ["read", "bash", "powershell"] });
  const active = handle.session.getActiveToolNames();
  if (process.platform === "win32") assert.ok(active.includes("powershell"));
  else assert.ok(!active.includes("powershell"), `powershell must not be active on ${process.platform}: ${active.join(",")}`);
});
