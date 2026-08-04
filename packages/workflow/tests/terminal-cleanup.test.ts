import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import terminalExtension from "../extensions/terminal.ts";
import { redactSecrets } from "../extensions/secret-store.ts";

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  let terminalTool: any;
  const messages: any[] = [];
  const pi = {
    registerTool(tool: any) {
      terminalTool = tool;
    },
    on(name: string, handler: (...args: any[]) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
  };

  terminalExtension(pi as any);
  const ctx = { cwd: process.cwd() };
  const run = (params: Record<string, unknown>) =>
    terminalTool.execute("test-call", params, undefined, undefined, ctx);
  const shutdown = async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({}, ctx);
    }
  };

  return { run, shutdown, messages };
}

function processRecord(pid: number): string | undefined {
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-o", "pid=,ppid=,pgid=,stat=,comm=", "-p", String(pid)],
      { encoding: "utf8" },
    ).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

test(
  "stop removes a background job in a separate process group",
  { skip: process.platform === "win32" },
  async (context) => {
    const { run, shutdown } = createHarness();
    let terminalId: string | undefined;
    context.after(async () => {
      if (terminalId) {
        await run({
          action: "stop",
          id: terminalId,
          force: true,
          timeoutMs: 1_000,
        }).catch(() => undefined);
      }
      await shutdown();
    });

    const started = await run({
      action: "start",
      command:
        "set -m; sleep 300 & child=$!; echo CHILD_PID=$child SHELL_PID=$$ READY; wait",
      waitFor: "READY",
      timeoutMs: 5_000,
    });
    terminalId = started.details.id;

    const match = started.details.output.match(
      /CHILD_PID=(\d+)\s+SHELL_PID=(\d+)\s+READY/,
    );
    assert.ok(match, `PID output missing: ${started.details.output}`);
    const childPid = Number(match[1]);
    const shellPid = Number(match[2]);
    const childBefore = processRecord(childPid);
    const shellBefore = processRecord(shellPid);
    assert.ok(childBefore);
    assert.ok(shellBefore);
    assert.notEqual(
      childBefore.trim().split(/\s+/)[2],
      shellBefore.trim().split(/\s+/)[2],
      "background process must use a distinct PGID for this regression",
    );

    const stopped = await run({
      action: "stop",
      id: terminalId,
      timeoutMs: 4_000,
    });
    terminalId = undefined;

    assert.equal(processRecord(shellPid), undefined);
    assert.equal(processRecord(childPid), undefined);
    assert.equal(stopped.details.status, "stopped");
    assert.equal(stopped.details.cleanup.gracefulSucceeded, true);
    assert.equal(stopped.details.cleanup.escalatedToSigkill, false);
    assert.deepEqual(stopped.details.cleanup.residualPids, []);
  },
);

test(
  "stop reports SIGKILL escalation without contradictory exitCode",
  { skip: process.platform === "win32" },
  async (context) => {
    const { run, shutdown } = createHarness();
    let terminalId: string | undefined;
    context.after(async () => {
      if (terminalId) {
        await run({
          action: "stop",
          id: terminalId,
          force: true,
          timeoutMs: 1_000,
        }).catch(() => undefined);
      }
      await shutdown();
    });

    const started = await run({
      action: "start",
      command: "trap '' INT TERM; echo READY; while true; do sleep 1; done",
      waitFor: "READY",
      timeoutMs: 3_000,
    });
    terminalId = started.details.id;
    const rootPid = started.details.pid;

    const stopped = await run({
      action: "stop",
      id: terminalId,
      force: false,
      timeoutMs: 1_200,
    });
    terminalId = undefined;

    assert.equal(processRecord(rootPid), undefined);
    assert.equal(stopped.details.cleanup.gracefulAttempted, true);
    assert.equal(stopped.details.cleanup.gracefulSucceeded, false);
    assert.equal(stopped.details.cleanup.escalatedToSigkill, true);
    assert.equal(stopped.details.cleanup.signal, "SIGKILL");
    assert.deepEqual(stopped.details.cleanup.residualPids, []);
    assert.equal(stopped.details.exitCode, null);
    assert.equal(stopped.details.signal, "SIGKILL");
    assert.equal(stopped.details.rawSignal, 9);
  },
);

test("list can clear bounded completed history", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  await run({ action: "start", command: "printf done" });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const before = await run({ action: "list" });
  assert.equal(before.details.running, 0);
  assert.equal(before.details.completed, 1);
  assert.equal(before.details.retention.maxCompleted, 8);
  assert.equal(before.details.retention.ttlMinutes, 30);

  const after = await run({ action: "list", clearExited: true });
  assert.deepEqual(after.details.removed, ["term-1"]);
  assert.equal(after.details.count, 0);
});

test("screen output coalesces carriage-return redraws", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  const result = await run({
    action: "start",
    command: "printf 'one\\rtwo\\rthree\\n'",
    outputMode: "screen",
    timeoutMs: 2_000,
  });

  assert.match(result.details.output, /three/);
  assert.doesNotMatch(result.details.output, /one.*two/s);
  assert.equal(result.details.outputMode, "screen");
});

test("log output keeps carriage-return lines when requested", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  const result = await run({
    action: "start",
    command: "printf 'one\\rtwo\\n'",
    outputMode: "log",
    timeoutMs: 2_000,
  });

  assert.match(result.details.output, /one\ntwo/);
  assert.equal(result.details.outputMode, "log");
});

test("await waits for exit without polling", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  const started = await run({
    action: "start",
    command: "sleep 0.15; printf DONE",
    timeoutMs: 1_000,
  });
  const result = await run({
    action: "await",
    id: started.details.id,
    timeoutMs: 2_000,
  });

  assert.equal(result.details.wait, "exit");
  assert.match(result.details.output, /DONE/);
});

test("notifyOn exit sends a follow-up event", async (context) => {
  const { run, shutdown, messages } = createHarness();
  context.after(shutdown);

  await run({
    action: "start",
    command: "sleep 0.05; printf FINISHED",
    notifyOn: "exit",
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.customType, "terminal-notification");
  assert.equal(messages[0].options.triggerTurn, true);
  assert.match(messages[0].message.content, /已退出/);
});

test("secret references inject into the child and redact output", async (context) => {
  const agentDir = await mkdtemp(join(tmpdir(), "hao-pi-secrets-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const sourcePath = join(agentDir, "source.json");
  await writeFile(sourcePath, JSON.stringify({ apiKey: "abcab" }));
  const registryPath = join(agentDir, "secret-refs.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      testRef: { source: "json", path: sourcePath, jsonPath: "apiKey" },
    }),
  );
  await chmod(registryPath, 0o600);

  const { run, shutdown } = createHarness();
  context.after(shutdown);
  const result = await run({
    action: "start",
    command:
      "python3 -c 'import os,sys,time; s=os.environ[\"TEST_SECRET\"]; sys.stdout.write(s[:3]); sys.stdout.flush(); time.sleep(0.05); sys.stdout.write(s[3:]+\" tail\"); sys.stdout.flush()'",
    secretEnv: { TEST_SECRET: "testRef" },
    timeoutMs: 2_000,
  });

  assert.equal(result.details.secretHandles[0], "testRef");
  assert.match(result.details.output, /\[REDACTED\] tail/);
  assert.doesNotMatch(result.details.output, /abcab|abca|bcab/);
});

test("secret redaction handles overlapping values", () => {
  assert.equal(
    redactSecrets("a=long-secret short-secret", ["short-secret", "long-secret"]),
    "a=[REDACTED] [REDACTED]",
  );
});
