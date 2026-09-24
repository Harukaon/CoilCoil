/**
 * The runtime's copy of the panel's model catalogue.
 *
 * The settings panel fetches models.dev, OpenRouter and LiteLLM in the browser and keeps
 * them in localStorage; the `coilcoil` tool needs the same numbers while it is
 * writing a provider into models.json, and it runs here, in Node. Parsing is
 * shared (`@coilcoil/runtime-protocol`); what differs is the cache — a file in
 * the agent directory with the same one-day life as the panel's.
 *
 * A catalogue that cannot be reached is not an error: the answer is simply
 * "no metadata for this id", and the caller fills the numbers in by hand.
 */
import {
  buildCatalogIndexFromSources,
  LITELLM_CATALOG_URL,
  lookupModelMetaInIndex,
  MODELS_DEV_CATALOG_URL,
  OPENROUTER_CATALOG_URL,
  type CatalogIndexEntry,
  type CatalogSourceLabel,
  type ModelCatalogLookupEntry,
  type ModelCatalogLookupResult,
} from "@coilcoil/runtime-protocol/model-catalog";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "./runtime-utils.js";

const CACHE_FILE = "model-catalog-cache.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const LITELLM_MAX_PAGES = 20;

interface CatalogPayloads {
  fetchedAt: number;
  modelsDev?: unknown;
  openRouter?: unknown[];
  liteLlm?: unknown[];
}

interface LoadedCatalog {
  index: Map<string, CatalogIndexEntry[]>;
  availableSources: CatalogSourceLabel[];
  fetchedAt?: number;
}

/** One index per process: rebuilding it for every lookup would re-parse megabytes. */
let memo: { agentDir: string; loaded: LoadedCatalog } | undefined;
let inFlight: Promise<LoadedCatalog> | undefined;

function cachePath(agentDir: string): string {
  return join(agentDir, CACHE_FILE);
}

function readCache(agentDir: string): CatalogPayloads | undefined {
  const path = cachePath(agentDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || typeof parsed.fetchedAt !== "number") return undefined;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return undefined;
    return {
      fetchedAt: parsed.fetchedAt,
      modelsDev: parsed.modelsDev,
      openRouter: Array.isArray(parsed.openRouter) ? parsed.openRouter : undefined,
      liteLlm: Array.isArray(parsed.liteLlm) ? parsed.liteLlm : undefined,
    };
  } catch {
    return undefined;
  }
}

function writeCache(agentDir: string, payloads: CatalogPayloads): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    const path = cachePath(agentDir);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(payloads), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch {
    // A catalogue that cannot be cached still works; it just costs a fetch next time.
  }
}

async function fetchJson(url: string): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

async function fetchOpenRouterRows(): Promise<unknown[] | undefined> {
  const payload = await fetchJson(OPENROUTER_CATALOG_URL);
  if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.length) return undefined;
  return payload.data;
}

async function fetchLiteLlmRows(): Promise<unknown[] | undefined> {
  const rows: unknown[] = [];
  for (let page = 1; page <= LITELLM_MAX_PAGES; page += 1) {
    const payload = await fetchJson(`${LITELLM_CATALOG_URL}?mode=chat&page_size=500&page=${page}`);
    if (!isRecord(payload)) break;
    const data = Array.isArray(payload.data) ? payload.data : [];
    rows.push(...data);
    if (payload.has_more !== true || !data.length) break;
  }
  return rows.length ? rows : undefined;
}

function toLoaded(payloads: CatalogPayloads): LoadedCatalog {
  const availableSources: CatalogSourceLabel[] = [];
  if (payloads.modelsDev !== undefined) availableSources.push("models.dev");
  if (payloads.openRouter?.length) availableSources.push("OpenRouter");
  if (payloads.liteLlm?.length) availableSources.push("LiteLLM");
  return {
    index: buildCatalogIndexFromSources(payloads.modelsDev, payloads.liteLlm, payloads.openRouter),
    availableSources,
    fetchedAt: payloads.fetchedAt,
  };
}

async function loadCatalog(agentDir: string, refresh: boolean): Promise<LoadedCatalog> {
  if (!refresh && memo?.agentDir === agentDir) return memo.loaded;
  if (!refresh) {
    const cached = readCache(agentDir);
    if (cached) {
      const loaded = toLoaded(cached);
      memo = { agentDir, loaded };
      return loaded;
    }
  }
  if (inFlight && !refresh) return inFlight;
  const task = (async (): Promise<LoadedCatalog> => {
    const [modelsDev, openRouter, liteLlm] = await Promise.all([
      fetchJson(MODELS_DEV_CATALOG_URL),
      fetchOpenRouterRows(),
      fetchLiteLlmRows(),
    ]);
    const payloads: CatalogPayloads = { fetchedAt: Date.now(), modelsDev, openRouter, liteLlm };
    if (modelsDev !== undefined || openRouter?.length || liteLlm?.length) writeCache(agentDir, payloads);
    const loaded = toLoaded(payloads);
    memo = { agentDir, loaded };
    return loaded;
  })().finally(() => {
    inFlight = undefined;
  });
  inFlight = task;
  return task;
}

/** Test seam: drop the in-process index so the next lookup reads cache or network again. */
export function resetModelCatalogMemo(): void {
  memo = undefined;
  inFlight = undefined;
}

/**
 * Metadata for the given model ids, from whichever catalogue knows them.
 *
 * Ids that match nothing still come back, with empty `sources`: "we looked and
 * found nothing" is an answer the caller has to be able to tell apart from
 * "we did not look".
 */
export async function lookupModelCatalogMeta(
  agentDir: string,
  modelIds: readonly string[],
  options: { refresh?: boolean } = {},
): Promise<ModelCatalogLookupResult> {
  const loaded = await loadCatalog(agentDir, options.refresh === true);
  const seen = new Set<string>();
  const entries: ModelCatalogLookupEntry[] = [];
  for (const raw of modelIds) {
    const modelId = raw.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    entries.push({ modelId, ...lookupModelMetaInIndex(loaded.index, modelId) });
  }
  return { entries, availableSources: loaded.availableSources, fetchedAt: loaded.fetchedAt };
}
