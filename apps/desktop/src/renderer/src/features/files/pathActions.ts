import { fileManagerLabel } from "../../../../shared/platform-labels";
import { toastError, toastSuccess } from "../../ui/toast";
import { rendererPlatform } from "../../platform";

/** "在访达中显示" on macOS, and the matching wording elsewhere. */
export function revealLabel(): string {
  return `在${fileManagerLabel(rendererPlatform())}中显示`;
}

/**
 * Put a value on the clipboard and say what was copied.
 *
 * These are things pasted into a terminal or another tool, and the copy is
 * confirmed by name: without the toast there is nothing to distinguish a copy
 * from a click that missed, and nothing to say which of two menu items ran.
 */
export async function copyText(value: string, what: string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toastSuccess(`已复制${what}`);
  } catch (caught) {
    toastError(caught instanceof Error ? caught.message : String(caught));
  }
}

export async function copyPath(path: string): Promise<void> {
  return copyText(path, "路径");
}

/** Show a file or folder in the operating system's file manager. */
export function revealPath(path: string): void {
  if (!path) return;
  void window.coilcoil.revealPath(path).catch((caught: unknown) => {
    toastError(caught instanceof Error ? caught.message : String(caught));
  });
}
