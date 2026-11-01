import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { installMcpCli } from "../src/runtime/mcp-cli-launcher.js";

test("Desktop's shell client preserves arguments and paths containing spaces and apostrophes", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil client's "));
  const binDir = join(directory, "runtime bin");
  mkdirSync(binDir);
  const entry = join(directory, "client's entry.cjs");
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  try {
    installMcpCli(binDir, process.execPath, entry);
    const args = ["call", "a $HOME `literal` $(literal)", "--args", '{"text":"中文 with spaces"}'];
    const result = await promisify(execFile)(join(binDir, "coilcoil-mcp"), args);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
