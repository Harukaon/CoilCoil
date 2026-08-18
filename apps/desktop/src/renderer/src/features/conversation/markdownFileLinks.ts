export interface MarkdownFileTarget {
  path: string;
  line?: number;
  column?: number;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function absoluteFilePath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

function splitLocation(value: string): MarkdownFileTarget | undefined {
  let path = decodePath(value);
  let line: number | undefined;
  let column: number | undefined;
  const fragment = path.match(/#L([1-9]\d*)(?:C([1-9]\d*))?(?:-L?[1-9]\d*)?$/i);
  if (fragment) {
    line = Number(fragment[1]);
    column = fragment[2] ? Number(fragment[2]) : undefined;
    path = path.slice(0, fragment.index);
  } else {
    const lineAndColumn = path.match(/^(.*):([1-9]\d*):([1-9]\d*)$/);
    const lineOnly = lineAndColumn ? undefined : path.match(/^(.*):([1-9]\d*)$/);
    const suffix = lineAndColumn ?? lineOnly;
    if (suffix && absoluteFilePath(suffix[1])) {
      path = suffix[1];
      line = Number(suffix[2]);
      column = lineAndColumn ? Number(lineAndColumn[3]) : undefined;
    }
  }
  return absoluteFilePath(path) ? { path, line, column } : undefined;
}

export function parseMarkdownFileHref(href: string | undefined): MarkdownFileTarget | undefined {
  const value = href?.trim();
  if (!value) return undefined;
  if (!/^file:/i.test(value)) return splitLocation(value);
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return undefined;
    const windowsPath = /^\/[A-Za-z]:\//.test(url.pathname) ? url.pathname.slice(1) : url.pathname;
    return splitLocation(`${windowsPath}${url.hash}`);
  } catch {
    return undefined;
  }
}
