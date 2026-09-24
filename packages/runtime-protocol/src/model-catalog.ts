/**
 * Upstream model metadata: the part both the settings panel and the Agent need.
 *
 * A provider's `/models` endpoint hands back ids and nothing else — no context
 * window, no output cap, no "does it take images". Those live in public
 * catalogues (models.dev, LiteLLM), and the panel has always merged them so a
 * user can pick a model and get the numbers filled in. The `coilcoil` tool has
 * to fill in the same numbers, from a Node process rather than a browser, so
 * everything here is pure: indexing, merging and lookup with no fetch and no
 * storage. Each side brings its own cache; neither side gets its own parser,
 * because two parsers is how the panel and the Agent start disagreeing about
 * what a model can do.
 */
import type { ThinkingLevel } from "./index.js";

export type CatalogSourceLabel = "models.dev" | "OpenRouter" | "LiteLLM";

export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
export const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const LITELLM_CATALOG_URL = "https://api.litellm.ai/model_catalog";

/** Pi's thinking ladder, in the order it presents the levels. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Levels Pi offers for a reasoning model that states no explicit mapping. */
export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export interface ModelCatalogMeta {
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  /** Thinking levels the model actually accepts, when the catalogue states them. */
  thinkingLevels?: ThinkingLevel[];
  name?: string;
  sources: CatalogSourceLabel[];
}

export interface CatalogIndexEntry {
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
  name?: string;
  source: CatalogSourceLabel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function candidateKeys(modelId: string): string[] {
  const raw = modelId.trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const leaf = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  const leafBase = leaf.split(":")[0] ?? leaf;
  const rawBase = lower.split(":")[0] ?? lower;
  return [...new Set([raw, lower, rawBase, leaf, leafBase].filter(Boolean))];
}

function addEntry(index: Map<string, CatalogIndexEntry[]>, keys: string[], entry: CatalogIndexEntry): void {
  for (const key of keys) {
    const list = index.get(key) ?? [];
    list.push(entry);
    index.set(key, list);
  }
}

/**
 * Read models.dev `reasoning_options` into Pi's thinking ladder.
 *
 * Only `effort` options carry a vocabulary CoilCoil can map; a `toggle` or a
 * `budget_tokens` model says nothing about which effort words it accepts, so
 * those stay unstated and keep Pi's own default ladder.
 */
export function thinkingLevelsFromReasoningOptions(value: unknown): ThinkingLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = new Set<ThinkingLevel>();
  let sawEffort = false;
  for (const option of value) {
    if (!isRecord(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
    sawEffort = true;
    for (const raw of option.values) {
      if (typeof raw !== "string") continue;
      const level = raw.trim().toLowerCase();
      // models.dev spells "thinking disabled" as `none`; Pi calls it `off`.
      if (level === "none") levels.add("off");
      else if ((THINKING_LEVELS as readonly string[]).includes(level)) levels.add(level as ThinkingLevel);
    }
  }
  if (!sawEffort || levels.size === 0) return undefined;
  return THINKING_LEVELS.filter((level) => levels.has(level));
}

/**
 * Write a level set as Pi's `thinkingLevelMap`.
 *
 * Every level is listed: a supported one maps to its own effort word, an
 * unsupported one to `null`, which is how Pi is told to hide it.
 */
export function thinkingLevelMapFromLevels(levels: readonly ThinkingLevel[]): Record<string, string | null> {
  const supported = new Set(levels);
  return Object.fromEntries(THINKING_LEVELS.map((level) => [level, supported.has(level) ? level : null]));
}

/** Read the levels a `thinkingLevelMap` leaves available, mirroring Pi's own rule. */
export function thinkingLevelsFromMap(
  map: Partial<Record<string, string | null>> | undefined,
  reasoning: boolean,
): ThinkingLevel[] {
  if (!reasoning) return ["off"];
  if (!map || Object.keys(map).length === 0) return [...DEFAULT_THINKING_LEVELS];
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    // Pi only offers xhigh and max when a mapping names them.
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function indexModelsDev(payload: unknown, index: Map<string, CatalogIndexEntry[]> = new Map()): Map<string, CatalogIndexEntry[]> {
  if (!isRecord(payload)) return index;
  for (const provider of Object.values(payload)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue;
      const limit = isRecord(model.limit) ? model.limit : {};
      const modalities = isRecord(model.modalities) ? model.modalities : {};
      const inputMods = Array.isArray(modalities.input) ? modalities.input.filter((item): item is string => typeof item === "string") : [];
      const hasImage = Boolean(model.attachment) || inputMods.includes("image");
      const entry: CatalogIndexEntry = {
        source: "models.dev",
        name: typeof model.name === "string" ? model.name : undefined,
        contextWindow: positiveInt(limit.context),
        maxTokens: positiveInt(limit.output),
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
        thinkingLevels: thinkingLevelsFromReasoningOptions(model.reasoning_options),
        input: hasImage ? ["text", "image"] : inputMods.includes("text") ? ["text"] : undefined,
      };
      const id = typeof model.id === "string" && model.id.trim() ? model.id : modelId;
      addEntry(index, [...candidateKeys(id), ...candidateKeys(modelId)], entry);
    }
  }
  return index;
}

export function indexOpenRouterRows(rows: unknown[], index: Map<string, CatalogIndexEntry[]> = new Map()): Map<string, CatalogIndexEntry[]> {
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) continue;
    const architecture = isRecord(row.architecture) ? row.architecture : {};
    const inputModalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities.filter((item): item is string => typeof item === "string")
      : [];
    const supportedParameters = Array.isArray(row.supported_parameters)
      ? row.supported_parameters.filter((item): item is string => typeof item === "string")
      : [];
    const topProvider = isRecord(row.top_provider) ? row.top_provider : {};
    const entry: CatalogIndexEntry = {
      source: "OpenRouter",
      name: typeof row.name === "string" ? row.name : undefined,
      contextWindow: positiveInt(row.context_length),
      maxTokens: positiveInt(topProvider.max_completion_tokens),
      reasoning: supportedParameters.includes("reasoning") || supportedParameters.includes("include_reasoning")
        ? true
        : undefined,
      input: inputModalities.includes("image") ? ["text", "image"] : inputModalities.includes("text") ? ["text"] : undefined,
    };
    addEntry(index, candidateKeys(row.id), entry);
  }
  return index;
}

export function indexLiteLlmRows(rows: unknown[], index: Map<string, CatalogIndexEntry[]> = new Map()): Map<string, CatalogIndexEntry[]> {
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) continue;
    const entry: CatalogIndexEntry = {
      source: "LiteLLM",
      contextWindow: positiveInt(row.max_input_tokens),
      maxTokens: positiveInt(row.max_output_tokens) ?? positiveInt(row.max_tokens),
      reasoning: typeof row.supports_reasoning === "boolean" ? row.supports_reasoning : undefined,
      input: row.supports_vision === true ? ["text", "image"] : row.supports_vision === false ? ["text"] : undefined,
    };
    addEntry(index, candidateKeys(row.id), entry);
  }
  return index;
}

export function buildCatalogIndexFromSources(
  modelsDev?: unknown,
  liteLlm?: unknown[],
  openRouter?: unknown[],
): Map<string, CatalogIndexEntry[]> {
  const index = new Map<string, CatalogIndexEntry[]>();
  if (modelsDev !== undefined) indexModelsDev(modelsDev, index);
  if (openRouter) indexOpenRouterRows(openRouter, index);
  if (liteLlm) indexLiteLlmRows(liteLlm, index);
  return index;
}

export function mergeCatalogEntries(entries: CatalogIndexEntry[]): ModelCatalogMeta {
  const modelsDev = entries.filter((item) => item.source === "models.dev");
  const openRouter = entries.filter((item) => item.source === "OpenRouter");
  const liteLlm = entries.filter((item) => item.source === "LiteLLM");
  const ordered = [...modelsDev, ...openRouter, ...liteLlm];
  const meta: ModelCatalogMeta = { sources: [] };
  const seenSources = new Set<CatalogSourceLabel>();
  for (const entry of ordered) {
    if (!seenSources.has(entry.source)) {
      seenSources.add(entry.source);
      meta.sources.push(entry.source);
    }
    if (meta.name === undefined && entry.name) meta.name = entry.name;
    if (meta.contextWindow === undefined && entry.contextWindow !== undefined) meta.contextWindow = entry.contextWindow;
    if (meta.maxTokens === undefined && entry.maxTokens !== undefined) meta.maxTokens = entry.maxTokens;
    if (meta.reasoning === undefined && entry.reasoning !== undefined) meta.reasoning = entry.reasoning;
    if (meta.thinkingLevels === undefined && entry.thinkingLevels?.length) meta.thinkingLevels = entry.thinkingLevels;
    if (meta.input === undefined && entry.input) meta.input = entry.input;
  }
  return meta;
}

export function lookupModelMetaInIndex(index: Map<string, CatalogIndexEntry[]>, modelId: string): ModelCatalogMeta {
  const matched: CatalogIndexEntry[] = [];
  const seen = new Set<CatalogIndexEntry>();
  for (const key of candidateKeys(modelId)) {
    const list = index.get(key);
    if (!list) continue;
    for (const entry of list) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      matched.push(entry);
    }
  }
  if (!matched.length) {
    const leaf = modelId.trim().toLowerCase().split("/").pop()?.split(":")[0];
    if (leaf) {
      for (const [key, list] of index) {
        if (key === leaf || key.endsWith(`/${leaf}`)) {
          for (const entry of list) {
            if (seen.has(entry)) continue;
            seen.add(entry);
            matched.push(entry);
          }
        }
      }
    }
  }
  return mergeCatalogEntries(matched);
}

export function catalogSourceLabel(meta: ModelCatalogMeta): string {
  if (!meta.sources.length) return "未匹配";
  return meta.sources.join(" + ");
}

/** One model's metadata as the `coilcoil` tool reports it back. */
export interface ModelCatalogLookupEntry extends ModelCatalogMeta {
  modelId: string;
}

export interface ModelCatalogLookupResult {
  entries: ModelCatalogLookupEntry[];
  /** Which catalogues answered at all; empty means both were unreachable. */
  availableSources: CatalogSourceLabel[];
  fetchedAt?: number;
}
