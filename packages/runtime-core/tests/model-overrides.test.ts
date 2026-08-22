import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installModelOverrides } from "../src/model-overrides.js";

interface FakeModel { provider: string; id: string; contextWindow: number; name: string }

/**
 * Stands in for Pi's registry, including the part that matters: re-registering
 * a provider replaces the model objects it hands out.
 */
function fakeRuntime(contextWindow: number): ModelRuntime & { reregister(next: number): void } {
  let catalogue: FakeModel = { provider: "pierce", id: "gpt-5.6-sol", contextWindow, name: "sol" };
  const runtime = {
    getModel: (provider: string, id: string) =>
      (provider === catalogue.provider && id === catalogue.id ? catalogue : undefined),
    reregister(next: number) {
      catalogue = { ...catalogue, contextWindow: next };
    },
  };
  return runtime as unknown as ModelRuntime & { reregister(next: number): void };
}

const OVERRIDE = { pierce: { "gpt-5.6-sol": { contextWindow: 230_000 } } };

test("解析模型时套用用户配置的上下文窗口", () => {
  const runtime = fakeRuntime(1_050_000);
  installModelOverrides(runtime, (provider, id) => OVERRIDE[provider as "pierce"]?.[id as "gpt-5.6-sol"]);
  assert.equal((runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel).contextWindow, 230_000);
});

test("provider 重新注册后覆盖值依然生效——这正是丢失的那条路径", () => {
  const runtime = fakeRuntime(1_050_000);
  installModelOverrides(runtime, (provider, id) => OVERRIDE[provider as "pierce"]?.[id as "gpt-5.6-sol"]);
  // openai-responses-ws 后台刷新目录后会 unregister + register，Pi 借此重建当前模型。
  runtime.reregister(1_050_000);
  assert.equal((runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel).contextWindow, 230_000);
});

test("目录换掉之后解析到的是新目录的值，不会被任何缓存钉住", () => {
  const runtime = fakeRuntime(1_050_000);
  installModelOverrides(runtime, () => undefined);
  assert.equal((runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel).contextWindow, 1_050_000);
  runtime.reregister(900_000);
  assert.equal((runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel).contextWindow, 900_000);
});

test("覆盖值改变后立刻反映出来，不会被缓存钉住", () => {
  const runtime = fakeRuntime(1_050_000);
  let configured = 230_000;
  installModelOverrides(runtime, () => ({ contextWindow: configured }));
  assert.equal((runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel).contextWindow, 230_000);
  configured = 300_000;
  assert.equal((runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel).contextWindow, 300_000);
});

test("没有配置覆盖的模型原样返回", () => {
  const runtime = fakeRuntime(1_050_000);
  installModelOverrides(runtime, () => undefined);
  const model = runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel;
  assert.equal(model.contextWindow, 1_050_000);
});

test("覆盖值与目录一致时原样返回目录对象，不做多余复制", () => {
  // fake 每次返回同一个对象，所以"原样返回"这件事可以用身份来验证。
  const runtime = fakeRuntime(230_000);
  const before = runtime.getModel("pierce", "gpt-5.6-sol");
  installModelOverrides(runtime, () => ({ contextWindow: 230_000 }));
  assert.equal(runtime.getModel("pierce", "gpt-5.6-sol"), before);
});

test("未知模型仍然返回 undefined", () => {
  const runtime = fakeRuntime(1_050_000);
  installModelOverrides(runtime, () => ({ contextWindow: 230_000 }));
  assert.equal(runtime.getModel("pierce", "不存在"), undefined);
});

test("重复安装不会叠加包装", () => {
  const runtime = fakeRuntime(1_050_000);
  installModelOverrides(runtime, () => ({ contextWindow: 230_000 }));
  const once = runtime.getModel;
  installModelOverrides(runtime, () => ({ contextWindow: 999 }));
  assert.equal(runtime.getModel, once);
  assert.equal((runtime.getModel("pierce", "gpt-5.6-sol") as unknown as FakeModel).contextWindow, 230_000);
});

test("注册表没有 getModel 时原样返回，不会把桩对象变成崩溃", () => {
  const stub = {} as ModelRuntime;
  assert.doesNotThrow(() => installModelOverrides(stub, () => ({ contextWindow: 230_000 })));
  assert.equal(installModelOverrides(stub, () => undefined), stub);
  assert.equal((stub as { getModel?: unknown }).getModel, undefined);
});
