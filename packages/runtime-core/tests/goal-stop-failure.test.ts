import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import goalExtension, { GOAL_STATE_CHANNEL, GOAL_STATE_ENTRY } from "@coilcoil/workflow/extensions/goal.js";
import { CoilCoilRuntime } from "../src/index.js";
import { goalState, shutdownAgentSession } from "../src/runtime-state.js";

test("stopping a goal publishes its stopped state when the session journal is not writable", {
  timeout: 10_000,
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coil-goal-stop-failure-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  let closeSession = async (): Promise<void> => undefined;
  t.after(async () => {
    try { await closeSession(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, eventBus, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Offline test fixture", timestamp: Date.now() });
  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime: models, settingsManager: settings,
    resourceLoader: loader, sessionManager: manager,
  });
  // Exercise the real command and journal without starting a model request.
  t.mock.method(session, "sendUserMessage", async () => undefined);
  const active = { session, eventBus, goal: undefined as ReturnType<typeof goalState> };
  const runtime = Object.assign(Object.create(CoilCoilRuntime.prototype) as CoilCoilRuntime, { active });
  eventBus.on(GOAL_STATE_CHANNEL, (value) => { active.goal = goalState(value); });
  const errors: ExtensionError[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const journal = manager.getSessionFile()!;
  closeSession = async () => {
    chmodSync(journal, 0o600);
    await shutdownAgentSession(session);
  };
  await session.prompt("/goal Complete the offline fixture");
  assert.equal(active.goal?.status, "running");
  const before = readFileSync(journal, "utf8");
  chmodSync(journal, 0o400);

  const result = await runtime.stopGoal();

  assert.equal(result.stopped, true);
  assert.equal(active.goal, undefined, "the UI must reflect the loop that has already stopped");
  assert.equal(errors.length, 1, "the journal error remains visible through the SDK error channel");
  assert.equal(errors[0]?.extensionPath, "command:goal");
  assert.match(errors[0]?.error ?? "", /EACCES|EPERM/);
  assert.equal(readFileSync(journal, "utf8"), before, "failed persistence preserves the original journal");
  const ended = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY).at(-1);
  assert.equal(ended?.type === "custom" && (ended.data as { status: string }).status, "stopped");
});
