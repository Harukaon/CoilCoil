import { useCallback, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export const FILE_PREVIEW_SHARE_KEY = "coilcoil.file-preview-share";
export const DEFAULT_FILE_PREVIEW_SHARE = 0.66;
const MINIMUM_PANE_WIDTH = 96;

export function clampFilePreviewShare(value: number, width: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FILE_PREVIEW_SHARE;
  const safeWidth = Math.max(1, width);
  const minimum = Math.min(0.45, MINIMUM_PANE_WIDTH / safeWidth);
  return Math.max(minimum, Math.min(1 - minimum, value));
}

export function readStoredFilePreviewShare(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): number {
  const value = Number(storage.getItem(FILE_PREVIEW_SHARE_KEY));
  return Number.isFinite(value) && value > 0 && value < 1
    ? value
    : DEFAULT_FILE_PREVIEW_SHARE;
}

function columns(share: number): string {
  return `minmax(0, ${share}fr) 7px minmax(0, ${1 - share}fr)`;
}

export function useFilePanelSplit(): {
  previewShare: number;
  beginResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
} {
  const [previewShare, setPreviewShare] = useState(readStoredFilePreviewShare);

  const commit = useCallback((share: number): void => {
    setPreviewShare(share);
    window.localStorage.setItem(FILE_PREVIEW_SHARE_KEY, String(share));
  }, []);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const separator = event.currentTarget;
    const workspace = event.currentTarget.closest(".files-workspace") as HTMLElement | null;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    let finalShare = previewShare;
    document.body.classList.add("resizing-panels");

    const move = (pointer: PointerEvent): void => {
      finalShare = clampFilePreviewShare((pointer.clientX - bounds.left) / bounds.width, bounds.width);
      workspace.style.gridTemplateColumns = columns(finalShare);
      separator.setAttribute("aria-valuenow", String(Math.round(finalShare * 100)));
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      commit(finalShare);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  }, [commit, previewShare]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const width = event.currentTarget.closest(".files-workspace")?.getBoundingClientRect().width ?? 400;
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    commit(clampFilePreviewShare(previewShare + direction * 0.04, width));
  }, [commit, previewShare]);

  return { previewShare, beginResize, handleResizeKeyDown };
}
