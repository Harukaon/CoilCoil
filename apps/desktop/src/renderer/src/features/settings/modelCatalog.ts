export type CatalogSourceLabel = "models.dev" | "LiteLLM";

export interface ModelCatalogMeta {
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  name?: string;
  sources: CatalogSourceLabel[];
}

export interface CatalogIndexEntry {
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  name?: string;
  source: CatalogSourceLabel;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_CACHE_KEY = "suocode.catalog.models-dev.v1";
const LITELLM_CACHE_KEY = "suocode.catalog.litellm.v1";
const MODELS_DEV_URL = "https://models.dev/api.json";
const LITELLM_URL = "https://api.litellm.ai/model_catalog";

let memoryIndex: Map<string, CatalogIndexEntry[]> | undefined;
let loadPromise: Promise<Map<string, CatalogIndexEntry[]>> | undefined;

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

function readCache(key: string): unknown | undefined {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return undefined;
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { savedAt?: number; payload?: unknown };
    if (!parsed || typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > CACHE_TTL_MS) return undefined;
    return parsed.payload;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, payload: unknown): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    storage.setItem(key, JSON.stringify({ savedAt: Date.now(), payload }));
  } catch {
    // ignore quota / private mode
  }
}

function addEntry(index: Map<string, CatalogIndexEntry[]>, keys: string[], entry: CatalogIndexEntry): void {
  for (const key of keys) {
    const list = index.get(key) ?? [];
    list.push(entry);
    index.set(key, list);
  }
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
        input: hasImage ? ["text", "image"] : inputMods.includes("text") || inputMods.length === 0 ? ["text"] : undefined,
      };
      const id = typeof model.id === "string" && model.id.trim() ? model.id : modelId;
      addEntry(index, [...candidateKeys(id), ...candidateKeys(modelId)], entry);
    }
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

export function buildCatalogIndexFromSources(modelsDev?: unknown, liteLlm?: unknown[]): Map<string, CatalogIndexEntry[]> {
  const index = new Map<string, CatalogIndexEntry[]>();
  if (modelsDev !== undefined) indexModelsDev(modelsDev, index);
  if (liteLlm) indexLiteLlmRows(liteLlm, index);
  return index;
}

async function fetchModelsDev(): Promise<unknown | undefined> {
  const cached = readCache(MODELS_DEV_CACHE_KEY);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(MODELS_DEV_URL);
    if (!response.ok) return undefined;
    const payload = await response.json();
    writeCache(MODELS_DEV_CACHE_KEY, payload);
    return payload;
  } catch {
    return undefined;
  }
}

async function fetchLiteLlmCatalog(): Promise<unknown[] | undefined> {
  const cached = readCache(LITELLM_CACHE_KEY);
  if (Array.isArray(cached)) return cached;
  try {
    const rows: unknown[] = [];
    let page = 1;
    for (;;) {
      const url = `${LITELLM_URL}?mode=chat&page_size=500&page=${page}`;
      const response = await fetch(url);
      if (!response.ok) break;
      const payload = await response.json() as { data?: unknown[]; has_more?: boolean };
      if (Array.isArray(payload.data)) rows.push(...payload.data);
      if (!payload.has_more || !payload.data?.length) break;
      page += 1;
      if (page > 20) break;
    }
    if (!rows.length) return undefined;
    writeCache(LITELLM_CACHE_KEY, rows);
    return rows;
  } catch {
    return undefined;
  }
}

async function buildCatalogIndex(): Promise<Map<string, CatalogIndexEntry[]>> {
  const [modelsDev, liteLlm] = await Promise.all([fetchModelsDev(), fetchLiteLlmCatalog()]);
  return buildCatalogIndexFromSources(modelsDev, liteLlm);
}

export async function loadModelCatalog(): Promise<void> {
  if (memoryIndex) return;
  if (!loadPromise) {
    loadPromise = buildCatalogIndex().then((index) => {
      memoryIndex = index;
      return index;
    }).finally(() => {
      loadPromise = undefined;
    });
  }
  await loadPromise;
}

/** Test helper: replace in-memory index without network. */
export function setCatalogIndexForTests(index: Map<string, CatalogIndexEntry[]> | undefined): void {
  memoryIndex = index;
  loadPromise = undefined;
}

export function mergeCatalogEntries(entries: CatalogIndexEntry[]): ModelCatalogMeta {
  const modelsDev = entries.filter((item) => item.source === "models.dev");
  const liteLlm = entries.filter((item) => item.source === "LiteLLM");
  const ordered = [...modelsDev, ...liteLlm];
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

export function lookupModelMeta(modelId: string): ModelCatalogMeta {
  if (!memoryIndex) return { sources: [] };
  return lookupModelMetaInIndex(memoryIndex, modelId);
}

export function catalogSourceLabel(meta: ModelCatalogMeta): string {
  if (!meta.sources.length) return "未匹配";
  return meta.sources.join(" + ");
}

/** Merge selected upstream ids into local model list; keep existing fields for same id. */
export function mergeSelectedUpstreamModels<T extends { id: string }>(
  existing: T[],
  selectedIds: string[],
  create: (id: string) => T,
): { next: T[]; added: T[] } {
  const existingById = new Map(existing.filter((model) => model.id.trim()).map((model) => [model.id, model]));
  const added: T[] = [];
  for (const id of selectedIds) {
    if (!id.trim() || existingById.has(id)) continue;
    const created = create(id);
    added.push(created);
    existingById.set(id, created);
  }
  const kept = existing.filter((model) => model.id.trim());
  const next = [...kept, ...added];
  return { next: next.length ? next : existing, added };
}
