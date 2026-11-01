#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";
import { createJiti } from "jiti";

const repository = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const run = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "coilcoil-external-browser-")));
const data = join(root, "data");
const agent = join(data, "agent");
const project = join(root, "project");
const otherProject = join(root, "other-project");
const draftProject = join(root, "draft-project");
const registry = join(root, "registry");
await Promise.all([agent, project, otherProject, draftProject].map((path) => mkdir(path, { recursive: true })));
const configPath = join(agent, "mcp.json");
const adapter = await createJiti(import.meta.url).import(join(repository, "node_modules/pi-mcp-adapter/config.ts"));
const inherited = adapter.loadMcpConfig(configPath, root).mcpServers;
await writeFile(configPath, JSON.stringify({
  mcpServers: Object.fromEntries(Object.keys(inherited).map((name) => [name, { disabled: true }])),
  settings: { hostConfigDiscovery: "off" },
}));
const env = {
  ...process.env, COILCOIL_RUNTIME_DIR: registry, COILCOIL_DISABLE_UPDATE_CHECK: "1",
  COILCOIL_LEGACY_AGENT_DIR: join(root, "no-legacy"),
};
const fixture = createServer((request, response) => {
  const marker = new URL(request.url, "http://fixture").pathname.slice(1) || "DRAFT";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>Fixture ${marker}</title><h1>MARKER_${marker}</h1>
    <label>Name<input id="name"></label><button id="apply">Apply</button><p id="result">idle</p>
    <script>document.querySelector('#apply').onclick=()=>document.querySelector('#result').textContent='RESULT_'+document.querySelector('#name').value</script>`);
});
await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
let app;
let instanceId;
const command = join(agent, "runtime-bin", process.platform === "win32" ? "coilcoil-mcp.cmd" : "coilcoil-mcp");
async function cli(...args) {
  const result = await run(command, args, { cwd: tmpdir(), env, timeout: 45_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}
const textOf = (result) => result.content?.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n") ?? "";
function flags(context) {
  return ["--cwd", context.session.cwd, "--runtime-id", context.runtimeId, "--instance", instanceId];
}
async function tool(context, name, args = {}) {
  const result = await cli("call", "coilcoil-browser", name, "--args", JSON.stringify(args), ...flags(context));
  assert.ok(!result.isError, `${name}: ${textOf(result)}`);
  return result;
}
async function pages(context) {
  const result = await tool(context, "list_pages");
  return result.structuredContent?.pages ?? [];
}
async function evaluate(context, expression, pageId) {
  return textOf(await tool(context, "evaluate_script", { function: expression, ...pageId === undefined ? {} : { pageId } }));
}
async function waitUntil(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch { /* Startup is asynchronous. */ }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  const packagedExecutable = process.argv[2];
  app = await electron.launch({
    executablePath: packagedExecutable ? resolve(packagedExecutable) : require("electron"),
    args: [...packagedExecutable ? [] : [join(repository, "apps/desktop")], `--user-data-dir=${data}`],
    cwd: root, env, timeout: 60_000,
  });
  const renderer = await app.firstWindow();
  await renderer.waitForFunction(() => Boolean(window.coilcoil));
  const instance = await waitUntil(async () => (await cli("instances")).instances.find((entry) => entry.dataDir === data), "runtime discovery");
  instanceId = instance.instanceId;
  const request = (command) => renderer.evaluate((value) => window.coilcoil.request(value), command);
  const a = await request({ type: "create_session", cwd: project });
  const b = await request({ type: "create_session", cwd: project });
  const c = await request({ type: "create_session", cwd: otherProject });
  assert.ok(a.runtimeId && b.runtimeId && c.runtimeId);
  assert.notEqual(a.session.id, b.session.id);
  console.log("PASS: created two real conversations in one project, plus a conversation in another project, without a model call.");

  const schemas = await cli("tools", "coilcoil-browser", ...flags(a));
  assert.equal(schemas.status, "connected");
  for (const name of ["new_page", "take_snapshot", "click", "fill", "take_screenshot", "evaluate_script"]) {
    assert.ok(schemas.tools.some((entry) => entry.name === name), `Missing ${name}`);
  }
  await tool(a, "new_page", { url: `${fixtureBase}/A` });
  await tool(b, "new_page", { url: `${fixtureBase}/B` });
  await tool(c, "new_page", { url: `${fixtureBase}/C` });
  const [aPages, bPages] = await Promise.all([pages(a), pages(b)]);
  assert.ok(aPages.some((entry) => entry.url.endsWith("/A")));
  assert.ok(!aPages.some((entry) => entry.url.endsWith("/B")));
  assert.ok(bPages.some((entry) => entry.url.endsWith("/B")));
  assert.ok(!bPages.some((entry) => entry.url.endsWith("/A")));
  const aPage = aPages.find((entry) => entry.url.endsWith("/A"));
  const bPage = bPages.find((entry) => entry.url.endsWith("/B"));
  console.log("PASS: external page lists are isolated between conversations in the same project.");

  const snapshot = await tool(a, "take_snapshot", { pageId: aPage.id });
  const snapshotText = textOf(snapshot);
  assert.match(snapshotText, /MARKER_A/);
  assert.doesNotMatch(snapshotText, /MARKER_B/);
  const inputUid = /uid=([^\s]+)\s+textbox\s+"Name"/.exec(snapshotText)?.[1];
  const buttonUid = /uid=([^\s]+)\s+button\s+"Apply"/.exec(snapshotText)?.[1];
  assert.ok(inputUid && buttonUid, `Missing fixture controls: ${snapshotText}`);
  await tool(a, "fill", { uid: inputUid, value: "external_agent", pageId: aPage.id });
  await tool(a, "click", { uid: buttonUid, pageId: aPage.id });
  assert.match(textOf(await tool(a, "take_snapshot", { pageId: aPage.id })), /RESULT_external_agent/);
  const screenshot = await tool(a, "take_screenshot", { pageId: aPage.id });
  assert.ok(screenshot.content.some((entry) => entry.type === "image" && entry.data.length > 100));
  assert.match(await evaluate(b, "() => document.querySelector('#result').textContent", bPage.id), /idle/);
  console.log("PASS: real navigation, text snapshot, form input, click, and image screenshot work; conversation B is unchanged.");

  // Each MCP connection assigns its own numeric page IDs. A number copied from
  // another conversation either identifies this conversation's own page or fails.
  try {
    const attempted = await evaluate(b, "() => document.title", aPage.id);
    assert.doesNotMatch(attempted, /Fixture A/);
  } catch (error) {
    if (!error.stdout) throw error;
    const failedTool = JSON.parse(error.stdout);
    assert.equal(failedTool.isError, true, "Expected a tool-level page lookup failure");
    assert.doesNotMatch(textOf(failedTool), /Fixture A/);
  }
  await tool(a, "new_page", { url: `${fixtureBase}/A_SECOND` });
  const onlyInA = (await pages(a)).find((entry) => entry.url.endsWith("/A_SECOND"));
  assert.ok(onlyInA && !(await pages(b)).some((entry) => entry.id === onlyInA.id));
  await assert.rejects(tool(b, "navigate_page", { pageId: onlyInA.id, url: `${fixtureBase}/CROSS_SCOPE_WRITE` }), (error) => {
    if (!error.stdout) return false;
    return JSON.parse(error.stdout).isError === true;
  });
  assert.ok((await pages(a)).some((entry) => entry.url.endsWith("/A_SECOND")), "B must not navigate A's second page.");
  await assert.rejects(cli("call", "coilcoil-browser", "list_pages", "--cwd", otherProject, "--runtime-id", a.runtimeId, "--instance", instanceId));
  await assert.rejects(cli("call", "coilcoil-browser", "list_pages", "--cwd", project, "--runtime-id", "missing-runtime", "--instance", instanceId));
  console.log("PASS: copied page IDs resolve locally or fail; B cannot navigate A's extra page; wrong workspace and expired runtime IDs are rejected.");

  await evaluate(a, "() => { document.cookie='coilcoil_probe=shared_project; path=/'; return document.cookie; }", aPage.id);
  assert.match(await evaluate(b, "() => document.cookie", bPage.id), /coilcoil_probe=shared_project/);
  assert.doesNotMatch(await evaluate(c, "() => document.cookie"), /coilcoil_probe/);
  console.log("PASS: conversations in the same project share cookies; another project has a separate cookie jar.");

  await request({ type: "open_session", cwd: project, sessionPath: b.session.path });
  const defaultB = await cli("call", "coilcoil-browser", "list_pages", "--cwd", project, "--instance", instanceId);
  assert.ok(defaultB.structuredContent.pages.some((entry) => entry.url.endsWith("/B")));
  await request({ type: "open_session", cwd: project, sessionPath: a.session.path });
  const defaultA = await cli("call", "coilcoil-browser", "list_pages", "--cwd", project, "--instance", instanceId);
  assert.ok(defaultA.structuredContent.pages.some((entry) => entry.url.endsWith("/A")));
  assert.match(await evaluate(b, "() => document.title", bPage.id), /Fixture B/);
  console.log("PASS: changing the selected conversation changes automatic routing; explicitly pinned runtime IDs remain stable.");

  await cli("call", "coilcoil-browser", "new_page", "--cwd", draftProject, "--instance", instanceId, "--args", JSON.stringify({ url: `${fixtureBase}/DRAFT` }));
  const draft = await request({ type: "create_session", cwd: draftProject });
  assert.ok((await pages(draft)).some((entry) => entry.url.endsWith("/DRAFT")));
  console.log("PASS: a new conversation adopts the browser tabs created in its project's draft scope.");

  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isOffscreen()) window.close();
  });
  await waitUntil(async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => window.webContents.isOffscreen())), "all desktop windows closed");
  await assert.rejects(tool(a, "list_pages"), (error) => /打开 CoilCoil 桌面窗口/.test(error.stderr));
  console.log("PASS: after all desktop windows close, browser calls return a clear reopen-window error.");
  console.log("All external browser smoke checks passed.");
} catch (error) {
  for (const name of ["main.jsonl", "runtime.jsonl"]) {
    const logs = await readFile(join(agent, "logs", name), "utf8").catch(() => "");
    console.error(name, logs.trim().split("\n").filter(Boolean).slice(-8).map((line) => {
      try { const entry = JSON.parse(line); return `${entry.level}:${entry.event}`; } catch { return "invalid log"; }
    }));
  }
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await new Promise((done) => fixture.close(done));
  await rm(root, { recursive: true, force: true });
}
