import { attachProcessIpc } from "@suocode/runtime-server";
import { existsSync, linkSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

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
    else symlinkSync(source, target);
    Object.defineProperty(process, "execPath", { configurable: true, value: target });
    process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  } catch {
    // Foreground workers can still use Electron's node mode; the packaged smoke
    // test verifies that supported platforms install the headless helper link.
  }
}

installHeadlessNodeExecutable();

attachProcessIpc();
