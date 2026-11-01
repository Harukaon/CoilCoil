import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RuntimeServer } from "../src/index.js";
import { startLocalMcpServer } from "../src/local-mcp-server.js";
import { discoverLocalMcpInstances, localMcpHttp, requestLocalMcp } from "../src/local-mcp-client.js";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(repository, "apps/cli/src/index.ts");
const fixture = join(repository, "scripts/fixtures/mcp-smoke-server.mjs");

test("local RPC authenticates, rejects browser origins and malformed requests, and removes discovery on close", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coilcoil-local-access-"));
  let calls = 0;
  const access = await startLocalMcpServer({ dataDir: directory, registryDirectory: directory, async handle() {
    calls += 1;
    return { content: [{ type: "text", text: "original" }], structuredContent: { untouched: true } };
  } });
  t.after(async () => { await access.close(); await rm(directory, { recursive: true, force: true }); });
  const descriptor = join(directory, `${access.instance.instanceId}.json`);
  if (process.platform !== "win32") assert.equal((await stat(descriptor)).mode & 0o777, 0o600);
  assert.equal((await discoverLocalMcpInstances(directory))[0]?.instanceId, access.instance.instanceId);
  const badToken = { ...access.instance, token: "bad" };
  await assert.rejects(localMcpHttp(badToken, "/mcp", { action: "contexts" }), /认证失败/);
  const browser = await fetch(`http://127.0.0.1:${access.instance.port}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${access.instance.token}`, Origin: "http://example.com" },
    body: JSON.stringify({ action: "contexts" }),
  });
  assert.equal(browser.status, 403);
  await assert.rejects(localMcpHttp(access.instance, "/mcp", { action: "call", cwd: directory, server: "x", tool: "x", args: [] }), /JSON 对象/);
  await assert.rejects(localMcpHttp(access.instance, "/mcp", { action: "save_mcp_json" }), /cwd|action/);
  assert.equal(calls, 0);
  const original = await requestLocalMcp(access.instance, { action: "contexts" });
  assert.deepEqual(original, { content: [{ type: "text", text: "original" }], structuredContent: { untouched: true } });
  assert.equal(calls, 1);
  const abandoned = { ...access.instance, instanceId: "stale" };
  await writeFile(join(directory, "stale.json"), JSON.stringify(abandoned));
  assert.equal((await discoverLocalMcpInstances(directory)).length, 1, "a descriptor must match the live endpoint's identity");
  await access.close();
  assert.deepEqual(await discoverLocalMcpInstances(directory), []);
  await assert.rejects(readFile(descriptor), { code: "ENOENT" });
});

test("disconnecting a client cancels its in-flight runtime call", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coilcoil-access-abort-"));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled!: () => void;
  const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
  const access = await startLocalMcpServer({
    dataDir: directory, registryDirectory: directory,
    handle(_request, signal) {
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled(); reject(signal.reason); }, { once: true }));
    },
  });
  t.after(async () => { await access.close(); await rm(directory, { recursive: true, force: true }); });
  const controller = new AbortController();
  const call = requestLocalMcp(access.instance, { action: "contexts" }, controller.signal);
  const rejected = assert.rejects(call, /abort/i);
  await started;
  controller.abort();
  await rejected;
  await Promise.race([aborted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("runtime call was not cancelled")), 2_000); timer.unref(); })]);
});

test("an external CLI discovers real configured MCPs, uses project scope, and calls tools without a model or session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coilcoil-access-e2e-"));
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "project");
  const other = join(directory, "other");
  const registry = join(directory, "registry");
  await Promise.all([mkdir(agentDir), mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(other)]);
  const definition = { command: process.execPath, args: [fixture], env: { API_KEY: "private-config-value" }, lifecycle: "lazy" };
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ imports: [], mcpServers: { echo: definition, disabled: { ...definition, disabled: true } } }));
  await writeFile(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: { project: definition } }));
  const server = new RuntimeServer({ agentDir, sessionDir: join(directory, "sessions") }, () => undefined);
  t.after(async () => { await server.dispose(); await rm(directory, { recursive: true, force: true }); });
  const configuration = await server.runtime.getMcpConfiguration(cwd);
  const echo = configuration.servers.find((entry) => entry.name === "echo")!;
  await server.runtime.saveMcpServer({ ...echo, name: "ui-project", scope: "project" }, undefined, cwd);
  const access = await server.startLocalMcpAccess(registry);
  const run = (args: string[]) => execute(process.execPath, ["--import", "tsx", cli, "mcp", ...args], {
    cwd: repository, env: { ...process.env, COILCOIL_RUNTIME_DIR: registry }, timeout: 20_000,
  });
  const listing = await run(["list", "--cwd", cwd]);
  const names = JSON.parse(listing.stdout).servers.map((entry: { server: string }) => entry.server);
  assert.ok(names.includes("echo") && names.includes("project") && names.includes("ui-project"));
  assert.ok(!names.includes("disabled"));
  assert.equal(listing.stderr, "");
  assert.ok(!listing.stdout.includes("private-config-value"));
  const otherListing = JSON.parse((await run(["list", "--cwd", other])).stdout);
  const otherNames = otherListing.servers.map((entry: { server: string }) => entry.server);
  assert.ok(otherNames.includes("echo") && !otherNames.includes("project") && !otherNames.includes("ui-project") && !otherNames.includes("disabled"));
  const tools = JSON.parse((await run(["tools", "echo", "--cwd", cwd])).stdout);
  assert.equal(tools.status, "connected");
  assert.equal(tools.tools[0].name, "echo");
  assert.equal(tools.tools[0].inputSchema.properties.text.type, "string");
  const called = JSON.parse((await run(["call", "echo", "echo", "--cwd", cwd, "--args", '{"text":"external agent"}'])).stdout);
  assert.equal(called.content[0].text, "MCP_ECHO:external agent");
  await assert.rejects(run(["call", "disabled", "echo", "--cwd", cwd]), (error: unknown) => {
    const failure = error as { code: number; stderr: string };
    assert.equal(failure.code, 1);
    assert.match(JSON.parse(failure.stderr).error, /停用/);
    return true;
  });
  const contexts = await requestLocalMcp(access.instance, { action: "contexts" });
  assert.deepEqual(contexts, { contexts: [] }, "external MCP access must not create a chat");
  const second = await startLocalMcpServer({ dataDir: other, registryDirectory: registry, handle: (input) => server.accessMcp(input) });
  try {
    await assert.rejects(run(["list", "--cwd", cwd]), (error: unknown) => {
      assert.match(JSON.parse((error as { stderr: string }).stderr).error, /多个/); return true;
    });
    const selected = await run(["list", "--cwd", cwd, "--instance", access.instance.instanceId]);
    assert.ok(JSON.parse(selected.stdout).servers.some((entry: { server: string }) => entry.server === "echo"));
  } finally { await second.close(); }
  await server.dispose();
  assert.deepEqual(await readdir(registry), []);
});

test("the stdio runtime automatically publishes access and cleans it up when its parent closes stdin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coilcoil-runtime-entry-"));
  const agentDir = join(directory, "agent");
  const registry = join(directory, "registry");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }));
  const child = spawn(process.execPath, ["--import", "tsx", "packages/runtime-server/src/stdio.ts"], {
    cwd: repository,
    env: { ...process.env, COILCOIL_AGENT_DIR: agentDir, COILCOIL_SESSION_DIR: join(directory, "sessions"), COILCOIL_RUNTIME_DIR: registry },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.resume();
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  let instances = await discoverLocalMcpInstances(registry);
  const deadline = Date.now() + 8_000;
  while (!instances.length && child.exitCode === null && Date.now() < deadline) {
    await delay(25);
    instances = await discoverLocalMcpInstances(registry);
  }
  assert.equal(instances.length, 1, `runtime did not publish access: ${stderr}`);
  const result = await requestLocalMcp(instances[0], { action: "call", cwd: directory, server: "fixture", tool: "echo", args: { text: "stdio runtime" } }) as { content: Array<{ text: string }> };
  assert.equal(result.content[0].text, "MCP_ECHO:stdio runtime");
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.deepEqual(await readdir(registry), []);
});
