import assert from "node:assert/strict";

export const description = "内置服务商可拉取新模型、保留已有模型并保存；再次拉取不使用旧缓存";

export async function run({ page, check, shot }) {
  const firstId = "claude-coil-new-e2e";
  const secondId = "claude-coil-newer-e2e";
  let secondPublished = false;
  let requests = 0;
  await page.route("https://models.dev/api.json", async (route) => {
    requests++;
    const models = {
      [firstId]: { id: firstId, name: "Claude Coil New", reasoning: true, modalities: { input: ["text", "image"] }, limit: { context: 200000, output: 8192 } },
      ...(secondPublished ? { [secondId]: { id: secondId, name: "Claude Coil Newer", limit: { context: 128000, output: 8192 } } } : {}),
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ anthropic: { models }, openai: { models: { "unrelated-test": { id: "unrelated-test" } } } }) });
  });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置栏目" }).getByRole("button", { name: "模型与服务商", exact: true }).click();
  await page.locator(".provider-catalog").getByRole("button", { name: /^Anthropic\b/ }).first().click();
  const editor = page.locator(".provider-editor");
  const refresh = editor.getByRole("button", { name: "获取最新模型" });
  await refresh.waitFor();
  check("内置服务商也有更新入口", await refresh.isVisible());

  await refresh.click();
  const picker = page.locator(".upstream-model-picker");
  await picker.waitFor();
  check("只显示 Anthropic 模型", await picker.getByText(firstId).count() === 1 && await picker.getByText("unrelated-test").count() === 0);
  check("明确告知公开目录不等于账号权限", (await picker.innerText()).includes("账号能否使用以服务商为准"));
  await picker.getByRole("button", { name: "取消" }).click();

  secondPublished = true;
  await refresh.click();
  await picker.getByText(secondId).waitFor();
  check("重新获取时真正请求最新目录", requests >= 2);
  await picker.locator(".upstream-model-picker-list label").filter({ hasText: firstId }).click();
  await picker.getByRole("button", { name: /添加所选/ }).click();
  check("新增模型后转入自定义目录", await editor.locator(".provider-model-mode button.active").innerText() === "自定义目录");
  await editor.locator(".provider-model-summary").filter({ hasText: firstId }).waitFor();
  check("没有把其他服务商模型混进来", await editor.locator(".provider-model-summary").filter({ hasText: "unrelated-test" }).count() === 0);
  check("未选中的新模型不会自动加入", await editor.locator(".provider-model-summary").filter({ hasText: secondId }).count() === 0);
  check("原有模型仍在", await editor.locator(".provider-model-summary").count() > 1);
  await shot("builtin-model-refresh");

  await editor.getByRole("button", { name: "保存设置" }).click();
  await editor.locator(".provider-unsaved-tag").waitFor({ state: "hidden", timeout: 15_000 });
  await editor.locator(".provider-model-summary").filter({ hasText: firstId }).waitFor();
  assert.ok(await editor.locator(".provider-model-summary").count() > 1, "保存后原有模型不能丢");
  check("保存后新模型还在", await editor.locator(".provider-model-summary").filter({ hasText: firstId }).count() === 1);
}
