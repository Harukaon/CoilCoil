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
