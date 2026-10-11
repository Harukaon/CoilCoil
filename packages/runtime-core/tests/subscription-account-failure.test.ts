import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, registerSessionResourceCleanup, type Model } from "@earendil-works/pi-ai";
import { CoilCoilRuntime } from "../src/index.js";
import { readSubscriptionAccounts } from "../src/subscription-accounts.js";
import { subscriptionStream } from "../src/subscription-stream.js";

async function setup(context: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "coil-accounts-failure-"));
  const agent = join(root, "agent");
  const runtime = new CoilCoilRuntime({ agentDir: agent, sessionDir: join(root, "sessions") });
  await runtime.createSubscriptionAccount({ id: "claude-a", provider: "anthropic" });
  await runtime.createSubscriptionAccount({ id: "claude-b", provider: "anthropic" });
  const path = join(agent, "auth.json");
  const creds = Object.fromEntries(["claude-a", "claude-b"].map((id) => [id, { type: "oauth", access: `sk-ant-oat01-fake-${id}`, refresh: `fake-refresh-${id}`, expires: Date.now() + 3600000 }]));
  fs.writeFileSync(path, JSON.stringify(creds));
  const models = await runtime.sharedModelRuntime();
  await models.refresh({ allowNetwork: false });
  context.after(async () => { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, agent, runtime, models, path };
}

test("metadata write failure does not erase the account login or its sibling", async (context) => {
  const { agent, runtime, path } = await setup(context);
  const before = fs.readFileSync(path, "utf8");
  const rename = fs.renameSync;
  let fail = true;
  const mocked = context.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === join(agent, "subscription-accounts.json") && fail) {
      fail = false;
      throw new Error("Injected disk failure");
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runtime.removeModelProviderConfiguration("claude-a"), /Injected disk failure/);
    assert.equal(fs.readFileSync(path, "utf8"), before);
    assert.deepEqual(readSubscriptionAccounts(agent).map((account) => account.id), ["claude-a", "claude-b"]);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  await runtime.removeModelProviderConfiguration("claude-a");
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8"))["claude-a"], undefined);
  assert.ok(JSON.parse(fs.readFileSync(path, "utf8"))["claude-b"]);
});

test("logging out A cannot close a live B session connection", async (context) => {
  const { runtime, models } = await setup(context);
  const model = models.getModels().find((model) => model.provider === "claude-b")!;
  const closed: Array<string | undefined> = [];
  let rebound = 0;
  const unregister = registerSessionResourceCleanup((id) => { closed.push(id); });
  const internal = runtime as unknown as {
    active?: { cwd: string; session: { sessionId: string; model: typeof model; refreshModelFromRegistry: () => void } };
    publishRuntimeInspection: () => void;
  };
  internal.active = { cwd: "/tmp", session: { sessionId: "session-b", model, refreshModelFromRegistry: () => { rebound++; } } };
  internal.publishRuntimeInspection = () => {};
  try {
    await runtime.removeProviderAuth("claude-a");
    assert.deepEqual(closed, []);
    assert.equal(rebound, 0);
    runtime.refreshSessionModelFromRegistry("claude-b");
    assert.deepEqual(closed, ["session-b"]);
    assert.equal(rebound, 1);
  } finally { internal.active = undefined; unregister(); }
});

test("stream adapter keeps abort as abort when a source iterator throws", async () => {
  const source = createAssistantMessageEventStream();
  source[Symbol.asyncIterator] = async function* () { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); };
  const output = subscriptionStream(source, "codex-work", { id: "test", api: "openai-codex-responses" } as Model<"openai-codex-responses">);
  const result = await output.result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.provider, "codex-work");
});
