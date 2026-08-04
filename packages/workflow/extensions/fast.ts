import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isGptModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const leafId = modelId.split("/").at(-1) ?? modelId;
  return /^gpt-/i.test(leafId);
}

export default function fastExtension(pi: ExtensionAPI): void {
  let enabled = false;

  pi.registerCommand("fast", {
    description: "Toggle the OpenAI priority service tier",
    handler: async (args, ctx) => {
      if (!isGptModelId(ctx.model?.id)) {
        enabled = false;
        ctx.ui.notify("当前模型不是 GPT，/fast 不可用", "warning");
        return;
      }

      const action = args.trim().toLowerCase();

      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action && action !== "status") {
        ctx.ui.notify("用法：/fast [on|off|status]", "warning");
        return;
      } else if (!action) enabled = !enabled;

      ctx.ui.notify(
        enabled
          ? "Fast 已开启：请求将使用 priority 服务层级"
          : "Fast 已关闭：请求将使用默认服务层级",
        "info",
      );
    },
  });

  pi.on("model_select", (event) => {
    if (!isGptModelId(event.model.id)) enabled = false;
  });

  pi.on("before_provider_request", (event) => {
    if (!enabled || !event.payload || typeof event.payload !== "object") {
      return undefined;
    }

    const payload = event.payload as Record<string, unknown>;
    if (
      typeof payload.model !== "string" ||
      !isGptModelId(payload.model)
    ) {
      return undefined;
    }

    return { ...payload, service_tier: "priority" };
  });
}
