import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { CoilCoilRuntime } from "../src/index.js";
import { mcpAgentConfigRegistry } from "../src/browser-mcp.js";

const BROWSER_ENV = {
  COILCOIL_BROWSER_MCP_COMMAND: "/private/node",
  COILCOIL_BROWSER_MCP_ARGS: JSON.stringify(["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
  COILCOIL_BROWSER_MCP_ENV: JSON.stringify({ ELECTRON_RUN_AS_NODE: "1" }),
};

interface ManagerInternals {
  listServers(): Promise<unknown>;
  definitions: Map<string, { args: string[] }>;
}

interface RuntimeInternals {
  active?: { cwd: string; session: { sessionId: string } };
  mcpManager(): ManagerInternals;
  refreshAgentMcpConfiguration(eventBus: object, cwd: string, browserScopeId: string): Promise<void>;
}

function scopeOf(args: readonly string[] | undefined): string | undefined {
  const endpoint = args?.[args.indexOf("--wsEndpoint") + 1];
  return endpoint ? new URL(endpoint).searchParams.get("scope") ?? undefined : undefined;
}

function withBrowserEnvironment(context: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-browser-scope-"));
  // The MCP client also reads the generic global MCP files in the home directory, whatever agentDir
  // the runtime is given, and creating the manager connects to every server it finds there. On a
  // machine with a hosted server that needs a login, that opens the process-wide OAuth callback
  // listener, which McpManager.close() leaves open for the other sessions: both cases pass in
  // milliseconds and the process then never exits. HOME and USERPROFILE are what os.homedir() reads
  // on POSIX and on Windows.
  const environment = { ...BROWSER_ENV, HOME: root, USERPROFILE: root };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("the Agent's browser is scoped to its session, and follows it when the session changes", async (context) => {
  const root = withBrowserEnvironment(context);
  const runtime = new CoilCoilRuntime({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") });
  const internals = runtime as unknown as RuntimeInternals;
  // 这里的 active 是伪造的，只有作用域要用到的字段；收尾前拿掉，dispose 才不会去碰它。
  context.after(async () => {
    internals.active = undefined;
    await runtime.dispose();
  });
  const cwd = join(root, "project");

  internals.active = { cwd, session: { sessionId: "session-a" } };
  const manager = internals.mcpManager();
  await manager.listServers();
  // The manager connects whatever it finds configured. Anything besides the injected browser would
  // be a server read from the developer's real home directory, and this test would be talking to it.
  assert.deepEqual([...manager.definitions.keys()], ["coilcoil-browser"],
    "only the built-in browser may be configured here; servers from the real home directory leaked in");
  assert.equal(scopeOf(manager.definitions.get("coilcoil-browser")?.args), "session-a",
    "one session, one set of tabs: the scope is the session id, not the workspace");

  // Same workspace, another conversation: its own tabs.
  internals.active = { cwd, session: { sessionId: "session-b" } };
  await manager.listServers();
  assert.equal(scopeOf(manager.definitions.get("coilcoil-browser")?.args), "session-b");
});

test("the Agent-facing MCP configuration carries the same session scope", async (context) => {
  const root = withBrowserEnvironment(context);
  const runtime = new CoilCoilRuntime({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") });
  context.after(() => runtime.dispose());
  const internals = runtime as unknown as RuntimeInternals;
  const eventBus = createEventBus();

  await internals.refreshAgentMcpConfiguration(eventBus, join(root, "project"), "session-a");
  const configuration = mcpAgentConfigRegistry().get(eventBus);
  const args = configuration?.mcpServers["coilcoil-browser"]?.args as string[] | undefined;
  assert.equal(scopeOf(args), "session-a");
});
