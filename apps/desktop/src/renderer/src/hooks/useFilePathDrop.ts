import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

import { carriesPaths, droppedPaths } from "../features/composer/pathInsert";

function stillInsideTarget(event: ReactDragEvent<HTMLElement>): boolean {
  const related = event.relatedTarget;
  return related instanceof Node && event.currentTarget.contains(related);
}

export function useFilePathDrop({
  onInsertPaths,
  onError,
}: {
  onInsertPaths: (paths: string[]) => void;
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
    // A file dropped anywhere without its own handler makes the window navigate
    // to that file. Only files are swallowed, so dragging text inside the
    // textarea still behaves natively.
    const swallowFileDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("dragover", swallowFileDrop);
    window.addEventListener("drop", swallowFileDrop);
    return () => {
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("dragover", swallowFileDrop);
      window.removeEventListener("drop", swallowFileDrop);
    };
  }, [setActive]);

  const handleFileDragEnter = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!carriesPaths(event.dataTransfer)) return;
    event.preventDefault();
    setActive(true);
  }, [setActive]);

  const handleFileDragOver = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!carriesPaths(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setActive(true);
  }, [setActive]);

  const handleFileDragLeave = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!carriesPaths(event.dataTransfer)) return;
    // Ignore leave events that bubble while moving across child nodes;
    // those were clearing the mask and causing a one-frame flash.
    if (stillInsideTarget(event)) return;
    setActive(false);
  }, [setActive]);

  const handleFileDrop = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!carriesPaths(event.dataTransfer)) return;
    event.preventDefault();
    setActive(false);
    try {
      const paths = droppedPaths(event.dataTransfer);
      if (paths.length) onInsertPaths(paths);
    } catch {
      onError("无法插入拖入的路径。请重新拖动一次。");
    }
  }, [onError, onInsertPaths, setActive]);

  return { fileDragActive, handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop };
}
