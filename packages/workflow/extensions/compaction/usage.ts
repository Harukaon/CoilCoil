import type { Usage } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(target: Usage, source: Usage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += source[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += source.cost[key];
  if (source.cacheWrite1h) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + source.cacheWrite1h;
  if (source.reasoning) target.reasoning = (target.reasoning ?? 0) + source.reasoning;
}
