import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mergeMountedProjects,
  normalizeMountedProjects,
  readMountedProjects,
  writeMountedProjects,
} from "../src/main/mounted-projects";

/**
 * 挂载的文件夹清单。这里盯的是「用户重新挂一遍」这件事不该发生：
 * 坏文件不能清空清单，写不进盘不能让挂载动作报错，两处存储要能合起来。
 */

const scratch = (): string => join(mkdtempSync(join(tmpdir(), "coilcoil-projects-")), "mounted-projects.json");
const one = { name: "SuoCode", path: "/Users/hao/Desktop/project/SuoCode", kind: "workspace" as const };
const two = { name: "vela", path: "/Users/hao/Desktop/project/vela", kind: "workspace" as const };

test("认不出来的条目被丢掉，认得出来的保持原顺序", () => {
  assert.deepEqual(normalizeMountedProjects([one, two]), [one, two]);
  assert.deepEqual(normalizeMountedProjects([one, { name: "x" }, null, 3, one]), [one]);
  // Home 不是挂载出来的，不该混进这份清单。
  assert.deepEqual(normalizeMountedProjects([{ name: "Home", path: "/h", kind: "home" }]), []);
  assert.deepEqual(normalizeMountedProjects("不是数组"), []);
});

test("文件不存在或者读坏了，都当作空清单而不是让启动失败", () => {
  assert.deepEqual(readMountedProjects(join(tmpdir(), "coilcoil-not-here", "x.json")), []);
  const broken = scratch();
  writeFileSync(broken, "{ 这不是 JSON", "utf8");
  assert.deepEqual(readMountedProjects(broken), []);
});

test("写进去的下次读得回来", () => {
  const file = scratch();
  assert.deepEqual(writeMountedProjects(file, [one, two]), [one, two]);
  assert.deepEqual(readMountedProjects(file), [one, two]);
});

test("磁盘写不进去也不抛，调用方仍然拿到收敛后的清单", () => {
  const unwritable = join(tmpdir(), "coilcoil-no-such-dir", "mounted-projects.json");
  assert.deepEqual(writeMountedProjects(unwritable, [one]), [one]);
});

test("两处存储取并集，本地的顺序打底", () => {
  // 开发版和安装版各存各的 localStorage，谁都可能只有一半，所以不能是覆盖。
  assert.deepEqual(mergeMountedProjects([two], [one]), [two, one]);
  assert.deepEqual(mergeMountedProjects([one], [one]), [one]);
  assert.deepEqual(mergeMountedProjects([], [one, two]), [one, two]);
  assert.deepEqual(mergeMountedProjects([one, two], []), [one, two]);
});
