export function quotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function insertPathAtCaret(
  value: string,
  path: string,
  start: number,
  end: number,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before.length && !/\s$/.test(before) ? " " : "";
  const trailingSpace = after.length && !/^\s/.test(after) ? " " : "";
  const insertion = `${leadingSpace}${quotePath(path)}${trailingSpace}`;
  return { value: `${before}${insertion}${after}`, caret: start + insertion.length };
}

export const SUOCODE_PATH_TYPE = "application/x-suocode-path";
