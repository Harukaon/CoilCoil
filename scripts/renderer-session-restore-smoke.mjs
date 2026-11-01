/** Real React App + DOM; isolated browser and local fake runtime, no desktop build. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(tmpdir(), "coil-renderer-restore-dom-"));
const server = await createServer({ configFile: false, root: join(root, "scripts/fixtures/renderer-session-restore"),
  cacheDir: join(output, "vite-cache"), plugins: [react()], logLevel: "error",
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
});
await server.listen();
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath: process.env.COILCOIL_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const failures = [];
const externalRequests = [];
page.on("pageerror", (error) => failures.push(error.stack ?? error.message));
page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
  externalRequests.push(url);
  return route.abort();
});

try {
  await page.goto(origin);
  await page.locator(".conversation-header strong").filter({ hasText: "Session A" }).waitFor();
  await page.locator(".conversation-body").getByText("A-START", { exact: true }).waitFor();
  const editor = page.getByRole("textbox", { name: "发送消息给 CoilCoil" });
  await editor.fill("STEER-ONLY-ONCE");
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await page.getByRole("button", { name: "让第 1 条排队消息介入当前轮次", exact: true }).click();
  const steering = page.locator(".conversation-body [data-message-id]").filter({ hasText: "STEER-ONLY-ONCE" });
  await steering.waitFor();
  assert.equal(await steering.count(), 1);
  const row = (name) => page.locator(".conversation-list button.conversation-row:not(.recent-conversation-row)").filter({ hasText: `Session ${name}` });
  await row("B").click();
  await page.locator(".conversation-header strong").filter({ hasText: "Session B" }).waitFor();
  await page.evaluate(() => window.smoke.delta(" HIDDEN"));
  await page.evaluate(() => window.smoke.holdOpen("A"));
  await row("A").click();
  await page.waitForFunction(() => window.smoke.pendingOpen());
  await page.evaluate(() => window.smoke.delta(" EARLY"));
  // Exceed the production 60ms event buffer to force the old failure ordering.
  await page.waitForTimeout(150);
  await row("B").focus();
  const focusedBefore = await page.evaluate(() => document.activeElement?.textContent);
  await page.evaluate(() => window.smoke.releaseOpen());
  await page.locator(".conversation-body").getByText("A-START HIDDEN EARLY", { exact: true }).waitFor();
  assert.equal(await steering.count(), 1, "steering must survive navigation and appear once");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), focusedBefore, "late restore must not steal keyboard focus");
  await page.evaluate(() => window.smoke.delta(" LATE"));
  await page.locator(".conversation-body").getByText("A-START HIDDEN EARLY LATE", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "restored-stream.png"), fullPage: true });
  await page.getByRole("button", { name: "停止 Agent", exact: true }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.equal(await page.locator(".agent-activity").count(), 0);
  await page.waitForFunction(() => document.querySelector('[aria-label="发送消息给 CoilCoil"]')?.textContent === "STEER-ONLY-ONCE");
  assert.equal(await steering.count(), 0, "an aborted undelivered steer returns to the composer");
  await page.screenshot({ path: join(output, "stopped-stream.png"), fullPage: true });
  await page.evaluate(() => window.smoke.waitForMonitor());
  const monitorStatus = page.getByRole("status").filter({ hasText: "正在监控后台任务，有结果后自动继续" });
  await monitorStatus.waitFor();
  assert.equal(await page.getByRole("button", { name: "发送消息", exact: true }).isEnabled(), true,
    "an idle monitor must leave the composer available for a new user message");
  await row("B").click();
  await page.locator(".conversation-header strong").filter({ hasText: "Session B" }).waitFor();
  assert.equal(await monitorStatus.count(), 0, "another session must not inherit the monitor wait");
  await row("A").click();
  await monitorStatus.waitFor();
  await page.screenshot({ path: join(output, "waiting-monitor.png"), fullPage: true });
  await page.getByRole("button", { name: "取消后台监控等待", exact: true }).click();
  await monitorStatus.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "取消后台监控等待", exact: true }).count(), 0);
  const calls = await page.evaluate(() => window.smoke.calls);
  const trace = await page.evaluate(() => window.smoke.trace);
  const held = trace.find((entry) => entry.type === "snapshot-held");
  const released = trace.find((entry) => entry.type === "snapshot-released");
  const early = trace.find((entry) => entry.delta === " EARLY");
  assert.ok(held.revision < early.revision && held.at <= early.at && early.at < released.at,
    "the smoke must exercise a newer delta overtaking the authoritative snapshot");
  assert.ok(calls.some((call) => call.type === "promote_queued_prompt" && call.runtimeId === "runtime-A"));
  assert.ok(calls.some((call) => call.type === "abort" && call.runtimeId === "runtime-A"));
  assert.equal(calls.filter((call) => call.type === "abort" && call.runtimeId === "runtime-A").length, 2,
    "both a live run and an idle monitor must be cancellable through the same runtime stop command");
  assert.deepEqual(failures, []);
  assert.deepEqual(externalRequests, []);
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, calls, trace, failures, externalRequests }, null, 2));
  process.stdout.write(`Renderer session restore DOM smoke passed. Artifacts: ${output}\n`);
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), failures, externalRequests, body: await page.locator("body").innerText() }, null, 2));
  process.stderr.write(`Artifacts: ${output}\n${JSON.stringify(failures)}\n`);
  throw error;
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
