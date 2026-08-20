import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function gitError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function findGitRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return root || undefined;
  } catch {
    return undefined;
  }
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`子 Agent 运行标识无效：${runId}`);
  }
}

export function subagentWorktreeBranch(runId: string): string {
  assertRunId(runId);
  return `coilcoil/subagent/${runId}`;
}

export async function subagentWorktreePath(repoRoot: string, runId: string): Promise<string> {
  assertRunId(runId);
  const gitDir = await git(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) throw new Error("无法定位 git 管理目录。");
  return join(gitDir, "coilcoil-worktrees", runId);
}

export interface CreatedWorktree {
  worktreePath: string;
  branch: string;
}

export async function createSubagentWorktree(repoRoot: string, runId: string): Promise<CreatedWorktree> {
  const worktreePath = await subagentWorktreePath(repoRoot, runId);
  const branch = subagentWorktreeBranch(runId);
  try {
    await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath]);
  } catch (error) {
    throw new Error(`git worktree 创建失败：${gitError(error)}`);
  }
  return { worktreePath, branch };
}

export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  try {
    return (await git(worktreePath, ["status", "--porcelain"])) === "";
  } catch {
    return false;
  }
}

export async function removeSubagentWorktreeIfClean(repoRoot: string, worktreePath: string): Promise<boolean> {
  if (!(await isWorktreeClean(worktreePath))) return false;
  try {
    await git(repoRoot, ["worktree", "remove", worktreePath]);
    return true;
  } catch {
    return false;
  }
}
