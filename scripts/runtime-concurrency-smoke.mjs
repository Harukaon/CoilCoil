import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const temporaryRoot = await mkdtemp(join(tmpdir(), "suocode-concurrency-"));
const projectA = join(temporaryRoot, "project-a");
const projectB = join(temporaryRoot, "project-b");
await Promise.all([mkdir(projectA), mkdir(projectB)]);

const child = fork(join(root, "apps/desktop/out/main/runtime.js"), [], {
  env: {
    ...process.env,
    SUOCODE_AGENT_DIR: join(temporaryRoot, "agent"),
    SUOCODE_SESSION_DIR: join(temporaryRoot, "sessions"),
    SUOCODE_LEGACY_AGENT_DIR: live ? join(homedir(), ".pi", "agent") : join(temporaryRoot, "no-legacy"),
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

const pending = new Map();
const events = [];
let sequence = 0;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.on("message", (message) => {
  if (message && typeof message === "object" && "event" in message) {
    events.push({ ...message, receivedAt: Date.now() });
    return;
  }
  const waiter = pending.get(message?.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(message.error || "Runtime command failed"));
});

function request(command, runtimeId) {
  const id = `concurrency-${++sequence}`;
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    child.send({ id, runtimeId, command });
  });
}

function waitForEvent(predicate, from = 0, timeoutMs = 180_000) {
  return new Promise((resolveEvent, rejectEvent) => {
    let cursor = from;
    const interval = setInterval(() => {
      while (cursor < events.length) {
        const event = events[cursor++];
        if (predicate(event)) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolveEvent(event);
          return;
        }
      }
    }, 20);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      rejectEvent(new Error(`Timed out waiting for scoped runtime event. ${stderr}`));
    }, timeoutMs);
  });
}

function configuredMiniMaxM3(configuration) {
  return configuration.models.find((model) => {
    if (!model.configured) return false;
    const identity = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
    return identity.includes("minimax") && /(^|[^a-z0-9])m3([^a-z0-9]|$)/i.test(identity);
  });
}

function runtimeDescendants() {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const rows = output.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : undefined;
  }).filter(Boolean);
  const descendants = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.pid === child.pid || descendants.has(row.pid)) continue;
      if (row.ppid === child.pid || descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid));
}

try {
  let bootstrap;
  let first;
  let coldOpenMs;
  if (live) {
    bootstrap = await request({ type: "bootstrap" });
    const model = configuredMiniMaxM3(bootstrap.configuration);
    assert.ok(model, "The live concurrency smoke requires a configured MiniMax M3 model.");
    await request({
      type: "configure_model",
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: model.supportedThinkingLevels.includes("low") ? "low" : model.supportedThinkingLevels[0] ?? "off",
    });
    const coldStartedAt = performance.now();
    first = await request({ type: "create_session", cwd: projectA });
    coldOpenMs = performance.now() - coldStartedAt;
  } else {
    const coldStartedAt = performance.now();
    [bootstrap, first] = await Promise.all([
      request({ type: "bootstrap" }),
      request({ type: "create_session", cwd: projectA }),
    ]);
    coldOpenMs = performance.now() - coldStartedAt;
  }

  const warmStartedAt = performance.now();
  const second = await request({ type: "create_session", cwd: projectB });
  const warmOpenMs = performance.now() - warmStartedAt;
  assert.ok(first.runtimeId && second.runtimeId);
  assert.notEqual(first.runtimeId, second.runtimeId);

  const switchStartedAt = performance.now();
  const reopened = await request({ type: "open_session", cwd: projectA, sessionPath: first.session.path });
  const switchMs = performance.now() - switchStartedAt;
  assert.equal(reopened.runtimeId, first.runtimeId, "reopening a loaded conversation must reuse its in-process session");
  assert.ok(switchMs < 1_000, `switching to an in-memory conversation took ${switchMs.toFixed(1)}ms`);
  assert.equal(
    runtimeDescendants().filter((process) => /out\/main\/runtime\.js/.test(process.command)).length,
    0,
    "the Runtime process must not fork another Runtime per conversation",
  );

  const scopedSnapshots = events.filter((message) => message.event.type === "session_snapshot");
  assert.ok(scopedSnapshots.some((message) => message.runtimeId === first.runtimeId));
  assert.ok(scopedSnapshots.some((message) => message.runtimeId === second.runtimeId));

  if (live) {
    const tokenA = `CONCURRENT_A_${Date.now()}`;
    const tokenB = `CONCURRENT_B_${Date.now()}`;
    const firstEventIndex = events.length;
    await request({
      type: "prompt",
      text: `Call the bash tool exactly once with this command: sleep 5; printf ${tokenA}. After it completes, reply exactly ${tokenA}.`,
    }, first.runtimeId);
    await waitForEvent(
      (message) => message.runtimeId === first.runtimeId && message.event.type === "tool_started" && message.event.tool.name === "bash",
      firstEventIndex,
    );

    const secondEventIndex = events.length;
    await request({ type: "prompt", text: `Reply exactly ${tokenB}. Do not call tools.` }, second.runtimeId);
    const runningA = await request({ type: "open_session", cwd: projectA, sessionPath: first.session.path });
    assert.equal(runningA.running, true, "opening and prompting another conversation stopped the first conversation");

    await waitForEvent(
      (message) => message.runtimeId === second.runtimeId
        && message.event.type === "message_finished"
        && message.event.message.role === "assistant"
        && message.event.message.text.includes(tokenB),
      secondEventIndex,
    );
    await waitForEvent(
      (message) => message.runtimeId === first.runtimeId
        && message.event.type === "message_finished"
        && message.event.message.role === "assistant"
        && message.event.message.text.includes(tokenA),
      firstEventIndex,
    );

    const completedA = await request({ type: "open_session", cwd: projectA, sessionPath: first.session.path });
    const completedB = await request({ type: "open_session", cwd: projectB, sessionPath: second.session.path });
    assert.equal(completedA.running, false);
    assert.equal(completedB.running, false);
    assert.ok(completedA.messages.some((message) => message.role === "assistant" && message.text.includes(tokenA)));
    assert.ok(completedB.messages.some((message) => message.role === "assistant" && message.text.includes(tokenB)));
  }

  process.stdout.write(`SuoCode concurrency smoke passed (cold ${coldOpenMs.toFixed(1)}ms, warm ${warmOpenMs.toFixed(1)}ms, switch ${switchMs.toFixed(1)}ms).\n`);
  if (process.env.SUOCODE_RUNTIME_TIMING === "1" && stderr) process.stdout.write(stderr);
} finally {
  child.disconnect();
  child.kill("SIGTERM");
  await rm(temporaryRoot, { recursive: true, force: true });
}
