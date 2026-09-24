import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import type { GitCommitFile } from "@coilcoil/runtime-protocol";
import { parseNameStatus, runGit } from "./git-workspace.js";

/**
 * 检查点：每条用户消息发出前，把工作区的文件存一份快照，编辑历史消息时可以把代码
 * 退回到那条消息发出时的样子。
 *
 * 快照存在 CoilCoil 自己的「影子 git 仓库」里（数据目录下，每个工作区一个），和用户
 * 自己的仓库完全分开：`--git-dir` 指向影子仓库，`--work-tree` 指向工作区。用户的
 * `.git`、分支、暂存区、提交历史一概不碰，工作区不是 git 仓库也照样能用。
 *
 * 跟着工作区里的 `.gitignore` 走（node_modules 这类不存），另外默认排除一批常见的
 * 依赖和缓存目录，免得没写 `.gitignore` 的工作区第一次快照就把依赖整个复制一遍。
 *
 * 已知的限制：工作区里嵌套的 git 仓库（子目录里另有 `.git`）只记成一个指针，里面的
 * 文件不进快照，回退时也不动它们。
 */

const SNAPSHOT_TIMEOUT_MS = 60_000;
const BRANCH = "refs/heads/checkpoints";

const DEFAULT_EXCLUDES = [
  "node_modules/", ".venv/", "venv/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
  ".next/", ".nuxt/", ".turbo/", ".parcel-cache/", ".gradle/", ".DS_Store", "Thumbs.db",
];

const IDENTITY = {
  GIT_AUTHOR_NAME: "CoilCoil",
  GIT_AUTHOR_EMAIL: "checkpoint@coilcoil.local",
  GIT_COMMITTER_NAME: "CoilCoil",
  GIT_COMMITTER_EMAIL: "checkpoint@coilcoil.local",
};

/** 同一个影子仓库的 git 命令排队跑：两个会话同时快照会抢 index.lock。 */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

/** 家目录、磁盘根目录这种「工作区」太大，不做快照。 */
export function checkpointsSupported(cwd: string): boolean {
  const target = resolve(cwd);
  return target !== resolve(homedir()) && target !== parse(target).root;
}

export class CheckpointStore {
  readonly gitDir: string;

  constructor(readonly cwd: string, dataDir: string) {
    const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
    this.gitDir = resolve(dataDir, "checkpoints", key);
  }

  /** 所有命令都指向影子仓库；用户自己仓库的配置（钩子、签名、换行转换）一概不生效。 */
  private git(args: string[], options: { allowExitCodes?: number[] } = {}): Promise<string> {
    return runGit(this.cwd, [
      `--git-dir=${this.gitDir}`, `--work-tree=${this.cwd}`,
      "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=false",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=",
      ...args,
    ], { ...options, timeout: SNAPSHOT_TIMEOUT_MS, env: IDENTITY });
  }

  private async ensureRepository(): Promise<void> {
    if (existsSync(join(this.gitDir, "HEAD"))) return;
    mkdirSync(this.gitDir, { recursive: true });
    await runGit(this.cwd, ["init", "-q", "--bare", "--template=", this.gitDir]);
    await this.git(["config", "core.bare", "false"]);
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`);
    // 给翻数据目录的人看这个影子仓库是哪个工作区的。
    writeFileSync(join(this.gitDir, "coilcoil-workspace"), `${resolve(this.cwd)}\n`);
  }

  /** 把工作区现在的样子读进影子仓库的索引，返回对应的树。 */
  private async indexWorkspace(): Promise<string> {
    await this.ensureRepository();
    // 个别文件读不了（权限、正在被写）不该让整份快照失败：跳过它们，其余照存。
    await this.git(["add", "-A", "--ignore-errors", "--", "."], { allowExitCodes: [1] });
    return (await this.git(["write-tree"])).trim();
  }

  private async commitTree(tree: string): Promise<string> {
    const parent = (await this.git(["rev-parse", "-q", "--verify", BRANCH], { allowExitCodes: [1] })).trim();
    if (parent) {
      // 和上一个快照一模一样就直接复用：连着问几句话、中间没改文件，不用存几份。
      const parentTree = (await this.git(["rev-parse", `${parent}^{tree}`])).trim();
      if (parentTree === tree) return parent;
    }
    const commit = (await this.git(["commit-tree", tree, ...parent ? ["-p", parent] : [], "-m", "checkpoint"])).trim();
    // 挂在一条分支上，快照才不会被 git 当垃圾回收掉。
    await this.git(["update-ref", BRANCH, commit]);
    return commit;
  }

  /** 存一份工作区现在的快照，返回快照的提交哈希。 */
  snapshot(): Promise<string> {
    return serialized(this.gitDir, async () => this.commitTree(await this.indexWorkspace()));
  }

  /** 从快照到现在，工作区里哪些文件变了（状态是「相对快照」的：A 是之后新加的）。 */
  changesSince(commit: string): Promise<GitCommitFile[]> {
    return serialized(this.gitDir, async () => {
      await this.indexWorkspace();
      return parseNameStatus(await this.git(["diff", "--cached", "--name-status", "-z", "--no-renames", commit, "--"]));
    });
  }

  /**
   * 把工作区退回到快照。退之前先把现在的样子也存一份（返回的 `backup`），万一退错了
   * 还找得回来。只动快照管得到的文件：被忽略的（node_modules 之类）原样不动。
   */
  restore(commit: string): Promise<{ backup: string; files: GitCommitFile[] }> {
    return serialized(this.gitDir, async () => {
      const backup = await this.commitTree(await this.indexWorkspace());
      const files = parseNameStatus(await this.git(["diff", "--cached", "--name-status", "-z", "--no-renames", commit, "--"]));
      // 索引现在就是工作区的样子；--reset -u 让索引和工作区都变成快照里的样子，
      // 之后新加的文件会被删掉，改过、删掉的文件会恢复。
      await this.git(["read-tree", "--reset", "-u", commit]);
      return { backup, files };
    });
  }
}
