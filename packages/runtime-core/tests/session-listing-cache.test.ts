import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionListingCache, directorySignature } from "../src/session-listing-cache.js";

function sessionDir(): string {
  return mkdtempSync(join(tmpdir(), "coilcoil-listing-"));
}

function writeSession(directory: string, name: string, content = "{}\n"): string {
  const path = join(directory, `${name}.jsonl`);
  writeFileSync(path, content, "utf8");
  return path;
}

test("目录没动过就不再读一遍", async () => {
  // pi 的列表要把每个会话文件逐行读完，几百个会话就是几百兆、将近一秒；
  // 而 stat 一遍只要两毫秒。
  const directory = sessionDir();
  writeSession(directory, "a");
  writeSession(directory, "b");

  const cache = new SessionListingCache<string>();
  let loads = 0;
  const load = async (): Promise<string[]> => { loads += 1; return ["one"]; };

  assert.deepEqual(await cache.list("cwd", directory, load), ["one"]);
  assert.deepEqual(await cache.list("cwd", directory, load), ["one"]);
  assert.deepEqual(await cache.list("cwd", directory, load), ["one"]);
  assert.equal(loads, 1, "重复问同一个问题不该重复扫盘");
});

test("会话长了一行就重新读", async () => {
  const directory = sessionDir();
  const path = writeSession(directory, "a");
  const cache = new SessionListingCache<string>();
  let loads = 0;
  const load = async (): Promise<string[]> => { loads += 1; return [`load-${loads}`]; };

  await cache.list("cwd", directory, load);
  appendFileSync(path, "{\"more\":1}\n", "utf8");
  assert.deepEqual(await cache.list("cwd", directory, load), ["load-2"]);
  assert.equal(loads, 2);
});

test("新增和删除会话都会让缓存失效", async () => {
  const directory = sessionDir();
  writeSession(directory, "a");
  const cache = new SessionListingCache<string>();
  let loads = 0;
  const load = async (): Promise<string[]> => { loads += 1; return [`load-${loads}`]; };

  await cache.list("cwd", directory, load);
  writeSession(directory, "b");
  await cache.list("cwd", directory, load);
  assert.equal(loads, 2, "新会话没有让缓存失效");

  rmSync(join(directory, "b.jsonl"));
  await cache.list("cwd", directory, load);
  assert.equal(loads, 3, "删掉会话没有让缓存失效");
});

test("同时问三次只扫一次盘", async () => {
  // 打开工作区时正是好几个调用方在同一刻问同一个问题，让它们各扫一遍是最糟的做法。
  const directory = sessionDir();
  writeSession(directory, "a");
  const cache = new SessionListingCache<string>();
  let loads = 0;
  const load = async (): Promise<string[]> => {
    loads += 1;
    await new Promise((done) => setTimeout(done, 20));
    return ["shared"];
  };

  const results = await Promise.all([
    cache.list("cwd", directory, load),
    cache.list("cwd", directory, load),
    cache.list("cwd", directory, load),
  ]);
  assert.deepEqual(results, [["shared"], ["shared"], ["shared"]]);
  assert.equal(loads, 1);
});

test("不同工作区各拿各的答案", async () => {
  // 列表是按工作区过滤过的，两个项目共用一个会话目录时不能互相串答案。
  const directory = sessionDir();
  writeSession(directory, "a");
  const cache = new SessionListingCache<string>();

  assert.deepEqual(await cache.list("/项目甲", directory, async () => ["甲"]), ["甲"]);
  assert.deepEqual(await cache.list("/项目乙", directory, async () => ["乙"]), ["乙"]);
  // 各自都还在缓存里。
  assert.deepEqual(await cache.list("/项目甲", directory, async () => ["不该被调用"]), ["甲"]);
});

test("目录变了，所有工作区的缓存一起作废", async () => {
  const directory = sessionDir();
  writeSession(directory, "a");
  const cache = new SessionListingCache<string>();
  await cache.list("/项目甲", directory, async () => ["旧"]);
  await cache.list("/项目乙", directory, async () => ["旧"]);

  writeSession(directory, "b");
  assert.deepEqual(await cache.list("/项目甲", directory, async () => ["新"]), ["新"]);
  assert.deepEqual(await cache.list("/项目乙", directory, async () => ["新"]), ["新"]);
});

test("扫盘途中目录变了，这次结果不进缓存", async () => {
  const directory = sessionDir();
  writeSession(directory, "a");
  const cache = new SessionListingCache<string>();
  let loads = 0;

  const result = await cache.list("cwd", directory, async () => {
    loads += 1;
    // 扫到一半又写进来一个会话——这次的结果已经不完整了。
    writeSession(directory, `mid-${loads}`);
    return [`load-${loads}`];
  });
  assert.deepEqual(result, ["load-1"]);

  await cache.list("cwd", directory, async () => { loads += 1; return [`load-${loads}`]; });
  assert.ok(loads >= 2, "半路失效的结果不该被当成有效缓存");
});

test("目录不存在是一个稳定答案，不是错误", () => {
  assert.equal(directorySignature("/definitely/not/here"), "missing");
  assert.equal(directorySignature("/definitely/not/here"), "missing");
});

test("签名只看名字、大小和时间，不读内容", () => {
  const directory = sessionDir();
  writeSession(directory, "a", "x".repeat(100));
  const before = directorySignature(directory);
  assert.match(before, /^a\.jsonl:100:\d+$/);
  // 非 jsonl 的邻居不参与——记录文件就住在旁边。
  writeFileSync(join(directory, "a.transcript.md"), "无关", "utf8");
  assert.equal(directorySignature(directory), before);
});

test("手动作废之后会重新扫一次", async () => {
  const directory = sessionDir();
  writeSession(directory, "a");
  const cache = new SessionListingCache<string>();
  let loads = 0;
  const load = async (): Promise<string[]> => { loads += 1; return [`load-${loads}`]; };

  await cache.list("cwd", directory, load);
  cache.invalidate();
  await cache.list("cwd", directory, load);
  assert.equal(loads, 2);
});
