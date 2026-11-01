import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiagnosticLog } from "@coilcoil/diagnostics";
import type { CoilCoilRuntime } from "@coilcoil/runtime-core";
import type { DiagnosticLogEntry } from "@coilcoil/runtime-protocol";
import { RuntimeServer } from "../src/index.js";

for (const type of ["create_session", "open_session"] as const) {
  test(`${type} preserves the initialization error and records cleanup failure with runtime identity`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "coil-server-cleanup-error-"));
    const log = new DiagnosticLog({ directory: join(root, "logs"), process: "runtime", echo: false });
    const runtimes: Array<{ disposeCalls: number }> = [];
    const server = new RuntimeServer({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), log }, () => {}, {
      createRuntime() {
        const ordinal = runtimes.length;
        const runtime = {
          disposeCalls: 0,
          async sharedModelRuntime() { return {}; },
          async createSession() { throw new Error("initialization failed"); },
          async openSession() { throw new Error("initialization failed"); },
          async dispose() { this.disposeCalls += 1; if (ordinal > 0) throw new Error("cleanup failed"); },
        };
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => "failed-runtime",
    });
    t.after(async () => { await server.dispose(); rmSync(root, { recursive: true, force: true }); });
    const sessionPath = join(root, "session.jsonl");
    const command = type === "open_session" ? { type, cwd: root, sessionPath } : { type, cwd: root };
    const response = await server.handle({ id: type, command });
    assert.equal(response.ok, false);
    assert.equal(response.error, "initialization failed", "cleanup must not mask the original command failure");
    assert.equal(runtimes[1].disposeCalls, 1, "a failed cleanup must not trigger unbounded retries");
    const entries = readFileSync(log.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as DiagnosticLogEntry);
    const cleanup = entries.filter((entry) => entry.event === "session_initialization_cleanup_failed");
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0].runtimeId, "failed-runtime");
    assert.equal(cleanup[0].data?.commandType, type);
    assert.match(JSON.stringify(cleanup[0].error), /cleanup failed/);
    if (type === "open_session") assert.equal(cleanup[0].sessionPath, sessionPath);
    assert.ok(entries.some((entry) => entry.event === "command_failed" && JSON.stringify(entry.error).includes("initialization failed")));
  });
}
