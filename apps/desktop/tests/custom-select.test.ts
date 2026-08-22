import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { nextEnabledOptionIndex, type SelectOption } from "../src/renderer/src/ui/Select.tsx";

function rendererTsxFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return rendererTsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

test("every renderer dropdown uses CoilCoil's shared Select instead of native browser menus", () => {
  const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
  const offenders = rendererTsxFiles(rendererRoot).flatMap((path) => (
    /<select\b/.test(readFileSync(path, "utf8")) ? [relative(rendererRoot, path)] : []
  ));
  assert.deepEqual(offenders, []);
});

test("Select keyboard navigation skips disabled options and wraps", () => {
  const options: SelectOption[] = [
    { value: "inherit", label: "继承" },
    { value: "missing", label: "不可用", disabled: true },
    { value: "configured", label: "已配置" },
  ];
  assert.equal(nextEnabledOptionIndex(options, -1, 1), 0);
  assert.equal(nextEnabledOptionIndex(options, 0, 1), 2);
  assert.equal(nextEnabledOptionIndex(options, 2, 1), 0);
  assert.equal(nextEnabledOptionIndex(options, 0, -1), 2);
  assert.equal(nextEnabledOptionIndex([{ value: "x", label: "X", disabled: true }], -1, 1), -1);
  assert.equal(nextEnabledOptionIndex([], -1, 1), -1);
});
