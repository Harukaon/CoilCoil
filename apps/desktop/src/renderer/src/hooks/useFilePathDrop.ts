import { useCallback, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

const SUOCODE_PATH_TYPE = "application/x-suocode-path";

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
  const dragDepthRef = useRef(0);

  const handleFileDragEnter = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes(SUOCODE_PATH_TYPE)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setFileDragActive(true);
  }, []);

  const handleFileDragOver = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes(SUOCODE_PATH_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleFileDragLeave = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes(SUOCODE_PATH_TYPE)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setFileDragActive(false);
  }, []);

  const handleFileDrop = useCallback((event: ReactDragEvent<HTMLElement>): void => {
    const serialized = event.dataTransfer.getData(SUOCODE_PATH_TYPE);
    if (!serialized) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setFileDragActive(false);
    try {
      const dropped = JSON.parse(serialized) as { path?: string };
      if (dropped.path) onInsertPath(dropped.path);
    } catch {
      onError("无法插入拖入的路径。请重新拖动一次。");
    }
  }, [onError, onInsertPath]);

  return { fileDragActive, handleFileDragEnter, handleFileDragOver, handleFileDragLeave, handleFileDrop };
}
