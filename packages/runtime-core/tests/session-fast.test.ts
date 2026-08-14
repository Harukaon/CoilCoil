import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SuoCodeRuntime } from "../src/index.js";

interface FastRuntimeInternals {
  active?: {
    fastState?: { version: 1; enabled: boolean; supported: boolean; modelId?: string };
    session: { prompt(text: string): Promise<void> };
  };
}

test("the runtime Fast command updates the current session extension", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-session-fast-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new SuoCodeRuntime({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") });
  const internals = runtime as unknown as FastRuntimeInternals;
  const commands: string[] = [];
  const active: NonNullable<FastRuntimeInternals["active"]> = {
    fastState: { version: 1, enabled: false, supported: true, modelId: "gpt-5.6" },
    session: {
      async prompt(text) {
        commands.push(text);
        active.fastState = { ...active.fastState!, enabled: text.endsWith(" on") };
      },
    },
  };
  internals.active = active;

  assert.equal(await runtime.setSessionFast(true), true);
  assert.equal(await runtime.setSessionFast(false), false);
  assert.deepEqual(commands, ["/fast on", "/fast off"]);
});

test("the runtime rejects Fast for an unsupported model", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-session-fast-unsupported-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new SuoCodeRuntime({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") });
  (runtime as unknown as FastRuntimeInternals).active = {
    fastState: { version: 1, enabled: false, supported: false, modelId: "claude-opus-4-6" },
    session: { async prompt() { throw new Error("must not be called"); } },
  };

  await assert.rejects(runtime.setSessionFast(true), /不支持 Fast/);
});
