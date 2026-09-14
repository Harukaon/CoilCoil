import assert from "node:assert/strict";
import test from "node:test";
import type { McpActionResult } from "@coilcoil/runtime-protocol";
import {
  mcpAuthDescription,
  mcpAuthFlowFailed,
  mcpAuthFlowFromStart,
  mcpAuthFlowStarted,
  mcpAuthFlowSucceeded,
  mcpAuthManualFallbackVisible,
  mcpAuthTerminal,
  mcpAuthTitle,
  failureNeedsReauthorization,
} from "../src/renderer/src/features/settings/mcpAuthPresentation.ts";

function actionResult(details?: Record<string, unknown>, text = ""): McpActionResult {
  return { text, details };
}

test("拿到授权地址后进入等待浏览器的状态", () => {
  const state = mcpAuthFlowFromStart(mcpAuthFlowStarted("linear"), actionResult({
    mode: "auth-start",
    authorizationUrl: "https://auth.example.com/authorize?state=s-1",
    awaitingCallback: true,
  }));
  assert.equal(state.phase, "waiting");
  assert.equal(state.awaitingCallback, true);
  assert.equal(state.authorizationUrl, "https://auth.example.com/authorize?state=s-1");
  assert.equal(mcpAuthTerminal(state), false);
  // Automatic capture is the whole point: no paste box in the normal path.
  assert.equal(mcpAuthManualFallbackVisible(state), false);
  assert.match(mcpAuthDescription(state), /自动收到回调/);
});

test("回调抓不到时才提供手动粘贴的退路", () => {
  const state = mcpAuthFlowFromStart(mcpAuthFlowStarted("linear"), actionResult({
    mode: "auth-start",
    authorizationUrl: "https://auth.example.com/authorize",
    awaitingCallback: false,
  }));
  assert.equal(state.phase, "waiting");
  assert.equal(mcpAuthManualFallbackVisible(state), true);
  assert.match(mcpAuthDescription(state), /粘贴/);
});

test("已经认证过的服务器直接报成功", () => {
  const state = mcpAuthFlowFromStart(mcpAuthFlowStarted("linear"), actionResult({
    mode: "auth-start",
    authenticated: true,
  }));
  assert.equal(state.phase, "succeeded");
  assert.equal(mcpAuthTerminal(state), true);
  assert.equal(mcpAuthTitle(state), "认证成功");
});

test("扩展报错时状态机停在失败，并保留可读的原因", () => {
  const state = mcpAuthFlowFromStart(mcpAuthFlowStarted("linear"), actionResult({
    mode: "auth-start",
    error: "oauth_not_supported",
    message: "这个服务器没有配置 OAuth。",
  }));
  assert.equal(state.phase, "failed");
  assert.equal(state.message, "这个服务器没有配置 OAuth。");
  assert.equal(mcpAuthTitle(state), "认证失败");
  // Nothing was ever opened, so there is no redirect to paste back.
  assert.equal(mcpAuthManualFallbackVisible(state), false);
});

test("没有授权地址也没有报错，同样算失败而不是无声等待", () => {
  const state = mcpAuthFlowFromStart(mcpAuthFlowStarted("linear"), actionResult({ mode: "auth-start" }));
  assert.equal(state.phase, "failed");
});

test("等待过程中出错可以退回失败并留下手动粘贴的机会", () => {
  const waiting = mcpAuthFlowFromStart(mcpAuthFlowStarted("linear"), actionResult({
    mode: "auth-start",
    authorizationUrl: "https://auth.example.com/authorize?state=s-1",
    awaitingCallback: true,
  }));
  const failed = mcpAuthFlowFailed(waiting, new Error("OAuth callback timeout"));
  assert.equal(failed.phase, "failed");
  assert.equal(failed.message, "OAuth callback timeout");
  assert.equal(mcpAuthManualFallbackVisible(failed), true);
  assert.equal(failed.authorizationUrl, waiting.authorizationUrl);
});

test("成功后用扩展返回的说明覆盖描述", () => {
  const waiting = mcpAuthFlowFromStart(mcpAuthFlowStarted("linear"), actionResult({
    mode: "auth-start",
    authorizationUrl: "https://auth.example.com/authorize?state=s-1",
    awaitingCallback: true,
  }));
  const done = mcpAuthFlowSucceeded(waiting, actionResult({ mode: "auth-await", authenticated: true }, "linear 已完成认证并重新连接。"));
  assert.equal(done.phase, "succeeded");
  assert.equal(mcpAuthDescription(done), "linear 已完成认证并重新连接。");
});

test("关掉状态弹窗不会掐死浏览器里正在进行的登录", () => {
  // 关闭曾经等同于取消：等待被删掉后，一分钟后回来的回调没有落点，回调服务
  // answers 400、浏览器显示失败页、授权码被丢掉。用户那边看到的就是
  // 「我登录了，回调根本没发回来」——用户的 beeswax 有三次死在这里。
  const started = mcpAuthFlowStarted("beeswax");
  assert.equal(started.authorizationUrl, undefined, "还没拿到授权页，此时关闭应当释放等待");

  const waiting = mcpAuthFlowFromStart(started, {
    text: "",
    details: { mode: "auth-start", server: "beeswax", authorizationUrl: "https://example.com/authorize", awaitingCallback: true },
  } as never);
  assert.equal(waiting.phase, "waiting");
  assert.ok(waiting.authorizationUrl, "浏览器已经被送去授权页，登录在那边进行");
});

test("服务器答了话却连不上，就直接接到重新授权，不管它答的是几", () => {
  // 这条规则存在的理由：2026-09-14 一台 MCP Server 把过期令牌报成了 500。按状态码
  // 认，我们只当成「服务器炸了」，界面给一句连不上就没有下文，用户唯一的出路是去
  // 文件系统里手动删本地凭据。按「答没答话」认就不会被骗。
  for (const status of [500, 502, 400, 403, 418]) {
    assert.equal(
      failureNeedsReauthorization({ failureHttpStatus: status }, true),
      true,
      `${status} 也是答了话，该去重新登录`,
    );
  }
});

test("压根没连上就别弹浏览器——服务器不在，登录也登不了", () => {
  assert.equal(failureNeedsReauthorization({ failureHttpStatus: null }, true), false);
  assert.equal(failureNeedsReauthorization({}, true), false);
  assert.equal(failureNeedsReauthorization(undefined, true), false);
});

test("不走浏览器认证的服务器，永远不问登录", () => {
  assert.equal(failureNeedsReauthorization({ failureHttpStatus: 500 }, false), false);
});
