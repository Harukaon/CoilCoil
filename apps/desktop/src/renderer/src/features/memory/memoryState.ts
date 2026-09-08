import type { MemoryDocumentSnapshot, MemorySettings } from "@coilcoil/runtime-protocol";

export type MemoryScope = "global" | "project";

/**
 * The character budget a memory document is measured against.
 *
 * Unsaved settings win over the document's own `maxChars`: the number beside the
 * editor has to track the limit being typed into the box above it, not the one
 * the file was last read with.
 */
export function memoryMaxChars(
  scope: MemoryScope,
  settings: MemorySettings | undefined,
  document: MemoryDocumentSnapshot | undefined,
): number {
  if (!settings) return document?.maxChars ?? 0;
  return scope === "global" ? settings.globalMaxChars : settings.projectMaxChars;
}
