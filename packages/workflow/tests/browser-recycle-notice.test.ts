import assert from "node:assert/strict";
import test from "node:test";
import {
  drainBrowserNotice,
  noteBrowserCall,
  recycledTabsEndpoint,
  rememberPageIds,
  recycleNotice,
  takeRecycledTabs,
} from "../extensions/browser-recycle-notice.ts";

const env = {
  COILCOIL_BROWSER_MCP_ARGS: JSON.stringify([
    "/devtools.js", "--wsEndpoint", "ws://127.0.0.1:4321/devtools/browser/secret-token",
    "--wsHeaders", JSON.stringify({ Authorization: "Bearer abc" }),
  ]),
};

test("桥的地址和令牌就用连浏览器时那一套", () => {
  const endpoint = recycledTabsEndpoint("session-a", env);
  assert.equal(endpoint?.url, "http://127.0.0.1:4321/coilcoil/recycled-tabs/secret-token?scope=session-a");
  assert.deepEqual(endpoint?.headers, { Authorization: "Bearer abc" });
  assert.equal(recycledTabsEndpoint("session-a", {}), undefined, "没有桌面端（CLI、测试）就当没有");
});

test("取回收记录：桥不在或出错都当作没有", async () => {
  assert.deepEqual(await takeRecycledTabs("s", {}), { recycled: [] });
  const failing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.deepEqual(await takeRecycledTabs("s", env, failing), { recycled: [] });
  const ok = (async () => new Response(JSON.stringify({ limit: 5, recycled: [{ url: "http://x", title: "X" }] }))) as unknown as typeof fetch;
  assert.deepEqual(await takeRecycledTabs("s", env, ok), { limit: 5, recycled: [{ url: "http://x", title: "X" }] });
});

test("提示里带上被收掉那张原来的编号和网址", () => {
  rememberPageIds("s1", "## Pages\n1: u (http://u)\n2: p1 (http://p1) \n3: p2 (http://p2) [selected] isolatedContext=x");
  const notice = recycleNotice("s1", { limit: 5, recycled: [{ url: "http://p1", title: "p1" }] });
  assert.match(notice, /超过了 5 张/);
  assert.match(notice, /id=2 的标签页，url 是：http:\/\/p1（p1）/);
  assert.equal(recycleNotice("s1", { recycled: [] }), "");
});

test("先用旧编号算提示，再用这次的列表更新：新列表里已经没有被收掉的那张了", async () => {
  const session = "s2";
  rememberPageIds(session, "1: p1 (http://p1)\n2: p2 (http://p2)");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ limit: 5, recycled: [{ url: "http://p1", title: "p1" }] }))) as typeof fetch;
  const previous = process.env.COILCOIL_BROWSER_MCP_ARGS;
  process.env.COILCOIL_BROWSER_MCP_ARGS = env.COILCOIL_BROWSER_MCP_ARGS;
  try {
    await noteBrowserCall(session, "2: p2 (http://p2)\n3: p7 (http://p7) [selected]");
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.COILCOIL_BROWSER_MCP_ARGS;
    else process.env.COILCOIL_BROWSER_MCP_ARGS = previous;
  }
  const notice = drainBrowserNotice(session);
  assert.match(notice, /id=1 的标签页，url 是：http:\/\/p1/);
  assert.equal(drainBrowserNotice(session), "", "只说一遍");
});
