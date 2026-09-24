import { execFile } from "node:child_process";
import type { GitAction, GitBranch, GitDiff, GitFileChange, GitFileState, GitStatus } from "@coilcoil/runtime-protocol";

/**
 * 工作区的 git 操作，给界面上的 Git 面板用。
 *
 * 每次都现问 git，不缓存：Agent、终端、用户自己的编辑器随时在改工作区，缓存只会
 * 让面板和真实状态对不上。命令都以仓库根目录运行，路径一律相对根目录，和
 * `git status` 给出的一致。
 *
 * 推送、拉取可能要认证。这里关掉 git 的交互式提示（GIT_TERMINAL_PROMPT=0）：没有
 * 终端能回答它，开着只会让命令一直挂着。凭据交给系统的 credential helper / SSH
 * agent，拿不到就把 git 自己的报错原样交给界面。
 */

const MAX_DIFF_BYTES = 512 * 1024;
const NETWORK_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;

class GitCommandError extends Error {
  constructor(message: string, readonly exitCode: number | undefined, readonly stdout: string) {
    super(message);
  }
}

function runGit(cwd: string, args: string[], options: { timeout?: number; allowExitCodes?: number[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout ?? LOCAL_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const code = typeof error.code === "number" ? error.code : undefined;
      if (code !== undefined && options.allowExitCodes?.includes(code)) return resolve(stdout);
      const detail = (stderr || error.message).trim().split("\n").slice(-20).join("\n");
      const timedOut = error.killed && error.signal === "SIGTERM";
      reject(new GitCommandError(timedOut ? `git ${args[0]} 超时，已停止。${detail ? `\n${detail}` : ""}` : detail || `git ${args[0]} 失败`, code, stdout));
    });
  });
}

async function repositoryRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function requireRoot(cwd: string): Promise<string> {
  const root = await repositoryRoot(cwd);
  if (!root) throw new Error("这个工作区不在 git 仓库里。");
  return root;
}

function fileState(letter: string): GitFileState | undefined {
  switch (letter) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type-changed";
    case "U": return "conflicted";
    default: return undefined;
  }
}

/** 解析 `git status --porcelain=v2 --branch -z`。 */
export function parseGitStatus(output: string, root: string): GitStatus {
  const status: GitStatus = { repository: true, root, detached: false, ahead: 0, behind: 0, unborn: false, files: [] };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") status.unborn = value === "(initial)";
      else if (key === "branch.head") {
        status.detached = value === "(detached)";
        status.branch = status.detached ? undefined : value;
      } else if (key === "branch.upstream") status.upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === "?") {
      status.files.push({ path: record.slice(2), unstaged: "untracked" });
    } else if (kind === "1" || kind === "2") {
      // 1 XY sub mH mI mW hH hI path  /  2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const fields = record.split(" ");
      const xy = fields[1] ?? "..";
      const path = fields.slice(kind === "1" ? 8 : 9).join(" ");
      const change: GitFileChange = { path, staged: fileState(xy[0] ?? "."), unstaged: fileState(xy[1] ?? ".") };
      if (kind === "2") {
        change.originalPath = records[index + 1];
        index += 1;
      }
      status.files.push(change);
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const path = record.split(" ").slice(10).join(" ");
      status.files.push({ path, unstaged: "conflicted" });
    }
  }
  return status;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await repositoryRoot(cwd);
  if (!root) return { repository: false, detached: false, ahead: 0, behind: 0, unborn: false, files: [] };
  return parseGitStatus(await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]), root);
}

async function gitDiff(cwd: string, path: string, staged: boolean): Promise<GitDiff> {
  const root = await requireRoot(cwd);
  const status = await gitStatus(root);
  const untracked = !staged && status.files.some((file) => file.path === path && file.unstaged === "untracked");
  const args = untracked
    // 未跟踪的文件没有「原来的版本」，拿空文件比，得到的就是整份新增。
    ? ["diff", "--no-ext-diff", "--no-color", "-U3", "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", path]
    : ["diff", "--no-ext-diff", "--no-color", "-U3", ...staged ? ["--cached"] : [], "--", path];
  // --no-index 有差异时退出码是 1，这不是出错。
  const output = await runGit(root, args, { allowExitCodes: untracked ? [1] : [] });
  const truncated = Buffer.byteLength(output) > MAX_DIFF_BYTES;
  return {
    path,
    staged,
    patch: truncated ? output.slice(0, MAX_DIFF_BYTES) : output,
    binary: /^Binary files .* differ$/m.test(output),
    truncated,
  };
}

async function stage(cwd: string, paths: string[]): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  if (paths.length) await runGit(root, ["add", "-A", "--", ...paths]);
  return gitStatus(root);
}

async function unstage(cwd: string, paths: string[]): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  if (paths.length) {
    const status = await gitStatus(root);
    // 还没有提交时没有 HEAD 可以恢复，取消暂存就是从索引里拿掉。
    await runGit(root, status.unborn ? ["rm", "--cached", "-r", "-q", "--", ...paths] : ["restore", "--staged", "--", ...paths]);
  }
  return gitStatus(root);
}

async function discard(cwd: string, paths: string[]): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  const status = await gitStatus(root);
  const wanted = new Set(paths);
  const untracked = status.files.filter((file) => wanted.has(file.path) && file.unstaged === "untracked").map((file) => file.path);
  const tracked = status.files.filter((file) => wanted.has(file.path) && file.unstaged && file.unstaged !== "untracked").map((file) => file.path);
  if (tracked.length) await runGit(root, ["restore", "--worktree", "--", ...tracked]);
  if (untracked.length) await runGit(root, ["clean", "-f", "-q", "--", ...untracked]);
  return gitStatus(root);
}

async function commit(cwd: string, message: string, stageAll: boolean): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  if (!message.trim()) throw new Error("请先写提交说明。");
  let status = await gitStatus(root);
  const hasStaged = status.files.some((file) => file.staged);
  if (!hasStaged) {
    if (!stageAll || status.files.length === 0) throw new Error("没有可以提交的改动。");
    await runGit(root, ["add", "-A"]);
  }
  await runGit(root, ["commit", "-m", message]);
  status = await gitStatus(root);
  return status;
}

async function push(cwd: string): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  const status = await gitStatus(root);
  if (!status.branch) throw new Error("当前不在任何分支上（分离 HEAD），没法推送。");
  if (status.upstream) {
    await runGit(root, ["push"], { timeout: NETWORK_TIMEOUT_MS });
  } else {
    const remotes = (await runGit(root, ["remote"])).split("\n").map((line) => line.trim()).filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) throw new Error("这个仓库还没有配置远程仓库。");
    // 第一次推送顺手设好上游，之后的领先 / 落后和推送都跟着它。
    await runGit(root, ["push", "-u", remote, status.branch], { timeout: NETWORK_TIMEOUT_MS });
  }
  return gitStatus(root);
}

async function pull(cwd: string): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  // 只快进：本地和远程分叉时不替用户做合并，报错让他自己决定怎么处理。
  await runGit(root, ["pull", "--ff-only"], { timeout: NETWORK_TIMEOUT_MS });
  return gitStatus(root);
}

async function branches(cwd: string): Promise<GitBranch[]> {
  const root = await requireRoot(cwd);
  const output = await runGit(root, ["for-each-ref", "--format=%(refname:short)%00%(upstream:short)%00%(HEAD)", "refs/heads"]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [name = "", upstream = "", head = ""] = line.split("\0");
    return { name, ...upstream ? { upstream } : {}, current: head === "*" };
  });
}

async function checkout(cwd: string, branch: string): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  if (!branch.trim() || branch.startsWith("-")) throw new Error(`「${branch}」不是合法的分支名。`);
  await runGit(root, ["switch", branch]).catch(async (error: unknown) => {
    // 比 2.23 还老的 git 没有 switch。
    if (error instanceof GitCommandError && /is not a git command|unknown subcommand/i.test(error.message)) {
      await runGit(root, ["checkout", branch]);
      return;
    }
    throw error;
  });
  return gitStatus(root);
}

async function createBranch(cwd: string, name: string): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  const trimmed = name.trim();
  try {
    await runGit(root, ["check-ref-format", "--branch", trimmed]);
  } catch {
    throw new Error(`「${trimmed}」不是合法的分支名。`);
  }
  await runGit(root, ["switch", "-c", trimmed]);
  return gitStatus(root);
}

/** Git 面板的每个操作。改动类操作都返回改完之后的状态，面板不用再问一次。 */
export async function runGitAction(cwd: string, action: GitAction): Promise<GitStatus | GitDiff | GitBranch[]> {
  switch (action.op) {
    case "status": return gitStatus(cwd);
    case "diff": return gitDiff(cwd, action.path, action.staged);
    case "stage": return stage(cwd, action.paths);
    case "unstage": return unstage(cwd, action.paths);
    case "discard": return discard(cwd, action.paths);
    case "commit": return commit(cwd, action.message, action.stageAll === true);
    case "push": return push(cwd);
    case "pull": return pull(cwd);
    case "branches": return branches(cwd);
    case "checkout": return checkout(cwd, action.branch);
    case "create_branch": return createBranch(cwd, action.name);
    default: {
      const exhaustive: never = action;
      throw new Error(`未知 git 操作：${(exhaustive as { op?: string }).op ?? "unknown"}`);
    }
  }
}
