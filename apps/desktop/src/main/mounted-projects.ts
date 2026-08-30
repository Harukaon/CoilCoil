import { readFileSync, writeFileSync } from "node:fs";

/**
 * 「挂载了哪几个文件夹」这份清单存在磁盘上，而不是只存在网页的 localStorage 里。
 *
 * localStorage 是按来源（origin）分家的：`npm run dev` 跑起来的界面来自
 * http://localhost:5174，装好的 app 来自 file://，两边各存各的。于是在开发版和
 * 安装版之间切一次，侧边栏里的文件夹就像凭空消失了一样——其实是去读了另一个抽屉。
 * 而且浏览器的这块存储被清一次就全没了，用户没有任何办法找回来。
 *
 * 所以真相放在 userData 下的一个 JSON 里，界面那边的 localStorage 退化成缓存：
 * 开机时两边合并，之后每次改动同时写两处。
 *
 * 这里的函数不 import electron，文件路径由调用方给，方便单测。
 */

export interface MountedProject {
  name: string;
  path: string;
  kind: "workspace";
}

/** 清单再长也不该无限长；坏数据写进来时这也是一道闸。 */
const MAX_ENTRIES = 500;

function isMountedProject(value: unknown): value is MountedProject {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string"
    && typeof record.path === "string"
    && record.path.length > 0
    && record.kind === "workspace";
}

/** 只保留认得出来的条目，按路径去重，顺序保持不变。 */
export function normalizeMountedProjects(value: unknown): MountedProject[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: MountedProject[] = [];
  for (const entry of value) {
    if (!isMountedProject(entry) || seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push({ name: entry.name, path: entry.path, kind: "workspace" });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** 读不到、读坏了都当作空清单——启动不能因为这个文件失败。 */
export function readMountedProjects(file: string): MountedProject[] {
  try {
    return normalizeMountedProjects(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/**
 * 写盘，返回真正落盘的那一份。
 *
 * 写失败不抛：这条清单丢一次的代价是用户要重新挂一遍文件夹，而让挂载这个动作
 * 本身报错的代价更大。
 */
export function writeMountedProjects(file: string, value: unknown): MountedProject[] {
  const projects = normalizeMountedProjects(value);
  try {
    writeFileSync(file, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("[projects] 挂载清单写盘失败", error);
  }
  return projects;
}

/**
 * 合并磁盘上那份和界面本地那份。
 *
 * 以界面这一份的顺序为准（那是用户自己拖出来的顺序），磁盘上多出来的挂在后面。
 * 两边都可能是「另一半」——从安装版切到开发版时，磁盘上那份才是全的；刚挂完一
 * 个文件夹还没写盘时，界面这份才是新的。所以是并集，不是谁覆盖谁。
 */
export function mergeMountedProjects(local: unknown, stored: unknown): MountedProject[] {
  return normalizeMountedProjects([...normalizeMountedProjects(local), ...normalizeMountedProjects(stored)]);
}
