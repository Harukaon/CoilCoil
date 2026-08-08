import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

import { SUOCODE_PATH_TYPE } from "../features/composer/pathInsert";

function isSuocodePathDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(SUOCODE_PATH_TYPE);
}

function stillInsideTarget(event: ReactDragEvent<HTMLElement>): boolean {
  const related = event.relatedTarget;
  return related instanceof Node && event.currentTarget.contains(related);
}

export function useFilePathDrop({
  onInsertPath,
  onError,
}: {
  onInsertPath: (path: string) => void;
  onError: (message: string) => void;
}): {
  fileDragActive: boolean;
  handleFileDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  handleFileDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  handleFileDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  handleFileDrop: (event: ReactDragEvent<HTMLElement>) => void;
} {
  const [fileDragActive, setFileDragActive] = useState(false);
  const activeRef = useRef(false);

  const setActive = useCallback((next: boolean): void => {
    if (activeRef.current === next) return;
    activeRef.current = next;
    setFileDragActive(next);
  }, []);

  useEffect(() => {
    // Inline composers stopPropagation on drop so the pane never sees it;
    // clear the mask in capture phase / on dragend instead.
    const clear = (): void => setActive(false);
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
    };
  }, [setActive]);

  const handleFileDragEnter = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!isSuocodePathDrag(event)) return;
    event.preventDefault();
    setActive(true);
  }, [setActive]);

  const handleFileDragOver = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!isSuocodePathDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setActive(true);
  }, [setActive]);

  const handleFileDragLeave = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!isSuocodePathDrag(event)) return;
    // Ignore leave events that bubble while moving across child nodes;
    // those were clearing the mask and causing a one-frame flash.
    if (stillInsideTarget(event)) return;
    setActive(false);
  }, [setActive]);

  const handleFileDrop = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    const serialized = event.dataTransfer.getData(SUOCODE_PATH_TYPE);
    if (!serialized) return;
    event.preventDefault();
    setActive(false);
    try {
      const dropped = JSON.parse(serialized) as { path?: string };
      if (dropped.path) onInsertPath(dropped.path);
    } catch {
      onError("无法插入拖入的路径。请重新拖动一次。");
    }
  }, [onError, onInsertPath, setActive]);

  return { fileDragActive, handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop };
}
