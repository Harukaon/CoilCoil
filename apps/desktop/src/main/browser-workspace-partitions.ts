import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_PARTITION, browserPartitionFor } from "./browser-page-policy";
import { canonicalWorkspacePath } from "./workspace-path";

/** Keep existing alias cookie jars without moving or merging live Chromium data. */
export class BrowserWorkspacePartitions {
  private readonly file: string;
  private readonly aliases: Record<string, string>;

  constructor(private readonly userData: string) {
    this.file = join(userData, "browser-workspace-partitions.json");
    this.aliases = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    for (const partition of Object.values(this.aliases)) {
      if (typeof partition !== "string" || !/^persist:coilcoil-browser-[0-9a-f]{12}$/.test(partition)) {
        throw new Error("浏览器工作区分区记录格式无效。");
      }
    }
  }

  remember = (path: string): void => {
    const canonical = canonicalWorkspacePath(path);
    if (this.aliases[canonical]) return;
    const current = browserPartitionFor(canonical);
    const previous = browserPartitionFor(path);
    if (current === previous || this.exists(current) || !this.exists(previous)) return;
    this.aliases[canonical] = previous;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.aliases, null, 2)}\n`, "utf8");
    renameSync(temporary, this.file);
  };

  partitionFor = (path?: string): string => {
    if (!path?.trim()) return BROWSER_PARTITION;
    const canonical = canonicalWorkspacePath(path);
    return this.aliases[canonical] ?? browserPartitionFor(canonical);
  };

  private exists(partition: string): boolean {
    return existsSync(join(this.userData, "Partitions", partition.slice("persist:".length)));
  }
}
