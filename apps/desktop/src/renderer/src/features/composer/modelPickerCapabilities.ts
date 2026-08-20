import type { ThinkingLevel } from "@coilcoil/runtime-protocol";

/** `off` is Pi's safe fallback, not a user-adjustable reasoning capability. */
export function hasConfigurableThinkingLevel(levels: readonly ThinkingLevel[] | undefined): boolean {
  return Boolean(levels?.some((level) => level !== "off"));
}
