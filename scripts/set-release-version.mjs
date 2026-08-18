#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const runNumber = process.argv[2] ?? process.env.GITHUB_RUN_NUMBER;
if (!runNumber || !/^\d+$/.test(runNumber)) {
  throw new Error("需要一个数字形式的 GitHub Actions run number。用法：npm run release:version -- 42");
}

const version = `0.1.0-beta.${runNumber}`;
const root = resolve(import.meta.dirname, "..");
const files = [
  ["package.json", (json) => { json.version = version; }],
  ["apps/desktop/package.json", (json) => { json.version = version; }],
  ["package-lock.json", (json) => {
    json.version = version;
    json.packages[""].version = version;
    json.packages["apps/desktop"].version = version;
  }],
];

for (const [relativePath, update] of files) {
  const path = resolve(root, relativePath);
  const json = JSON.parse(await readFile(path, "utf8"));
  update(json);
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
}

console.log(`Release version: ${version}`);
