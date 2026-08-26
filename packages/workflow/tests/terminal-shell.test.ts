import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { resolveTerminalShell } from "../extensions/terminal/shell.ts";

test("the login shell never decides which shell runs commands", () => {
  const withFish = resolveTerminalShell("darwin", { PATH: "/usr/bin", SHELL: "/opt/homebrew/bin/fish" });
  const withoutShell = resolveTerminalShell("darwin", { PATH: "/usr/bin" });
  assert.equal(withFish.shell, withoutShell.shell);
  assert.notEqual(withFish.shell, "/opt/homebrew/bin/fish");
});

test("unix prefers bash and keeps a login shell", () => {
  const resolved = resolveTerminalShell("darwin", { PATH: "/usr/bin" });
  assert.equal(resolved.shell, existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  assert.deepEqual(resolved.args("echo hi"), ["-lc", "echo hi"]);
});

test("unix falls back to sh when no bash exists anywhere", () => {
  const resolved = resolveTerminalShell("linux", { PATH: "/nonexistent-directory" });
  assert.ok(resolved.shell === "/bin/bash" || resolved.shell === "/bin/sh");
});

test("windows uses PowerShell with its own flags regardless of SHELL", () => {
  const resolved = resolveTerminalShell("win32", { PATH: "C:\\Windows", SHELL: "/usr/bin/bash" });
  assert.equal(resolved.shell, "powershell.exe");
  assert.deepEqual(resolved.args("Get-Location"), ["-NoLogo", "-Command", "Get-Location"]);
});
