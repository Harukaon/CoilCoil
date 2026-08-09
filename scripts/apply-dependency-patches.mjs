import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function patchPiSubagentsWatchdog() {
  const target = resolve(root, "node_modules/pi-subagents/src/watchdog/runtime.ts");
  const source = await readFile(target, "utf8");
  const before = `\tprivate currentRepoChangeSignature(cwd = this.cwd): WatchdogRepoChangeSignature | undefined {\n\t\treturn this.reviewChangesOnly ? computeWatchdogRepoChangeSignature(cwd) : undefined;\n\t}`;
  const after = `\tprivate currentRepoChangeSignature(cwd = this.cwd): WatchdogRepoChangeSignature | undefined {\n\t\t// The watchdog is opt-in. Avoid synchronously hashing every changed or\n\t\t// untracked file while it is disabled; large workspaces can otherwise\n\t\t// block session restoration for tens of seconds.\n\t\treturn this.reviewChangesOnly && this.isEnabled() ? computeWatchdogRepoChangeSignature(cwd) : undefined;\n\t}`;

  if (source.includes(after)) return;
  if (!source.includes(before)) {
    throw new Error(`pi-subagents watchdog patch no longer applies cleanly: ${target}`);
  }
  await writeFile(target, source.replace(before, after));
}

await patchPiSubagentsWatchdog();
