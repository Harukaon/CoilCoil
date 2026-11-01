import type { CacheRetention, StreamOptions } from "@earendil-works/pi-ai";

/** Explicit request/environment choices win; only Claude subscriptions default to an hour. */
export function anthropicCacheRetention(
  api: string,
  subscription: boolean,
  options: Pick<StreamOptions, "cacheRetention" | "env"> = {},
  env: NodeJS.ProcessEnv = process.env,
): CacheRetention | undefined {
  if (options.cacheRetention !== undefined) return options.cacheRetention;
  if (api !== "anthropic-messages") return undefined;
  const configured = options.env?.PI_CACHE_RETENTION ?? env.PI_CACHE_RETENTION;
  if (configured === "none" || configured === "short" || configured === "long") return configured;
  return subscription ? "long" : undefined;
}
