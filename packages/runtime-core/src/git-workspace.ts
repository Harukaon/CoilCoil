import { execFile } from "node:child_process";
import type { GitAction, GitBranch, GitCommit, GitCommitFile, GitCommitRef, GitDiff, GitFileChange, GitFileState, GitLog, GitStatus } from "@coilcoil/runtime-protocol";

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
      if (key === "branch.oid") {
        status.unborn = value === "(initial)";
        status.head = status.unborn ? undefined : value;
      }
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
  return diffResult(path, staged, output);
}

function diffResult(path: string, staged: boolean, output: string, commit?: string): GitDiff {
  const truncated = Buffer.byteLength(output) > MAX_DIFF_BYTES;
  return {
    path,
    staged,
    ...commit ? { commit } : {},
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

const LOG_FIELDS = ["%H", "%h", "%P", "%an", "%ae", "%at", "%D", "%s", "%b"].join("%x1f");

/** 解析 `--decorate=full` 下的 `%D`：「HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1」。 */
export function parseCommitRefs(decoration: string): GitCommitRef[] {
  const refs: GitCommitRef[] = [];
  for (const raw of decoration.split(", ").map((part) => part.trim()).filter(Boolean)) {
    if (raw === "HEAD") {
      refs.push({ name: "HEAD", fullName: "HEAD", kind: "head" });
      continue;
    }
    const fullName = raw.replace(/^HEAD -> /, "").replace(/^tag: /, "");
    if (fullName.startsWith("refs/heads/")) refs.push({ name: fullName.slice(11), fullName, kind: "branch" });
    // origin/HEAD 只是远程默认分支的别名，画出来只会和 origin/main 重复。
    else if (fullName.startsWith("refs/remotes/") && !fullName.endsWith("/HEAD")) refs.push({ name: fullName.slice(13), fullName, kind: "remote" });
    else if (fullName.startsWith("refs/tags/")) refs.push({ name: fullName.slice(10), fullName, kind: "tag" });
  }
  return refs;
}

export function parseGitLog(output: string): GitCommit[] {
  return output.split("\0").filter((record) => record.trim()).map((record) => {
    const [hash = "", shortHash = "", parents = "", author = "", email = "", time = "0", decoration = "", subject = "", body = ""] = record.replace(/^\n/, "").split("\x1f");
    return {
      hash,
      shortHash,
      parents: parents.split(" ").filter(Boolean),
      author,
      email,
      date: Number(time) * 1000,
      subject,
      body: body.trim(),
      refs: parseCommitRefs(decoration),
    };
  });
}

async function optionalGit(root: string, args: string[]): Promise<string | undefined> {
  try {
    return (await runGit(root, args)).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function log(cwd: string, limit: number, all: boolean): Promise<GitLog> {
  const root = await requireRoot(cwd);
  const status = await gitStatus(root);
  if (status.unborn) return { commits: [], hasMore: false };
  const currentRef = status.branch ? `refs/heads/${status.branch}` : undefined;
  const upstreamRef = status.upstream ? await optionalGit(root, ["rev-parse", "--symbolic-full-name", "@{upstream}"]) : undefined;
  const count = Math.max(1, Math.min(Math.floor(limit), 2000));
  // 默认和 VS Code 的图一样只看当前分支和它的上游：本地和远程分叉时两条线都在。
  const revisions = all ? ["--exclude=refs/stash", "--all"] : ["HEAD", ...upstreamRef ? [upstreamRef] : []];
  const output = await runGit(root, ["log", "--topo-order", "--decorate=full", "-z", `--format=${LOG_FIELDS}`, "-n", String(count + 1), ...revisions, "--"]);
  const commits = parseGitLog(output);
  return { commits: commits.slice(0, count), hasMore: commits.length > count, head: status.head, currentRef, upstreamRef };
}

function requireHash(hash: string): string {
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error(`「${hash}」不是提交哈希。`);
  return hash;
}

async function commitParents(root: string, hash: string): Promise<string[]> {
  const [, ...parents] = (await runGit(root, ["rev-list", "--parents", "-n", "1", requireHash(hash)])).trim().split(" ");
  return parents;
}

/** 解析 `--name-status -z`：改名和复制带两个路径（原路径在前）。 */
export function parseNameStatus(output: string): GitCommitFile[] {
  const tokens = output.split("\0");
  const files: GitCommitFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const code = tokens[index];
    if (!code) continue;
    const state = fileState(code[0] ?? "") ?? "modified";
    if (code[0] === "R" || code[0] === "C") {
      files.push({ path: tokens[index + 2] ?? "", originalPath: tokens[index + 1], state });
      index += 2;
    } else {
      files.push({ path: tokens[index + 1] ?? "", state });
      index += 1;
    }
  }
  return files;
}

async function commitFiles(cwd: string, hash: string): Promise<GitCommitFile[]> {
  const root = await requireRoot(cwd);
  const parents = await commitParents(root, hash);
  // 合并提交也只和第一个父提交比：看的是「这次合并给主线带来了什么」。
  const output = parents[0]
    ? await runGit(root, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", parents[0], hash])
    : await runGit(root, ["diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-z", "-M", hash]);
  return parseNameStatus(output);
}

async function commitDiff(cwd: string, hash: string, path: string, originalPath?: string): Promise<GitDiff> {
  const root = await requireRoot(cwd);
  const parents = await commitParents(root, hash);
  const paths = originalPath && originalPath !== path ? [originalPath, path] : [path];
  const output = parents[0]
    ? await runGit(root, ["diff", "--no-ext-diff", "--no-color", "-U3", "-M", parents[0], hash, "--", ...paths])
    : await runGit(root, ["show", "--format=", "--no-ext-diff", "--no-color", "-U3", hash, "--", path]);
  return diffResult(path, false, output, hash);
}

/** Git 面板的每个操作。改动类操作都返回改完之后的状态，面板不用再问一次。 */
export async function runGitAction(cwd: string, action: GitAction): Promise<GitStatus | GitDiff | GitBranch[] | GitLog | GitCommitFile[]> {
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
    case "log": return log(cwd, action.limit ?? 50, action.all === true);
    case "commit_files": return commitFiles(cwd, action.hash);
    case "commit_diff": return commitDiff(cwd, action.hash, action.path, action.originalPath);
    default: {
      const exhaustive: never = action;
      throw new Error(`未知 git 操作：${(exhaustive as { op?: string }).op ?? "unknown"}`);
    }
  }
}
