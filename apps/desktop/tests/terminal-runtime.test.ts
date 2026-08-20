import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TerminalSessionSnapshot } from "../src/shared/desktop-api.ts";
import { TerminalRuntimeManager } from "../src/main/terminal-runtime.ts";

test("a workspace terminal runs a command and publishes its output", async (context) => {
  const cwd = mkdtempSync(join(tmpdir(), "coilcoil-terminal-"));
  const updates: TerminalSessionSnapshot[][] = [];
  const output: string[] = [];
  let resolveOutput: (() => void) | undefined;
  const outputSeen = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal output timeout")), 5_000);
    resolveOutput = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  const manager = new TerminalRuntimeManager((state) => {
    updates.push(state);
  }, (_id, data) => {
    output.push(data);
    if (output.join("").includes("COILCOIL_TERMINAL_OK")) resolveOutput?.();
  });
  context.after(() => {
    manager.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  // Opening a terminal is an explicit user action now — a tab is created for
  // the shell this returns — so `create` always spawns one.
  const first = manager.create(cwd);
  assert.equal(first.length, 1);

  const id = first[0]?.id;
  assert.ok(id);
  manager.write(id, "printf 'COILCOIL_TERMINAL_OK\\n'\r");
  await outputSeen;
  assert.match(manager.state()[0]?.output ?? "", /COILCOIL_TERMINAL_OK/);
  assert.deepEqual(manager.close(id), []);
});

test("a workspace can run several terminals and close them one by one", (context) => {
  const cwd = mkdtempSync(join(tmpdir(), "coilcoil-terminal-multi-"));
  const manager = new TerminalRuntimeManager(() => undefined, () => undefined);
  context.after(() => {
    manager.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  manager.create(cwd);
  const opened = manager.create(cwd);
  assert.equal(opened.length, 2);
  assert.equal(new Set(opened.map((item) => item.id)).size, 2);
  assert.deepEqual(opened.map((item) => item.status), ["running", "running"]);
  // Sorted by start time, so the tab order is stable across updates and the
  // renderer can name the newest shell as the one it just opened.
  assert.ok((opened[0]?.startedAt ?? 0) <= (opened[1]?.startedAt ?? 0));

  const remaining = manager.close(opened[0]!.id);
  assert.deepEqual(remaining.map((item) => item.id), [opened[1]!.id]);
  assert.deepEqual(manager.close(opened[1]!.id), []);
});
