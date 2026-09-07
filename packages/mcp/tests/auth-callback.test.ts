import assert from "node:assert/strict";
import test from "node:test";
import { McpAuthCallbackServer } from "../src/auth-callback.ts";

async function started(): Promise<{ server: McpAuthCallbackServer; redirect: string }> {
  // 每个用例一个临时端口：端口被回收再用，fetch 的连接池会拿着上一个服务器留下
  // 的连接去连新的，直接 ECONNRESET。
  const server = new McpAuthCallbackServer([0]);
  return { server, redirect: await server.listen() };
}

test("回调地址是本机回环，重复启动不会换端口", async (t) => {
  const { server, redirect } = await started();
  t.after(() => server.close());
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  // 端口是注册给授权服务器的一部分，重启一次就换掉等于把老用户变回新用户。
  assert.equal(await server.listen(), redirect);
  // 默认那一档是固定端口，正是为了这个稳定性；只有测试才用临时端口。
  const fixed = new McpAuthCallbackServer();
  t.after(() => fixed.close());
  assert.match(await fixed.listen(), /^http:\/\/127\.0\.0\.1:784[2-5]\/callback$/);
});

test("浏览器带回来的授权码交给正在等它的那一次", async (t) => {
  const { server, redirect } = await started();
  t.after(() => server.close());
  const waiting = server.expect("s-1", 5_000);
  await (await fetch(`${redirect}?code=abc&state=s-1&iss=https%3A%2F%2Fauth.example.com`)).text();
  assert.deepEqual(await waiting, { code: "abc", iss: "https://auth.example.com" });
});

test("没人在等的回调直接拒掉，不往任何一次授权上凑", async (t) => {
  const { server, redirect } = await started();
  t.after(() => server.close());
  // state 存在的意义就是不要瞎猜；猜错等于把别处的回调接到这次登录上。
  const response = await fetch(`${redirect}?code=abc&state=不认识的`);
  assert.equal(response.status, 400);
  const noState = await fetch(`${redirect}?code=abc`);
  assert.equal(noState.status, 400);
});

test("授权服务器报错就把它自己那句话带回来", async (t) => {
  const { server, redirect } = await started();
  t.after(() => server.close());
  const waiting = server.expect("s-2", 5_000);
  // 先把断言挂上去再触发：回调是同步落地的，晚一步这个 rejection 就成了没人接的。
  const settled = assert.rejects(() => waiting, /access_denied：用户拒绝/);
  await (await fetch(`${redirect}?state=s-2&error=access_denied&error_description=%E7%94%A8%E6%88%B7%E6%8B%92%E7%BB%9D`)).text();
  await settled;
});

test("回调里没有授权码也算失败，而不是一直挂着", async (t) => {
  const { server, redirect } = await started();
  t.after(() => server.close());
  const waiting = server.expect("s-3", 5_000);
  const settled = assert.rejects(() => waiting, /没有返回授权码/);
  await (await fetch(`${redirect}?state=s-3`)).text();
  await settled;
});

test("关掉弹窗就不再替这次授权占着回调", async (t) => {
  const { server } = await started();
  t.after(() => server.close());
  const waiting = server.expect("s-4", 5_000);
  assert.equal(server.awaiting("s-4"), true);
  server.cancel("s-4");
  assert.equal(server.awaiting("s-4"), false);
  await assert.rejects(() => waiting, /已取消/);
});

test("超时会自己收摊", async (t) => {
  const { server } = await started();
  t.after(() => server.close());
  await assert.rejects(() => server.expect("s-5", 10), /超时/);
  assert.equal(server.awaiting("s-5"), false);
});

test("其他路径一律 404，不当成回调", async (t) => {
  const { server, redirect } = await started();
  t.after(() => server.close());
  const root = redirect.replace("/callback", "/");
  assert.equal((await fetch(root)).status, 404);
});

test("关闭时把还在等的授权一起了结掉", async () => {
  const { server } = await started();
  const waiting = server.expect("s-6", 60_000);
  const settled = assert.rejects(() => waiting, /已取消/);
  await server.close();
  await settled;
});
