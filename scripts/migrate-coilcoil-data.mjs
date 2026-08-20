#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migrateLegacyUserData } from "../apps/desktop/src/main/data-migration.ts";

const oldRoot = join(homedir(), "Library", "Application Support", "@suocode", "desktop");
const newRoot = join(homedir(), "Library", "Application Support", "@coilcoil", "desktop");

function runningDesktopApps() {
  if (process.platform !== "darwin") return [];
  try {
    const output = execFileSync("/usr/bin/pgrep", [
      "-afil",
      "/Applications/(SuoCode|CoilCoil)\\.app/Contents/MacOS/(SuoCode|CoilCoil)",
    ], { encoding: "utf8" });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function countSessions(root) {
  const directory = join(root, "sessions");
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length;
}

if (process.platform !== "darwin") {
  console.error("这个手动迁移脚本目前只用于 macOS。其他平台由应用内置迁移处理。");
  process.exit(1);
}

const running = runningDesktopApps();
if (running.length > 0) {
  console.error("请先从菜单栏完全退出 SuoCode 和 CoilCoil，然后重新运行本命令。\n");
  console.error(running.join("\n"));
  process.exit(1);
}

if (!existsSync(oldRoot)) {
  console.error(`没有找到旧版数据目录：${oldRoot}`);
  process.exit(1);
}

console.log(`旧版数据：${oldRoot}`);
console.log(`新版数据：${newRoot}`);
console.log(`旧版会话：${countSessions(oldRoot)} 个`);

const result = migrateLegacyUserData(newRoot);
if (!result.migrated) {
  console.log("没有执行迁移：新版数据已迁移过，或者未找到可迁移的旧会话。");
  process.exit(0);
}

console.log(`迁移完成：${countSessions(newRoot)} 个主会话已进入 CoilCoil。`);
console.log(`复制了 ${result.copied.length} 个文件或目录；${result.skipped.length} 个新版已有文件保持不变。`);
console.log("旧版目录未删除，可在确认 CoilCoil 数据完整后自行备份或清理。");
