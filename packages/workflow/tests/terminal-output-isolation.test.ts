import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createTerminalRunToken,
  outputPathFor,
  pruneTerminalOutput,
  TERMINAL_OUTPUT_RETENTION_MS,
} from "../extensions/terminal/results.ts";

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "coilcoil-terminal-output-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("two extension instances never share a term-1 output file", async () => {
  await withAgentDir(async () => {
    // Terminal ids restart at term-1 in every session, so only the run token
    // keeps one project's shell output out of another project's log.
    const first = outputPathFor(createTerminalRunToken(), "term-1");
    const second = outputPathFor(createTerminalRunToken(), "term-1");
    assert.notEqual(first, second);
    assert.notEqual(dirname(first), dirname(second));
    assert.ok(existsSync(dirname(first)) && existsSync(dirname(second)));
  });
});

test("a single run keeps its terminals side by side in one directory", async () => {
  await withAgentDir(async () => {
    const token = createTerminalRunToken();
    assert.equal(dirname(outputPathFor(token, "term-1")), dirname(outputPathFor(token, "term-2")));
  });
});

test("pruning drops expired runs and the legacy shared logs, keeping fresh ones", async () => {
  await withAgentDir(async (agentDir) => {
    const root = join(agentDir, "terminal-output");
    const stale = join(root, "stale-run");
    const fresh = join(root, "fresh-run");
    await mkdir(stale, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await writeFile(join(stale, "term-1.log"), "old");
    await writeFile(join(fresh, "term-1.log"), "new");
    // The flat files predate run isolation: they are the ones holding output
    // appended by unrelated projects, so age does not save them.
    const legacy = join(root, "term-1.log");
    await writeFile(legacy, "mixed");

    const expired = Date.now() - TERMINAL_OUTPUT_RETENTION_MS - 60_000;
    await utimes(stale, expired / 1_000, expired / 1_000);

    const removed = pruneTerminalOutput();
    assert.deepEqual(removed.sort(), [legacy, stale].sort());
    assert.ok(!existsSync(stale) && !existsSync(legacy));
    assert.ok((await stat(fresh)).isDirectory());
  });
});

test("pruning is a no-op when no terminal has ever run", async () => {
  await withAgentDir(async () => {
    assert.deepEqual(pruneTerminalOutput(), []);
  });
});
