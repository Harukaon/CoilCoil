import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 检查点的文件备份放在哪：一个只存 blob 的 git 对象库（数据目录下 `file-history/`）。
 *
 * 备份策略和 Claude Code 一样——Agent 用编辑工具改一个文件之前，把它原来的内容存一份；
 * 这里只是把「存一份」换成 git 对象：内容相同只存一次（同一个文件被备份一百次、每次
 * 只改一行，存的也只是那些不同的版本），而且是压缩的。只用 `hash-object -w` 写、
 * `cat-file` 读，不建分支、不做提交，也不碰任何工作区和用户自己的仓库。
 *
 * 所有备份都是没人引用的松散对象，所以留多久就是「文件多旧」：每天最多清一次超过
 * 30 天的（Claude Code 默认也留 30 天）。同样的内容再存一次，git 会刷新它的时间，
 * 还在用的版本不会被清掉。
 */

/** 太大的文件不备份（记成跳过），免得一次编辑存几百兆。 */
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const RETENTION = "30.days.ago";
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 30_000;

export class FileHistoryStore {
  readonly gitDir: string;
  private ready?: Promise<void>;

  constructor(agentDir: string) {
    this.gitDir = resolve(agentDir, "file-history");
  }

  /** 存一份内容，返回它的 blob 哈希。 */
  async save(content: Buffer): Promise<string> {
    await this.ensure();
    const hash = (await this.git(["hash-object", "-w", "--stdin"], content)).toString("utf8").trim();
    this.pruneOccasionally();
    return hash;
  }

  /** 读回一份内容；已经被清掉（或从没存过）返回 undefined。 */
  async read(blob: string): Promise<Buffer | undefined> {
    if (!this.has(blob)) return undefined;
    return this.git(["cat-file", "blob", blob]);
  }

  /** 这份备份还在不在。备份只会是松散对象（从不打包），看文件在不在就行，不用起 git。 */
  has(blob: string): boolean {
    return /^[0-9a-f]{40}$/.test(blob) && existsSync(join(this.gitDir, "objects", blob.slice(0, 2), blob.slice(2)));
  }

  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      if (existsSync(join(this.gitDir, "HEAD"))) return;
      mkdirSync(this.gitDir, { recursive: true });
      await this.git(["init", "-q", "--bare", "--template=", "--object-format=sha1", this.gitDir], undefined, false);
      // 自动 gc 会把松散对象打包，打包后按时间清理和 `has` 都不成立了。
      await this.git(["config", "gc.auto", "0"]);
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private pruneOccasionally(): void {
    const marker = join(this.gitDir, "coilcoil-last-prune");
    try {
      if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < PRUNE_INTERVAL_MS) return;
      writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch {
      return;
    }
    void this.git(["prune", `--expire=${RETENTION}`]).catch(() => undefined);
  }

  private git(args: string[], input?: Buffer, inRepository = true): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile("git", inRepository ? [`--git-dir=${this.gitDir}`, ...args] : args, {
        encoding: "buffer",
        maxBuffer: MAX_BACKUP_BYTES * 2,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.toString("utf8").trim() || error.message));
        else resolvePromise(stdout);
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
  }
}

/** 和 `git hash-object` 算出来的一样；只是比较「现在的内容和备份是不是同一份」，不必起 git。 */
export function blobHash(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
