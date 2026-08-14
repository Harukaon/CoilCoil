import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProviderAuthState } from "@suocode/runtime-protocol";
import { oauthCallbackUrl } from "../src/renderer/src/features/settings/providerOAuthPresentation.ts";

function state(prompt?: ModelProviderAuthState["prompt"]): ModelProviderAuthState {
  return {
    flowId: "flow-1",
    provider: "provider-1",
    providerName: "Provider",
    loginLabel: "登录",
    status: "waiting_for_user",
    prompt,
  };
}

test("OAuth 回调地址从手动输入提示中提取并显示在前部", () => {
  assert.equal(oauthCallbackUrl(state({
    id: "prompt-1",
    type: "manual_code",
    message: "粘贴最终回调地址",
    placeholder: "http://localhost:1455/auth/callback",
  })), "http://localhost:1455/auth/callback");
});

test("普通提示内容不会被误认为回调地址", () => {
  assert.equal(oauthCallbackUrl(state({
    id: "prompt-1",
    type: "text",
    message: "输入组织名称",
    placeholder: "my-team",
  })), undefined);
});
