import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TerminalSessionSnapshot } from "../src/shared/desktop-api.ts";
import { TerminalRuntimeManager } from "../src/main/terminal-runtime.ts";

test("workspace terminal is reused while running and publishes command output", async (context) => {
  const cwd = mkdtempSync(join(tmpdir(), "suocode-terminal-"));
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
    if (output.join("").includes("SUOCODE_TERMINAL_OK")) resolveOutput?.();
  });
  context.after(() => {
    manager.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  // `ensure` is what the panel calls on mount, so a remount must not spawn a
  // second shell. `create` is the explicit "new terminal" action and always does.
  const first = manager.ensure(cwd);
  const second = manager.ensure(cwd);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.id, first[0]?.id);

  const id = first[0]?.id;
  assert.ok(id);
  manager.write(id, "printf 'SUOCODE_TERMINAL_OK\\n'\r");
  await outputSeen;
  assert.match(manager.state()[0]?.output ?? "", /SUOCODE_TERMINAL_OK/);
  assert.deepEqual(manager.close(id), []);
});

test("the panel can run several terminals in one workspace and close them one by one", (context) => {
  const cwd = mkdtempSync(join(tmpdir(), "suocode-terminal-multi-"));
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
  // Sorted by start time, so the strip's tab order is stable across updates.
  assert.ok((opened[0]?.startedAt ?? 0) <= (opened[1]?.startedAt ?? 0));

  // An existing shell means `ensure` still adds nothing.
  assert.equal(manager.ensure(cwd).length, 2);

  const remaining = manager.close(opened[0]!.id);
  assert.deepEqual(remaining.map((item) => item.id), [opened[1]!.id]);
  assert.deepEqual(manager.close(opened[1]!.id), []);
});
