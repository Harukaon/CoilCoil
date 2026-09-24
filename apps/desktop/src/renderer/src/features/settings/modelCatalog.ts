/**
 * The panel's half of the upstream model catalogue: fetching and caching.
 *
 * Parsing, merging and lookup moved to `@coilcoil/runtime-protocol` so the
 * `coilcoil` tool can fill in the same numbers from the runtime process. What
 * stays here is what only a browser has: `fetch` plus a localStorage cache,
 * and the picker helper that merges chosen ids into the edited model list.
 */
import {
  buildCatalogIndexFromSources,
  LITELLM_CATALOG_URL,
  lookupModelMetaInIndex,
  MODELS_DEV_CATALOG_URL,
  OPENROUTER_CATALOG_URL,
  type CatalogIndexEntry,
  type ModelCatalogMeta,
} from "@coilcoil/runtime-protocol/model-catalog";

export {
  buildCatalogIndexFromSources,
  candidateKeys,
  catalogSourceLabel,
  DEFAULT_THINKING_LEVELS,
  indexLiteLlmRows,
  indexModelsDev,
  indexOpenRouterRows,
  lookupModelMetaInIndex,
  mergeCatalogEntries,
  THINKING_LEVELS,
  thinkingLevelMapFromLevels,
  thinkingLevelsFromMap,
  thinkingLevelsFromReasoningOptions,
} from "@coilcoil/runtime-protocol/model-catalog";
export type { CatalogIndexEntry, CatalogSourceLabel, ModelCatalogMeta } from "@coilcoil/runtime-protocol/model-catalog";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_CACHE_KEY = "coilcoil.catalog.models-dev.v1";
const LITELLM_CACHE_KEY = "coilcoil.catalog.litellm.v1";
const OPENROUTER_CACHE_KEY = "coilcoil.catalog.openrouter.v1";

let memoryIndex: Map<string, CatalogIndexEntry[]> | undefined;
let loadPromise: Promise<Map<string, CatalogIndexEntry[]>> | undefined;

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

async function fetchModelsDev(): Promise<unknown | undefined> {
  const cached = readCache(MODELS_DEV_CACHE_KEY);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(MODELS_DEV_CATALOG_URL);
    if (!response.ok) return undefined;
    const payload = await response.json();
    writeCache(MODELS_DEV_CACHE_KEY, payload);
    return payload;
  } catch {
    return undefined;
  }
}

async function fetchOpenRouterCatalog(): Promise<unknown[] | undefined> {
  const cached = readCache(OPENROUTER_CACHE_KEY);
  if (Array.isArray(cached)) return cached;
  try {
    const response = await fetch(OPENROUTER_CATALOG_URL);
    if (!response.ok) return undefined;
    const payload = await response.json() as { data?: unknown[] };
    if (!Array.isArray(payload.data) || !payload.data.length) return undefined;
    writeCache(OPENROUTER_CACHE_KEY, payload.data);
    return payload.data;
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
      const url = `${LITELLM_CATALOG_URL}?mode=chat&page_size=500&page=${page}`;
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
  const [modelsDev, liteLlm, openRouter] = await Promise.all([
    fetchModelsDev(),
    fetchLiteLlmCatalog(),
    fetchOpenRouterCatalog(),
  ]);
  return buildCatalogIndexFromSources(modelsDev, liteLlm, openRouter);
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

export function lookupModelMeta(modelId: string): ModelCatalogMeta {
  if (!memoryIndex) return { sources: [] };
  return lookupModelMetaInIndex(memoryIndex, modelId);
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
