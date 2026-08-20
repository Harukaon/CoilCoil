import type { Api, Model } from "@earendil-works/pi-ai";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

interface RemoteModel {
  slug?: unknown;
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  visibility?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  max_output_tokens?: unknown;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
  service_tiers?: unknown;
}

export interface OpenAIResponsesWsCatalog {
  models: OpenAIResponsesWsModel[];
  fastModelIds: string[];
}

export interface OpenAIResponsesWsModel {
  id: string;
  name: string;
  api: Api;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: Array<"text" | "image">;
  cost: Model<Api>["cost"];
  contextWindow: number;
  maxTokens: number;
}

function positiveNumber(...values: unknown[]): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0) as number | undefined;
}

function nonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim())?.toString().trim();
}

function reasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const efforts = value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof (entry as { effort?: unknown }).effort === "string") {
      return [(entry as { effort: string }).effort];
    }
    return [];
  }).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return [...new Set(efforts)];
}

function thinkingLevelMap(efforts: string[]): Record<string, string | null> | undefined {
  if (efforts.length === 0) return undefined;
  const supported = new Set(efforts);
  return Object.fromEntries(THINKING_LEVELS.map((level) => [
    level,
    level === "off" ? (supported.has("none") ? "none" : null) : (supported.has(level) ? level : null),
  ]));
}

function inputModalities(value: unknown): Array<"text" | "image"> {
  const values = Array.isArray(value) ? value.map(String).map((entry) => entry.toLowerCase()) : [];
  return values.includes("image") ? ["text", "image"] : ["text"];
}

function toModel(value: unknown): { model: OpenAIResponsesWsModel; fast: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const remote = value as RemoteModel;
  if (String(remote.visibility ?? "").toLowerCase() === "hide") return undefined;
  const id = nonEmptyString(remote.slug, remote.id);
  if (!id) return undefined;
  const efforts = reasoningEfforts(remote.supported_reasoning_levels);
  return {
    model: {
      id,
      name: nonEmptyString(remote.display_name, remote.name, id) ?? id,
      api: "coilcoil-openai-responses-ws" as Api,
      reasoning: efforts.some((effort) => effort !== "none"),
      thinkingLevelMap: thinkingLevelMap(efforts),
      input: inputModalities(remote.input_modalities),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: positiveNumber(remote.context_window, remote.max_context_window) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: positiveNumber(remote.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
    },
    fast: Array.isArray(remote.service_tiers) && remote.service_tiers.length > 0,
  };
}

export function mapOpenAIResponsesWsCatalog(payload: unknown): OpenAIResponsesWsCatalog {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (Array.isArray((payload as { models?: unknown }).models)
          ? (payload as { models: unknown[] }).models
          : Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [])
      : [];
  const mapped = records.map(toModel).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return {
    models: mapped.map((entry) => entry.model),
    fastModelIds: mapped.filter((entry) => entry.fast).map((entry) => entry.model.id),
  };
}

export async function fetchOpenAIResponsesWsCatalog(
  modelsUrl: string,
  apiKey: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OpenAIResponsesWsCatalog> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(modelsUrl, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`模型目录请求失败：${response.status} ${response.statusText}${body ? ` · ${body.slice(0, 160)}` : ""}`);
  }
  return mapOpenAIResponsesWsCatalog(await response.json().catch(() => ({})));
}
