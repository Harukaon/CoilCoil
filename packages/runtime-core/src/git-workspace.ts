import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { GitAction, GitBranch, GitCommit, GitCommitFile, GitCommitRef, GitDiff, GitFileChange, GitFileState, GitLog, GitRepository, GitStatus } from "@coilcoil/runtime-protocol";

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

/**
 * 一次最多交给界面多少条改动。
 *
 * 和 VS Code 的 git.statusLimit 一个意思：一个上层文件夹里放着很多小项目时，改动能有
 * 几万条，全交出去界面会卡死，人也看不过来。超过的只报总数，界面提示「改动过多」。
 */
export const GIT_STATUS_LIMIT = 5000;
/** 在工作区里往下找几层子仓库（VS Code 的 git.repositoryScanMaxDepth 默认 1，这里多看一层）。 */
const REPOSITORY_SCAN_DEPTH = 2;
const REPOSITORY_SCAN_LIMIT = 2000;
const REPOSITORY_SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache"]);
const NETWORK_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;

class GitCommandError extends Error {
  constructor(message: string, readonly exitCode: number | undefined, readonly stdout: string) {
    super(message);
  }
}

export function runGit(cwd: string, args: string[], options: { timeout?: number; allowExitCodes?: number[]; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout ?? LOCAL_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...options.env },
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
  const status: GitStatus = { repository: true, root, detached: false, ahead: 0, behind: 0, unborn: false, files: [], total: 0, truncated: false };
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
  status.total = status.files.length;
  return status;
}

/**
 * 仓库现在的状态。未跟踪的文件按文件夹聚合（git 默认的 normal，路径以 `/` 结尾），
 * 最多交出 GIT_STATUS_LIMIT 条，其余只报总数。
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await repositoryRoot(cwd);
  if (!root) return { repository: false, detached: false, ahead: 0, behind: 0, unborn: false, files: [], total: 0, truncated: false };
  return limitStatus(parseGitStatus(await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]), root));
}

/**
 * 超过上限时先留冲突和未跟踪的条目，再按 git 的顺序补满：git 把未跟踪的排在最后，
 * 直接截断的话，几千个已跟踪文件的改动会把「多出来一个没跟踪的小项目」挤出列表，
 * 而那往往正是用户要找的。未跟踪的已经按文件夹聚合，一般没几条。
 */
export function limitStatus(status: GitStatus, limit = GIT_STATUS_LIMIT): GitStatus {
  if (status.files.length <= limit) return status;
  const rank = (file: GitFileChange): number => (file.unstaged === "conflicted" ? 0 : file.unstaged === "untracked" ? 1 : 2);
  const files = status.files.map((file, index) => ({ file, index }))
    .sort((a, b) => rank(a.file) - rank(b.file) || a.index - b.index)
    .slice(0, limit)
    .map(({ file }) => file);
  return { ...status, files, truncated: true };
}

async function gitDiff(cwd: string, path: string, staged: boolean): Promise<GitDiff> {
  const root = await requireRoot(cwd);
  if (path.endsWith("/")) throw new Error("这是一个整体没被跟踪的文件夹，暂存之后才能看到里面每个文件的改动。");
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
  // -d：聚合成一条的未跟踪文件夹（路径以 / 结尾）要连文件夹一起删。
  if (untracked.length) await runGit(root, ["clean", "-f", "-d", "-q", "--", ...untracked]);
  return gitStatus(root);
}

/** 整个仓库一起暂存。列表可能被截断，所以「全部」不能按列表里的条目来。 */
async function stageAll(cwd: string): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  await runGit(root, ["add", "-A"]);
  return gitStatus(root);
}

async function unstageAll(cwd: string): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  const status = await gitStatus(root);
  // 还没有提交时没有 HEAD 可以恢复，取消暂存就是清空索引；否则让索引回到 HEAD，工作区不动。
  await runGit(root, status.unborn ? ["rm", "--cached", "-r", "-q", "--", "."] : ["reset", "-q"]);
  return gitStatus(root);
}

/** 丢弃整个仓库工作区里的改动：已跟踪的回到暂存区的样子，未跟踪的删掉（.gitignore 管的不动）。 */
async function discardAll(cwd: string): Promise<GitStatus> {
  const root = await requireRoot(cwd);
  await runGit(root, ["restore", "--worktree", "--", "."]).catch((error: unknown) => {
    // 一个跟踪文件都没有时 restore 会说 pathspec 不匹配，那就是没有可恢复的。
    if (!(error instanceof GitCommandError && /did not match any file/i.test(error.message))) throw error;
  });
  await runGit(root, ["clean", "-f", "-d", "-q"]);
  return gitStatus(root);
}

/** 同一个文件夹的不同写法（符号链接、macOS 上的 /var 和 /private/var、Windows 的斜杠）算同一个。 */
function samePath(a: string, b: string): boolean {
  const canonical = (path: string): string => {
    try {
      return realpathSync.native(resolve(path));
    } catch {
      return resolve(path);
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * 工作区里的 git 仓库：工作区本身就是仓库根目录时算它，再加上往下 REPOSITORY_SCAN_DEPTH
 * 层子文件夹里的（和 VS Code 的 git.autoRepositoryDetection 一样）。一个上层文件夹里放着
 * 好几个小项目时，界面可以只看其中一个，不用把所有小项目的改动混在一起。
 *
 * 上层文件夹的仓库不算：git 在工作区里找不到仓库会一层层往上找，以前找到上层的就当成
 * 工作区的——还没建 git 的子项目打开 Git 面板，看到的是别的项目的改动和历史，「全部丢弃」
 * 还会删到上层文件夹里别的项目。
 */
async function repositories(cwd: string): Promise<GitRepository[]> {
  const workspace = resolve(cwd);
  const found = new Map<string, GitRepository>();
  const own = await repositoryRoot(workspace);
  if (own && samePath(own, workspace)) found.set(own, { root: own, name: "." });
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > REPOSITORY_SCAN_DEPTH || scanned >= REPOSITORY_SCAN_LIMIT) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || REPOSITORY_SCAN_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      if (++scanned > REPOSITORY_SCAN_LIMIT) return;
      const child = join(dir, entry.name);
      // .git 可能是文件夹，也可能是 worktree / 子模块用的 .git 文件。
      if (existsSync(join(child, ".git")) && !found.has(child)) found.set(child, { root: child, name: relative(workspace, child) || basename(child) });
      walk(child, depth + 1);
    }
  };
  walk(workspace, 1);
  return [...found.values()].sort((a, b) => (a.name === "." ? -1 : b.name === "." ? 1 : a.name.localeCompare(b.name)));
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
export async function runGitAction(cwd: string, action: GitAction): Promise<GitStatus | GitDiff | GitBranch[] | GitLog | GitCommitFile[] | GitRepository[]> {
  switch (action.op) {
    case "status": return gitStatus(cwd);
    case "diff": return gitDiff(cwd, action.path, action.staged);
    case "stage": return stage(cwd, action.paths);
    case "unstage": return unstage(cwd, action.paths);
    case "discard": return discard(cwd, action.paths);
    case "stage_all": return stageAll(cwd);
    case "unstage_all": return unstageAll(cwd);
    case "discard_all": return discardAll(cwd);
    case "repositories": return repositories(cwd);
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
