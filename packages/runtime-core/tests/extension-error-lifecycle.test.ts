import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DiagnosticLog } from "@coilcoil/diagnostics";
import type { DiagnosticLogEntry, RuntimeEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import type { ActiveSession } from "../src/runtime-state.js";

test("real extension hook failures remain visible after reload and stay scoped after a session switch", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-extension-error-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), workflowDir = join(root, "workflow");
  for (const path of [cwd, agentDir, workflowDir]) mkdirSync(path);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const faultExtension = join(root, "throwing-extension.ts");
  writeFileSync(faultExtension, `export default (pi) => {
    pi.on("agent_settled", () => { throw new Error("injected terminal cleanup failure"); });
  };`);
  writeFileSync(join(workflowDir, "package.json"), JSON.stringify({ pi: { extensions: [
    ...["default-tools", "terminal", "mcp-tools", "runtime-bridge"].map((name) =>
      fileURLToPath(new URL(`../../workflow/extensions/${name}.ts`, import.meta.url))),
    faultExtension,
  ] } }));
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-test" } }));
  const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const events: RuntimeEvent[] = [];
  const log = new DiagnosticLog({ directory: join(root, "logs"), process: "runtime", echo: false });
  const runtime = new CoilCoilRuntime({ agentDir, sessionDir: join(root, "sessions"), workflowDir,
    checkpoints: false, modelRuntime, log, onEvent: (event) => events.push(event) });
  const internal = runtime as unknown as { active: ActiveSession; mcpManager(): unknown };
  t.mock.method(internal, "mcpManager", () => ({ directTools: async () => [], status: async () => ({ servers: [] }) }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("This lifecycle fixture must not call external services"); });
  t.after(async () => {
    await runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  const selection = { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "off" as const };
  const hookErrors = () => events.filter((event) => event.type === "runtime_error" && event.message.includes("injected terminal cleanup failure"));
  const diagnostics = () => readFileSync(log.filePath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as DiagnosticLogEntry).filter((entry) => entry.event === "handler_failed");

  await runtime.createSession(cwd, selection);
  const first = internal.active;
  // Execute the real Pi dispatcher that catches hook exceptions and calls the
  // listener installed by CoilCoil's actual bindExtensions path.
  await first.session.extensionRunner.emit({ type: "agent_settled", aborted: true });
  assert.equal(hookErrors().length, 1);
  assert.match((hookErrors()[0] as Extract<RuntimeEvent, { type: "runtime_error" }>).message, /agent_settled/);
  assert.equal(diagnostics().length, 1);

  await first.session.reload();
  const retiredRunner = first.session.extensionRunner;
  await retiredRunner.emit({ type: "agent_settled", aborted: true });
  assert.equal(hookErrors().length, 2, "reload must rebind the host error listener");
  const oldSessionPath = first.session.sessionFile;

  await runtime.createSession(cwd, selection);
  assert.notEqual(internal.active, first);
  const visibleBeforeRetiredHook = hookErrors().length;
  await retiredRunner.emit({ type: "agent_settled", aborted: true });
  assert.equal(hookErrors().length, visibleBeforeRetiredHook, "a late retired hook must not show an error in the new session");
  const entries = diagnostics();
  assert.equal(entries.length, 3, "retired hook failures must remain in diagnostics");
  assert.equal(entries.at(-1)?.sessionPath, oldSessionPath);
  assert.equal(entries.at(-1)?.data?.event, "agent_settled");
  assert.equal(entries.at(-1)?.data?.extensionPath, faultExtension);
});
