import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMcpCommand } from "../src/mcp-command.js";

test("MCP commands validate targets and JSON objects before contacting a runtime", () => {
  assert.throws(() => parseMcpCommand(["call", "s"]), /Usage/);
  assert.throws(() => parseMcpCommand(["call", "s", "t", "--args", "null"]), /JSON 对象/);
  assert.throws(() => parseMcpCommand(["call", "s", "t", "--args", "[]"]), /JSON 对象/);
  assert.throws(() => parseMcpCommand(["tools", "s", "--args", "{}"]), /require the call/);
  assert.throws(() => parseMcpCommand(["list", "--timeout", "0"]), /timeout/);
  assert.throws(() => parseMcpCommand(["list", "--typo", "yes"]), /Unknown/);
  assert.throws(() => parseMcpCommand(["list", "--cwd"]), /once with a value/);
  assert.deepEqual(parseMcpCommand(["--help"]), { help: true });
});

test("argument files preserve whitespace and literal shell characters", () => {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-cli-args-"));
  const path = join(directory, "args.json");
  const args = { text: "a\nb $HOME `literal` $(literal) 中文" };
  try {
    writeFileSync(path, JSON.stringify(args));
    const parsed = parseMcpCommand(["call", "s", "t", "--cwd", directory, "--args-file", path]);
    assert.ok(!parsed.help);
    assert.deepEqual(parsed.request, { action: "call", server: "s", tool: "t", cwd: directory, runtimeId: undefined, args });
    assert.throws(() => parseMcpCommand(["call", "s", "t", "--args-file", path, "--args", "{}"]), /Use --args or/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
