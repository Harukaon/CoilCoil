import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/** Subscription aliases must summarize with the same native capabilities as their main requests. */
export function nativeSummaryModel(model: Model<Api>, apiKey?: string): Model<Api> {
  if (model.api !== "anthropic-messages" || !apiKey?.includes("sk-ant-oat")) return model;
  const builtin = getBuiltinModels("anthropic").find((entry) => entry.id === model.id && entry.api === model.api);
  if (!builtin) return model;
  return { ...model, compat: { ...builtin.compat, ...model.compat } } as Model<Api>;
}
