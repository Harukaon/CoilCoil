import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Which project a workspace's memory belongs to, by name alone.
 *
 * Project memory is filed under one folder per project, named after the project
 * — nothing else. That is deliberately simple, and the cost of it is that two
 * different folders called `project` share one bucket and therefore one memory.
 *
 * The alternative was to give every bucket a durable identity of its own — a
 * recorded path, an inode, a hash — so the two could be told apart no matter
 * what they were called. Every version of that either writes something into the
 * user's own folder, which is not ours to litter, or quietly breaks the moment
 * the folder moves. The decision was to keep the store dumb and let the person
 * importing the folder resolve the clash, since they are the only one who knows
 * whether two things with the same name are the same thing.
 */

/**
 * The name a folder's memory is filed under.
 *
 * Memory follows the project root, so a folder inside a repository is filed
 * under the repository, not under itself. Mirrors `resolveProjectRoot` in
 * `memory-storage.ts`; the two must agree or this guard checks the wrong name.
 */
export function memoryBucketName(path: string): string {
  let current = path;
  while (true) {
    if (existsSync(join(current, ".git"))) return basename(current) || current;
    const parent = dirname(current);
    if (parent === current) return basename(path) || path;
    current = parent;
  }
}

/** Case-insensitive, because the stores these names become folders in are. */
function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

export interface WorkspaceCandidate {
  name: string;
  path: string;
}

export type WorkspaceNameVerdict =
  /** Nothing in the way. */
  | { kind: "ok" }
  /** This exact folder is already open; opening it again is a no-op, not a clash. */
  | { kind: "already-open" }
  /** Another open workspace already answers to this name. */
  | { kind: "name-taken"; name: string; other: string }
  /** No open workspace has the name, but the memory store already holds one. */
  | { kind: "name-remembered"; name: string };

/**
 * Decide whether a folder can be opened under the name it wants.
 *
 * `taken` and `remembered` are bucket names, not paths — see
 * {@link memoryBucketName}. A name already in use by another open workspace is
 * refused outright: allowing it would silently merge two projects' memories,
 * and no wording on a warning makes that recoverable afterwards. A name only
 * the store remembers is merely reported, because the usual reason for it is
 * that this is the same project, moved.
 */
export function checkWorkspaceName(
  candidate: WorkspaceCandidate,
  open: readonly WorkspaceCandidate[],
  remembered: readonly string[],
): WorkspaceNameVerdict {
  if (open.some((project) => project.path === candidate.path)) return { kind: "already-open" };
  const clash = open.find((project) => sameName(project.name, candidate.name));
  if (clash) return { kind: "name-taken", name: candidate.name, other: clash.path };
  if (remembered.some((name) => sameName(name, candidate.name))) {
    return { kind: "name-remembered", name: candidate.name };
  }
  return { kind: "ok" };
}

/** The project names the memory store already holds, or none if it has nothing. */
export function rememberedMemoryNames(memoryRoot: string): string[] {
  try {
    return readdirSync(memoryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** What to put in front of the user for a verdict, or nothing when there is no clash. */
export function workspaceNamePrompt(verdict: WorkspaceNameVerdict): {
  type: "warning" | "info";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  /** The button that means "go ahead"; absent when the answer is simply no. */
  proceedId?: number;
} | undefined {
  if (verdict.kind === "name-taken") {
    return {
      type: "warning",
      title: "工作区重名",
      message: `已经有一个叫「${verdict.name}」的工作区了`,
      detail: `已打开的是：${verdict.other}\n\n项目记忆是按名字存放的，两个同名的工作区会共用同一份记忆，之后就分不清哪条属于谁了。\n\n请先把其中一个文件夹改个名字，再导入。`,
      buttons: ["知道了"],
    };
  }
  if (verdict.kind === "name-remembered") {
    return {
      type: "info",
      title: "找到同名的历史记忆",
      message: `之前有过一个叫「${verdict.name}」的工作区`,
      detail: "如果就是这个项目换了位置，继续导入会接着用原来的记忆。\n\n如果是另一个刚好同名的项目，建议先改个名字再导入，否则两边的记忆会混在一起。",
      buttons: ["取消", "继续导入"],
      proceedId: 1,
    };
  }
  return undefined;
}
