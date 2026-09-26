import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WebContents } from "electron";
import { BrowserFrameLeases } from "../src/main/browser-frame-leases.ts";
import { BACKGROUND_FRAME_RATE, BrowserSurfaceStream, JPEG_FRAME_RATE, TEXTURE_FRAME_RATE } from "../src/main/browser-frame-stream.ts";
import { BROWSER_SURFACE_CHANNEL, BROWSER_SURFACE_DONE_CHANNEL, BROWSER_SURFACE_FRAME_CHANNEL, parseSurfaceRegistration } from "../src/shared/browser-frames.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function image(empty = false): Electron.NativeImage {
  return { isEmpty: () => empty, getSize: () => ({ width: 200, height: 100 }), toJPEG: () => Buffer.from("jpeg") } as unknown as Electron.NativeImage;
}

function page() {
  const rates: number[] = [];
  let captures = 0;
  const requests: string[] = [];
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setFrameRate: (rate: number) => { rates.push(rate); },
    invalidate: () => { requests.push("invalidate"); },
    stopPainting: () => { requests.push("stop"); },
    startPainting: () => { requests.push("start"); },
    capturePage: async () => { captures++; return image(); },
  });
  return { contents: contents as unknown as WebContents, rates, captures: () => captures, requests };
}

/** 一张页面纹理：记下它什么时候被还回去。 */
function texture(log: string[], name = "t", widgetType: "frame" | "popup" = "frame"): Electron.OffscreenSharedTexture {
  return {
    textureInfo: { widgetType, visibleRect: { x: 0, y: 0, width: 400, height: 200 } },
    release: () => log.push(`${name} 还给页面`),
  } as unknown as Electron.OffscreenSharedTexture;
}

function fixture({ textures = true, timeoutMs = 2000 } = {}) {
  const sent: any[] = [];
  const ipc = new EventEmitter();
  const host = Object.assign(new EventEmitter(), {
    ipc,
    isDestroyed: () => false,
    send: (channel: string, frame: unknown) => { if (channel === BROWSER_SURFACE_FRAME_CHANNEL) sent.push(frame); },
  });
  const log: string[] = [];
  const subtle = {
    importSharedTexture: () => ({
      startTransferSharedTexture: () => ({ handle: "transfer" }),
      release: (callback?: () => void) => { log.push("主进程引用释放"); callback?.(); },
    }),
  };
  const stream = new BrowserSurfaceStream(host as unknown as WebContents, {
    textures: textures ? { subtle } as unknown as Pick<Electron.SharedTexture, "subtle"> : undefined,
    viewportOf: () => ({ width: 200, height: 100 }),
    timeoutMs,
  });
  const attach = (tabId = "tab", surfaceId = "s1", sharedTexture = true) =>
    ipc.emit(BROWSER_SURFACE_CHANNEL, {}, { tabId, surfaceId, attached: true, sharedTexture });
  const detach = (tabId = "tab", surfaceId = "s1") =>
    ipc.emit(BROWSER_SURFACE_CHANNEL, {}, { tabId, surfaceId, attached: false, sharedTexture: true });
  const done = (id: number, failed = false) => ipc.emit(BROWSER_SURFACE_DONE_CHANNEL, {}, id, failed);
  return { host, sent, log, stream, attach, detach, done };
}

test("有人看着时：纹理借给窗口，窗口画完回执后才还给页面，帧率提到 60", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  assert.equal(p.rates.at(-1), TEXTURE_FRAME_RATE);
  f.stream.paint("tab", p.contents, texture(f.log), image(true));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].mode, "texture");
  assert.equal(f.sent[0].surfaceId, "s1");
  assert.deepEqual([f.sent[0].width, f.sent[0].height], [400, 200]);
  assert.deepEqual(f.log, [], "窗口还没画完，纹理不能还");
  f.done(f.sent[0].id);
  assert.deepEqual(f.log, ["主进程引用释放", "t 还给页面"]);
  f.done(f.sent[0].id);
  assert.equal(f.log.length, 2, "重复回执不重复归还");
});

test("没人看的页面、画布还没挂上、弹层：纹理立刻还掉，不发给窗口", () => {
  const f = fixture();
  const watched = page();
  const other = page();
  f.stream.watch("tab", watched.contents);
  f.stream.paint("tab", watched.contents, texture(f.log, "画布没挂"), image(true));
  f.attach();
  f.stream.paint("other", other.contents, texture(f.log, "后台页"), image(true));
  f.stream.paint("tab", watched.contents, texture(f.log, "弹层", "popup"), image(true));
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.log, ["画布没挂 还给页面", "后台页 还给页面", "弹层 还给页面"]);
});

test("窗口跟不上：最多三张在路上，多出来的丢掉并立刻还给页面", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  for (let index = 0; index < 5; index++) f.stream.paint("tab", p.contents, texture(f.log, `第${index}帧`), image(true));
  assert.equal(f.sent.length, 3);
  assert.equal(f.stream.stats.dropped, 2);
  assert.deepEqual(f.log, ["第3帧 还给页面", "第4帧 还给页面"]);
});

test("纹理迟迟不还：先改用 JPEG 让画面继续动，卡住的纹理不提前还；都还回来后换回纹理", async () => {
  const f = fixture({ timeoutMs: 20 });
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, texture(f.log, "卡住的"), image(true));
  await wait(40);
  assert.equal(p.rates.at(-1), JPEG_FRAME_RATE);
  f.stream.paint("tab", p.contents, texture(f.log, "超时后"), image(true));
  await wait(60);
  assert.equal(f.sent.at(-1).mode, "jpeg");
  assert.equal(p.captures(), 1, "页面出的是纹理，按需截一帧");
  assert.ok(!f.log.includes("卡住的 还给页面"), "超时也不能提前还");
  f.done(f.sent[0].id);
  assert.ok(f.log.includes("卡住的 还给页面"));
  assert.equal(p.rates.at(-1), TEXTURE_FRAME_RATE);
  f.stream.paint("tab", p.contents, texture(f.log, "恢复后"), image(true));
  assert.equal(f.sent.at(-1).mode, "texture");
});

test("窗口收不下纹理（预加载报错）：之后都用 JPEG", async () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, texture(f.log), image(true));
  f.done(f.sent[0].id, true);
  f.stream.paint("tab", p.contents, texture(f.log, "之后"), image(true));
  await wait(60);
  assert.ok(f.log.includes("之后 还给页面"));
  assert.equal(f.sent.at(-1).mode, "jpeg");
  assert.equal(p.rates.at(-1), JPEG_FRAME_RATE);
});

test("关了 GPU（页面只出位图）：编码 JPEG，最多一张在路上，发的总是最新的一帧", async () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, undefined, image());
  assert.equal(p.rates.at(-1), JPEG_FRAME_RATE, "位图模式一秒 30 帧就够");
  await wait(20);
  assert.equal(f.sent.length, 1);
  for (let index = 0; index < 3; index++) f.stream.paint("tab", p.contents, undefined, image());
  await wait(60);
  assert.equal(f.sent.length, 1, "上一张没画完不发下一张");
  f.done(f.sent[0].id);
  await wait(60);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].mode, "jpeg");
});

test("页面刚建好先出几帧位图、接上 GPU 后出纹理：帧率回到 60，不锁在 30", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, undefined, image());
  assert.equal(p.rates.at(-1), JPEG_FRAME_RATE);
  f.stream.paint("tab", p.contents, texture(f.log), image(true));
  assert.equal(p.rates.at(-1), TEXTURE_FRAME_RATE);
});

test("开始看一张页面、画布挂上时都主动要一帧：两种模式各自的办法都用上", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  assert.deepEqual(p.requests, ["invalidate", "stop", "start"]);
  f.attach();
  assert.deepEqual(p.requests, ["invalidate", "stop", "start", "invalidate", "stop", "start"]);
  f.attach("other", "别的标签页的画布");
  assert.equal(p.requests.length, 6, "别的标签页的画布挂上不打扰这一张");
});

test("纹理模式下 invalidate() 来的空位图不算数：不会被当成关了 GPU 而降到 30 帧", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, texture(f.log), image(true));
  f.stream.paint("tab", p.contents, undefined, image(true));
  assert.equal(p.rates.at(-1), TEXTURE_FRAME_RATE);
});

test("桌面窗口重载：在路上的纹理全部收回，画布要重新挂上才再发", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, texture(f.log, "在路上"), image(true));
  f.host.emit("did-navigate");
  assert.ok(f.log.includes("在路上 还给页面"));
  f.stream.paint("tab", p.contents, texture(f.log, "重载后"), image(true));
  assert.equal(f.sent.length, 1);
  assert.ok(f.log.includes("重载后 还给页面"));
});

test("旧画布晚摘下不影响新画布；画布摘下后不再发", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach("tab", "旧");
  f.attach("tab", "新");
  f.detach("tab", "旧");
  f.stream.paint("tab", p.contents, texture(f.log), image(true));
  assert.equal(f.sent.at(-1).surfaceId, "新");
  f.detach("tab", "新");
  f.stream.paint("tab", p.contents, texture(f.log, "摘下后"), image(true));
  assert.equal(f.sent.length, 1);
  assert.ok(f.log.includes("摘下后 还给页面"));
});

test("不看了（切走、收起面板）：帧率降回后台的一秒一帧，在路上的照常等回执", () => {
  const f = fixture();
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, texture(f.log, "切走前"), image(true));
  f.stream.watch(undefined, undefined);
  assert.equal(p.rates.at(-1), BACKGROUND_FRAME_RATE);
  assert.deepEqual(f.log, []);
  f.done(f.sent[0].id);
  assert.ok(f.log.includes("切走前 还给页面"));
});

test("没有 sharedTexture 模块：纹理还掉，改截图编码 JPEG", async () => {
  const f = fixture({ textures: false });
  const p = page();
  f.stream.watch("tab", p.contents);
  f.attach();
  f.stream.paint("tab", p.contents, texture(f.log), image(true));
  await wait(40);
  assert.equal(f.sent.at(-1)?.mode, "jpeg");
  assert.deepEqual(f.log, ["t 还给页面"]);
});

test("占用池：JPEG 超时直接作废，纹理超时只报告不归还，关掉时全部收回", async () => {
  const released: string[] = [];
  const timeouts: string[] = [];
  const leases = new BrowserFrameLeases((mode) => timeouts.push(mode), 10);
  leases.add("jpeg", () => released.push("jpeg"));
  leases.add("texture", () => released.push("texture"));
  assert.equal(leases.canSend("jpeg"), false);
  await wait(30);
  assert.deepEqual(timeouts.sort(), ["jpeg", "texture"]);
  assert.deepEqual(released, ["jpeg"]);
  assert.equal(leases.canSend("jpeg"), true);
  leases.dispose();
  assert.deepEqual(released, ["jpeg", "texture"]);
  assert.equal(leases.size, 0);
});

test("画布挂载消息逐项核对", () => {
  assert.deepEqual(parseSurfaceRegistration({ tabId: "a", surfaceId: "b", attached: true, sharedTexture: false }),
    { tabId: "a", surfaceId: "b", attached: true, sharedTexture: false });
  assert.equal(parseSurfaceRegistration({ tabId: "", surfaceId: "b", attached: true, sharedTexture: true }), undefined);
  assert.equal(parseSurfaceRegistration({ tabId: "a".repeat(200), surfaceId: "b", attached: true, sharedTexture: true }), undefined);
  assert.equal(parseSurfaceRegistration({ tabId: "a", surfaceId: "b", attached: "yes", sharedTexture: true }), undefined);
});
