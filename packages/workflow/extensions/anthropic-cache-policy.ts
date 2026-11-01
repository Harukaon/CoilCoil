import type { CacheRetention, TranscriptContext } from "@earendil-works/pi-ai";
import type { AnthropicCacheController } from "./cache/controller.ts";
export { anthropicCacheRetention } from "#cache/retention";

export const CACHED_SESSION_REQUEST = "coilcoil:cached-session-request:v1";

export interface CachedSessionRequest {
  model: { provider: string; id: string; api: string };
  context: TranscriptContext;
  cacheRetention: CacheRetention;
  at: number;
  cache?: AnthropicCacheController;
}
