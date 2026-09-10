import assert from "node:assert/strict";
import test from "node:test";
import { BrowserGuestRegistry, type GuestCandidate } from "../src/main/browser-guests.ts";

const PARTITION = "persist:coilcoil-browser";
const HOST_ID = 1;

/** Manual clock so timeout paths are exercised without real waiting. */
function harness(candidates: Record<number, Partial<GuestCandidate>> = {}) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const registry = new BrowserGuestRegistry({
    // 一个工作区一份 cookie，分区会随工作区变，所以注册表取的是函数不是值。
    expectedPartition: () => PARTITION,
    hostWebContentsId: () => HOST_ID,
    inspect: (id) => {
      const override = candidates[id];
      if (!override) return undefined;
      return { hostWebContentsId: HOST_ID, type: "webview", partition: PARTITION, destroyed: false, ...override };
    },
    setTimer: (callback) => {
      const handle = nextTimer++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimer: (handle) => { timers.delete(handle as number); },
  });
  return {
    registry,
    fireAllTimers: () => { for (const [handle, callback] of [...timers]) { timers.delete(handle); callback(); } },
    pendingTimers: () => timers.size,
  };
}

const settled = async <T>(promise: Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> => {
  try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error: String((error as Error).message) }; }
};

test("guest registry binds a guest that passes every check", async () => {
  const { registry } = harness({ 7: {} });
  registry.markLayerReady();
  const pending = registry.expectGuest("tab-1", "nonce-1");
  registry.register("tab-1", "nonce-1", 7);
  assert.equal(await pending, 7);
  assert.equal(registry.boundGuestId("tab-1"), 7);
});

test("guest registry refuses an unknown tab", () => {
  const { registry } = harness({ 7: {} });
  assert.throws(() => registry.register("nope", "nonce-1", 7), /未在等待标签页/);
});

test("guest registry refuses a mismatched nonce", async () => {
  const { registry } = harness({ 7: {} });
  const pending = settled(registry.expectGuest("tab-1", "nonce-1"));
  assert.throws(() => registry.register("tab-1", "wrong", 7), /校验失败/);
  registry.release("tab-1");
  assert.equal((await pending).ok, false);
});

test("guest registry refuses a second binding for one tab", async () => {
  const { registry } = harness({ 7: {}, 8: {} });
  const pending = registry.expectGuest("tab-1", "nonce-1");
  registry.register("tab-1", "nonce-1", 7);
  await pending;
  assert.throws(() => registry.register("tab-1", "nonce-1", 8), /未在等待标签页/);
  assert.equal(registry.boundGuestId("tab-1"), 7);
});

test("guest registry refuses one guest backing two tabs across scopes", async () => {
  const { registry } = harness({ 7: {} });
  const first = registry.expectGuest("tab-scope-a", "nonce-a");
  registry.register("tab-scope-a", "nonce-a", 7);
  await first;
  // A different agent scope must never be pointed at a page that is already bound.
  const second = settled(registry.expectGuest("tab-scope-b", "nonce-b"));
  assert.throws(() => registry.register("tab-scope-b", "nonce-b", 7), /已绑定到其他标签页/);
  registry.release("tab-scope-b");
  assert.equal((await second).ok, false);
});

test("guest registry refuses contents owned by another window", async () => {
  const { registry } = harness({ 7: { hostWebContentsId: 99 } });
  const pending = settled(registry.expectGuest("tab-1", "nonce-1"));
  assert.throws(() => registry.register("tab-1", "nonce-1", 7), /不属于当前窗口/);
  registry.release("tab-1");
  await pending;
});

test("guest registry refuses contents that are not a webview", async () => {
  const { registry } = harness({ 7: { type: "window" }, 8: { type: "browserView" } });
  const a = settled(registry.expectGuest("tab-a", "n"));
  assert.throws(() => registry.register("tab-a", "n", 7), /类型不符/);
  registry.release("tab-a");
  await a;
  const b = settled(registry.expectGuest("tab-b", "n"));
  assert.throws(() => registry.register("tab-b", "n", 8), /类型不符/);
  registry.release("tab-b");
  await b;
});

test("guest registry refuses a guest from another session partition", async () => {
  const { registry } = harness({ 7: { partition: "persist:elsewhere" }, 8: { partition: undefined } });
  const a = settled(registry.expectGuest("tab-a", "n"));
  assert.throws(() => registry.register("tab-a", "n", 7), /会话分区不符/);
  registry.release("tab-a");
  await a;
  const b = settled(registry.expectGuest("tab-b", "n"));
  assert.throws(() => registry.register("tab-b", "n", 8), /会话分区不符/);
  registry.release("tab-b");
  await b;
});

test("guest registry refuses missing, destroyed, and nonsense ids", async () => {
  const { registry } = harness({ 7: { destroyed: true } });
  for (const [id, pattern] of [[7, /不存在/], [404, /不存在/], [0, /标识无效/], [-1, /标识无效/], [1.5, /标识无效/]] as const) {
    const pending = settled(registry.expectGuest(`tab-${id}`, "n"));
    assert.throws(() => registry.register(`tab-${id}`, "n", id), pattern, `id ${id}`);
    registry.release(`tab-${id}`);
    await pending;
  }
});

test("guest registry times out and leaves no orphan behind", async () => {
  const { registry, fireAllTimers, pendingTimers } = harness({ 7: {} });
  registry.markLayerReady();
  const pending = settled(registry.expectGuest("tab-1", "nonce-1"));
  fireAllTimers();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /超时/);
  // A report arriving after the timeout must be rejected, not silently bound.
  assert.throws(() => registry.register("tab-1", "nonce-1", 7), /未在等待标签页/);
  assert.equal(registry.boundGuestId("tab-1"), undefined);
  assert.equal(pendingTimers(), 0);
});

test("guest registry rejects registration for a tab closed while in flight", async () => {
  const { registry } = harness({ 7: {} });
  const pending = settled(registry.expectGuest("tab-1", "nonce-1"));
  registry.release("tab-1");
  assert.equal((await pending).ok, false);
  assert.throws(() => registry.register("tab-1", "nonce-1", 7), /未在等待标签页/);
});

test("guest registry frees a binding on release so the id can be reused", async () => {
  const { registry } = harness({ 7: {} });
  const first = registry.expectGuest("tab-1", "n1");
  registry.register("tab-1", "n1", 7);
  await first;
  registry.release("tab-1");
  const second = registry.expectGuest("tab-2", "n2");
  registry.register("tab-2", "n2", 7);
  assert.equal(await second, 7);
});

test("guest registry reports renderer-side creation failures", async () => {
  const { registry } = harness();
  const pending = settled(registry.expectGuest("tab-1", "nonce-1"));
  registry.fail("tab-1", "wrong-nonce", "ignored");
  registry.fail("tab-1", "nonce-1", "element removed");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /element removed/);
});

test("guest layer wait resolves once, and times out when the layer never mounts", async () => {
  const ready = harness();
  const waitBeforeReady = ready.registry.waitForLayer();
  ready.registry.markLayerReady();
  assert.equal((await settled(waitBeforeReady)).ok, true);
  assert.equal((await settled(ready.registry.waitForLayer())).ok, true);

  const never = harness();
  const pending = settled(never.registry.waitForLayer());
  never.fireAllTimers();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /未就绪/);
});

test("guest registry requires the layer to re-announce after a renderer reload", () => {
  const { registry } = harness();
  registry.markLayerReady();
  assert.equal(registry.isLayerReady(), true);
  registry.markLayerGone();
  assert.equal(registry.isLayerReady(), false);
});

test("guest registry dispose rejects everything pending", async () => {
  const { registry, pendingTimers } = harness({ 7: {} });
  const guest = settled(registry.expectGuest("tab-1", "nonce-1"));
  const layer = settled(registry.waitForLayer());
  registry.dispose();
  assert.equal((await guest).ok, false);
  assert.equal((await layer).ok, false);
  assert.equal(pendingTimers(), 0);
  assert.equal((await settled(registry.expectGuest("tab-2", "n"))).ok, false);
  assert.equal((await settled(registry.waitForLayer())).ok, false);
});
