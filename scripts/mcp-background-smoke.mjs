#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";
import { createJiti } from "jiti";

if (process.platform !== "darwin") throw new Error("This smoke test covers macOS background app behavior.");
const repository = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "coilcoil-mcp-background-"));
const data = join(root, "data");
const agent = join(data, "agent");
const registry = join(root, "registry");
await mkdir(agent, { recursive: true });
const canonicalData = await realpath(data);
const configPath = join(agent, "mcp.json");
// Override inherited definitions in this temporary data directory, so the test
// never starts the developer's real MCP servers or needs their credentials.
const adapter = await createJiti(import.meta.url).import(join(repository, "node_modules/pi-mcp-adapter/config.ts"));
const inherited = adapter.loadMcpConfig(configPath, root).mcpServers;
const definitions = Object.fromEntries(Object.keys(inherited).map((name) => [name, { disabled: true }]));
definitions["background-probe"] = {
  command: process.execPath,
  args: [join(repository, "scripts/fixtures/mcp-slow-server.mjs")],
  requestTimeoutMs: 15_000,
};
await writeFile(configPath, JSON.stringify({ mcpServers: definitions, settings: { hostConfigDiscovery: "off" } }));

const env = { ...process.env, COILCOIL_RUNTIME_DIR: registry, COILCOIL_DISABLE_UPDATE_CHECK: "1" };
const cli = async (...args) => {
  const result = await run(process.execPath, [join(repository, "apps/desktop/out/main/mcp-cli.js"), ...args], {
    cwd: tmpdir(), env, timeout: 25_000,
  });
  return JSON.parse(result.stdout);
};
async function waitForInstance(previousId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { instances } = await cli("instances");
    const found = instances.find((instance) => instance.instanceId !== previousId);
    if (found) {
      assert.equal(await realpath(found.dataDir), canonicalData);
      return found;
    }
    await delay(100);
  }
  throw new Error("The test runtime did not publish an MCP endpoint.");
}

let app;
try {
  const packagedExecutable = process.argv[2];
  app = await electron.launch({
    executablePath: packagedExecutable ? resolve(packagedExecutable) : require("electron"),
    args: [...packagedExecutable ? [] : [join(repository, "apps/desktop")], `--user-data-dir=${data}`],
    cwd: root, env, timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.coilcoil));
  const before = await waitForInstance();
  await cli("tools", "background-probe", "--cwd", root, "--instance", before.instanceId);
  const pending = cli("call", "background-probe", "sleep", "--args", '{"ms":1800}', "--cwd", root, "--instance", before.instanceId);
  // Keep a handler attached while closing the window, even on a regression.
  const completion = pending.then((result) => ({ result }), (error) => ({ error }));
  await delay(250);
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isOffscreen()) window.close();
    }
  });
  const countWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => !window.webContents.isOffscreen()).length);
  const closeDeadline = Date.now() + 10_000;
  while (await countWindows() && Date.now() < closeDeadline) await delay(50);
  assert.equal(await countWindows(), 0);
  const background = (await cli("instances")).instances.find((instance) => instance.instanceId === before.instanceId);
  assert.ok(background, "Closing the last window must preserve the same runtime endpoint.");
  const completed = await completion;
  if (completed.error) throw completed.error;
  assert.equal(completed.result.content[0].text, "MCP_SLOW_DONE", "An in-flight MCP call must finish after the window closes.");
  const afterClose = await cli("call", "background-probe", "sleep", "--args", '{"ms":1}', "--cwd", root, "--instance", before.instanceId);
  assert.equal(afterClose.content[0].text, "MCP_SLOW_DONE");
  console.log("PASS: closing the last window preserves discovery, an in-flight call, and subsequent calls.");

  const opened = app.waitForEvent("window");
  await app.evaluate(({ app }) => app.emit("activate"));
  const reopened = await opened;
  await reopened.waitForFunction(() => Boolean(window.coilcoil));
  const next = await waitForInstance(before.instanceId);
  const afterReopen = await cli("call", "background-probe", "sleep", "--args", '{"ms":1}', "--cwd", root, "--instance", next.instanceId);
  assert.equal(afterReopen.content[0].text, "MCP_SLOW_DONE");
  console.log("PASS: reopening the window binds its new browser and keeps MCP access usable.");
  await app.close();
  app = undefined;
  assert.deepEqual(await readdir(registry), []);
  console.log("PASS: explicitly quitting the app removes the MCP endpoint.");
} catch (error) {
  // Only event names: failure diagnostics must not print launch secrets.
  const { readDiagnosticEntries } = await import("./lib/diagnostic-logs.mjs");
  for (const name of ["main", "runtime"]) {
    console.error(name, readDiagnosticEntries(join(agent, "logs"), name, 10).map((entry) => `${entry.level}:${entry.event}`));
  }
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
