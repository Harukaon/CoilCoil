import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateLegacyUserData } from "../src/main/data-migration.ts";

test("migrates legacy desktop data without overwriting existing CoilCoil data", () => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-data-migration-"));
  const support = join(root, "Application Support");
  const legacy = join(support, "@suocode", "desktop");
  const current = join(support, "@coilcoil", "desktop");
  try {
    mkdirSync(join(legacy, "sessions"), { recursive: true });
    mkdirSync(join(legacy, "Home"), { recursive: true });
    mkdirSync(join(legacy, "agent", "memory", "SuoCode"), { recursive: true });
    writeFileSync(join(legacy, "sessions", "old.jsonl"), `{"type":"session","cwd":"${legacy}/Home"}\n`);
    writeFileSync(join(legacy, "Home", "workspace.txt"), "keep this workspace");
    writeFileSync(join(legacy, "agent", "auth.json"), JSON.stringify({ providers: { test: { apiKey: "secret" } } }));
    writeFileSync(join(legacy, "agent", "suocode-settings.json"), JSON.stringify({ audit: true }));
    writeFileSync(join(legacy, "agent", "memory", "SuoCode", "MEMORY.md"), "# SuoCode 项目记忆\n路径：" + legacy);
    writeFileSync(join(legacy, "agent", "memory", "SuoCode", ".suocode-memory-state.json"), JSON.stringify({ version: 1, processedSessions: [`${legacy}/sessions/old.jsonl`] }));

    mkdirSync(join(current, "agent"), { recursive: true });
    mkdirSync(join(current, "Home"), { recursive: true });
    writeFileSync(join(current, "agent", "auth.json"), "{}\n");
    writeFileSync(join(current, "Home", "workspace.txt"), "newer workspace");

    const result = migrateLegacyUserData(current);
    assert.equal(result.migrated, true);
    assert.equal(existsSync(join(current, "sessions", "old.jsonl")), true);
    assert.equal(readFileSync(join(current, "sessions", "old.jsonl"), "utf8").includes(current + "/Home"), true);
    assert.deepEqual(JSON.parse(readFileSync(join(current, "agent", "auth.json"), "utf8")), { providers: { test: { apiKey: "secret" } } });
    assert.equal(existsSync(join(current, "agent", "coilcoil-settings.json")), true);
    assert.equal(existsSync(join(current, "agent", "suocode-settings.json")), false);
    assert.equal(readFileSync(join(current, "Home", "workspace.txt"), "utf8"), "newer workspace");
    const memory = readFileSync(join(current, "agent", "memory", "SuoCode", "MEMORY.md"), "utf8");
    assert.equal(memory.includes("# SuoCode 项目记忆"), true);
    assert.equal(memory.includes(current), true);
    assert.equal(existsSync(join(current, "agent", "memory", "SuoCode", ".coilcoil-memory-state.json")), true);
    assert.equal(existsSync(join(current, ".coilcoil-data-migration.json")), true);

    const second = migrateLegacyUserData(current);
    assert.deepEqual(second, { migrated: false, copied: [], skipped: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
