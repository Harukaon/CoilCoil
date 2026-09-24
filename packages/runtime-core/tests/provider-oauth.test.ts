import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import type { RuntimeEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("provider OAuth is driven through serializable runtime events and responses", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-provider-oauth-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  let loginInteraction: AuthInteraction | undefined;
  const fakeRuntime = {
    getProvider: (id: string) => id === "xai" ? ({
      id: "xai",
      name: "xAI",
      auth: {
        oauth: {
          name: "xAI subscription",
          loginLabel: "Sign in with SuperGrok or X Premium",
        },
      },
    } as Provider) : undefined,
    login: async (_provider: string, _type: string, interaction: AuthInteraction) => {
      loginInteraction = interaction;
      const method = await interaction.prompt({
        type: "select",
        message: "Choose login method",
        options: [{ id: "device", label: "Device code" }],
      });
      assert.equal(method, "device");
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.test/device",
        expiresInSeconds: 600,
      });
      await new Promise<never>((_resolve, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  } as unknown as ModelRuntime;
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    modelRuntime: fakeRuntime,
    onEvent: (event) => events.push(event),
  });

  const started = await runtime.startModelProviderOAuth("xai");
  assert.equal(started.status, "waiting_for_user");
  assert.equal(started.loginLabel, "Sign in with SuperGrok or X Premium");
  assert.ok(loginInteraction);
  const prompt = started.prompt;
  assert.equal(prompt?.type, "select");
  assert.equal(prompt?.type === "select" ? prompt.options[0]?.id : undefined, "device");
  const beforeDevice = await runtime.getModelProviderOAuth(started.flowId);
  const waitingForDevice = runtime.awaitModelProviderOAuth(started.flowId, beforeDevice.revision, 2_000);

  await runtime.respondModelProviderOAuth(started.flowId, prompt!.id, "device");
  const deviceSnapshot = await waitingForDevice;
  assert.equal(deviceSnapshot.state.status, "authorizing");
  assert.ok(deviceSnapshot.revision > beforeDevice.revision);
  await tick();
  const deviceState = events.flatMap((event) => event.type === "model_provider_auth_updated" ? [event.state] : []).at(-1);
  assert.equal(deviceState?.status, "authorizing");
  assert.equal(deviceState?.deviceCode?.userCode, "ABCD-EFGH");
  assert.equal(deviceState?.deviceCode?.verificationUri, "https://example.test/device");

  await runtime.cancelModelProviderOAuth(started.flowId);
  await tick();
  const authStates = events.flatMap((event) => event.type === "model_provider_auth_updated" ? [event.state] : []);
  assert.equal(authStates.at(-1)?.status, "cancelled");
  assert.equal(authStates.some((state) => state.status === "failed"), false);
  const completed = await runtime.getModelProviderOAuth(started.flowId);
  assert.equal(completed.state.status, "cancelled");
  await runtime.dispose();
});
