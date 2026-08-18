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

  const first = manager.create(cwd);
  const second = manager.create(cwd);
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
