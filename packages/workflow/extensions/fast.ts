import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FAST_STATE_EVENT = "coilcoil:fast:state:v1";
export const FAST_POLICY_ENTRY = "coilcoil-fast-policy";

export interface FastState {
  version: 1;
  enabled: boolean;
  supported: boolean;
  modelId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isGptModelId(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const leafId = modelId.split("/").at(-1) ?? modelId;
  return /^gpt-/i.test(leafId);
}

export function restoredFastState(entries: readonly unknown[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FAST_POLICY_ENTRY || !isRecord(entry.data)) continue;
    return entry.data.enabled === true;
  }
  return false;
}

export function applyFastServiceTier(payload: unknown, enabled: boolean): unknown {
  if (!enabled || !isRecord(payload) || !isGptModelId(typeof payload.model === "string" ? payload.model : undefined)) return undefined;
  return { ...payload, service_tier: "priority" };
}

export default function fastExtension(pi: ExtensionAPI): void {
  let enabled = false;
  let modelId: string | undefined;

  const state = (): FastState => ({
    version: 1,
    enabled,
    supported: isGptModelId(modelId),
    modelId,
  });
  const publish = (): void => pi.events.emit(FAST_STATE_EVENT, state());
  const persist = (): void => pi.appendEntry(FAST_POLICY_ENTRY, { version: 1, enabled });
  const restore = (entries: readonly unknown[], nextModelId: string | undefined): void => {
    modelId = nextModelId;
    enabled = isGptModelId(modelId) && restoredFastState(entries);
    publish();
  };

  pi.registerCommand("fast", {
    description: "Toggle the OpenAI priority service tier",
    handler: async (args, ctx) => {
      modelId = ctx.model?.id;
      if (!isGptModelId(modelId)) {
        enabled = false;
        publish();
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

      if (action !== "status") persist();
      publish();

      ctx.ui.notify(
        enabled
          ? "Fast 已开启：请求将使用 priority 服务层级"
          : "Fast 已关闭：请求将使用默认服务层级",
        "info",
      );
    },
  });

  pi.on("model_select", (event) => {
    modelId = event.model.id;
    if (!isGptModelId(modelId) && enabled) {
      enabled = false;
      persist();
    }
    publish();
  });

  pi.on("before_provider_request", (event) => {
    return applyFastServiceTier(event.payload, enabled);
  });

  pi.on("session_start", (_event, ctx) => restore(ctx.sessionManager.getBranch(), ctx.model?.id));
  pi.on("session_tree", (_event, ctx) => restore(ctx.sessionManager.getBranch(), ctx.model?.id));
}
