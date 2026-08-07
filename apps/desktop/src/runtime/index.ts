import { attachProcessIpc } from "@suocode/runtime-server";
import { chmodSync, existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function installHeadlessNodeExecutable(): void {
  const source = process.env.SUOCODE_NODE_EXEC_PATH;
  const agentDir = process.env.SUOCODE_AGENT_DIR;
  if (!source || !agentDir || !existsSync(source)) return;
  const binDir = join(agentDir, "runtime-bin");
  const target = join(binDir, process.platform === "win32" ? "node.exe" : "node");
  mkdirSync(binDir, { recursive: true });
  rmSync(target, { force: true });
  try {
    if (process.platform === "win32") linkSync(source, target);
    else {
      // Launching an Electron Helper through a symlink named `node` makes macOS
      // register it as a generic `exec` application. Execute the real helper
      // bundle path instead so its LSUIElement metadata remains effective.
      writeFileSync(target, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(source)} "$@"\n`, { mode: 0o755 });
      chmodSync(target, 0o755);
    }
    Object.defineProperty(process, "execPath", { configurable: true, value: target });
    process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  } catch {
    // Foreground workers can still use Electron's node mode; the packaged smoke
    // test verifies that supported platforms install the headless helper link.
  }
}

installHeadlessNodeExecutable();

attachProcessIpc();
