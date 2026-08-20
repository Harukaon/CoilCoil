export function quotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function insertPathsAtCaret(
  value: string,
  paths: string[],
  start: number,
  end: number,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before.length && !/\s$/.test(before) ? " " : "";
  const trailingSpace = after.length && !/^\s/.test(after) ? " " : "";
  const insertion = `${leadingSpace}${paths.map(quotePath).join(" ")}${trailingSpace}`;
  return { value: `${before}${insertion}${after}`, caret: start + insertion.length };
}

export function insertPathAtCaret(
  value: string,
  path: string,
  start: number,
  end: number,
): { value: string; caret: number } {
  return insertPathsAtCaret(value, [path], start, end);
}

export const COILCOIL_PATH_TYPE = "application/x-coilcoil-path";

/** 这次拖动带着可以插入的路径吗？dragover 时 `files` 还是空的，只能看 types。 */
export function carriesPaths(transfer: DataTransfer): boolean {
  return transfer.types.includes(COILCOIL_PATH_TYPE) || transfer.types.includes("Files");
}

/**
 * 一次拖放里要插入的绝对路径。
 *
 * 应用内的文件树用自定义 MIME 类型传路径；从访达 / 资源管理器拖进来的文件只有
 * `dataTransfer.files`，而 Electron 32 起 `File.path` 已被移除，真实路径只能由
 * 预加载里的 webUtils 解析。
 */
export function droppedPaths(transfer: DataTransfer): string[] {
  const serialized = transfer.getData(COILCOIL_PATH_TYPE);
  if (serialized) {
    const dropped = JSON.parse(serialized) as { path?: string };
    return dropped.path ? [dropped.path] : [];
  }
  return Array.from(transfer.files, (file) => window.coilcoil.filePath(file)).filter(Boolean);
}
