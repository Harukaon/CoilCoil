import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A packaged Desktop supplies a shell client using its own headless Node. */
export function installMcpCli(binDir: string, nodeExecutable: string, entry: string): void {
  if (!existsSync(entry)) return;
  if (process.platform === "win32") {
    const quote = (value: string) => `"${value.replaceAll("%", "%%")}"`;
    writeFileSync(join(binDir, "coilcoil-mcp.cmd"), `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${quote(nodeExecutable)} ${quote(entry)} %*\r\n`);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const target = join(binDir, "coilcoil-mcp");
    writeFileSync(target, `#!/bin/sh\nexec ${quote(nodeExecutable)} ${quote(entry)} "$@"\n`, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
}
