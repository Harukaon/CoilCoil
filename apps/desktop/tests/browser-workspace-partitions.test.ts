import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { browserPartitionFor } from "../src/main/browser-page-policy";
import { BrowserWorkspacePartitions } from "../src/main/browser-workspace-partitions";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-browser-workspaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const alias = join(root, "alias");
  const data = join(root, "data");
  mkdirSync(workspace);
  mkdirSync(data);
  symlinkSync(workspace, alias, "dir");
  const canonical = realpathSync.native(workspace);
  const jar = (partition: string, value: string) => {
    const directory = join(data, "Partitions", partition.slice("persist:".length));
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "Cookies");
    writeFileSync(file, value);
    return file;
  };
  return { workspace, alias, data, canonical, jar };
}

test("first draft alias and subsequent canonical session share one browser partition", (t) => {
  const f = fixture(t);
  const partitions = new BrowserWorkspacePartitions(f.data);
  partitions.remember(f.alias);
  assert.equal(partitions.partitionFor(f.alias), partitions.partitionFor(f.canonical));
  assert.equal(partitions.partitionFor(f.alias), browserPartitionFor(f.canonical));
  assert.notEqual(partitions.partitionFor(f.alias), partitions.partitionFor(join(f.data, "another")));
});

test("existing alias cookie jar remains the same after canonical mounts are persisted and reopened", (t) => {
  const f = fixture(t);
  const oldPartition = browserPartitionFor(f.alias);
  const oldCookies = f.jar(oldPartition, "existing account");
  const partitions = new BrowserWorkspacePartitions(f.data);
  partitions.remember(f.alias);
  assert.equal(partitions.partitionFor(f.canonical), oldPartition);
  const reopened = new BrowserWorkspacePartitions(f.data);
  assert.equal(reopened.partitionFor(f.canonical), oldPartition);
  assert.equal(reopened.partitionFor(f.alias), oldPartition);
  assert.equal(readFileSync(oldCookies, "utf8"), "existing account");
});

test("when both historical jars exist canonical wins without merging or overwriting either account", (t) => {
  const f = fixture(t);
  const oldCookies = f.jar(browserPartitionFor(f.alias), "alias account");
  const canonicalCookies = f.jar(browserPartitionFor(f.canonical), "canonical account");
  const partitions = new BrowserWorkspacePartitions(f.data);
  partitions.remember(f.alias);
  assert.equal(partitions.partitionFor(f.alias), browserPartitionFor(f.canonical));
  assert.equal(readFileSync(oldCookies, "utf8"), "alias account");
  assert.equal(readFileSync(canonicalCookies, "utf8"), "canonical account");
});
