import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import bashCwdExtension, {
  resolveBashCwd,
  shellQuote,
} from "../extensions/bash-cwd.ts";

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const bash = {
    name: "bash",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      additionalProperties: false,
    },
  };
  const pi = {
    getAllTools: () => [bash],
    on(name: string, handler: (...args: any[]) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
  };
  bashCwdExtension(pi as any);
  return { bash, handlers };
}

test("bash cwd is added to the schema and safely prefixed", async () => {
  const { bash, handlers } = createHarness();
  await handlers.get("session_start")?.[0]({}, {});

  assert.equal((bash.parameters.properties as any).cwd.type, "string");

  const input = { command: "pwd", cwd: tmpdir() };
  const result = await handlers.get("tool_call")?.[0](
    { toolName: "bash", input },
    { cwd: "/Users/hao/Desktop/project" },
  );

  assert.equal(result, undefined);
  assert.equal(input.cwd, undefined);
  assert.match(input.command, new RegExp(`^cd -- .* && pwd$`));
  assert.match(input.command, new RegExp(basename(tmpdir())));
});

test("bash cwd rejects missing directories", async () => {
  const { handlers } = createHarness();
  const result = await handlers.get("tool_call")?.[0](
    {
      toolName: "bash",
      input: { command: "pwd", cwd: "/path/that/does/not/exist" },
    },
    { cwd: "/Users/hao/Desktop/project" },
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /cwd 不存在/);
});

test("bash cwd helpers handle home and shell quoting", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(resolveBashCwd(".", "/tmp"), "/tmp");
});
