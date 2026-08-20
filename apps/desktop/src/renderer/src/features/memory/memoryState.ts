import type { MemoryDocumentSnapshot, MemorySettings } from "@coilcoil/runtime-protocol";

export type MemoryScope = "global" | "project";

export const DEFAULT_MEMORY_SCOPE: MemoryScope = "project";

export function memoryEditorExpanded(
  scope: MemoryScope,
  documentPath: string | undefined,
  expandedProjectEditors: ReadonlySet<string>,
): boolean {
  return scope === "global"
    || Boolean(documentPath && expandedProjectEditors.has(documentPath));
}

export function memoryMaxChars(
  scope: MemoryScope,
  settings: MemorySettings | undefined,
  document: MemoryDocumentSnapshot | undefined,
): number {
  if (!settings) return document?.maxChars ?? 0;
  return scope === "global" ? settings.globalMaxChars : settings.projectMaxChars;
}
