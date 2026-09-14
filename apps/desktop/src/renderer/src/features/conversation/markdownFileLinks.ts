/**
 * 这些协议点一下就可能替别人执行东西，一个都不留。
 *
 * 其余的一律原样保留——包括 `file:`。react-markdown 默认只放行 http/https/mailto/
 * tel，别的统统换成空字符串，而一个 `href=""` 的链接点下去，浏览器的默认行为是
 * **重新加载当前页面**；在 Electron 里当前页就是应用本身，于是整个界面重载一遍。
 * 2026-09-14 用户点一条写进记忆的 `file://` 链接，应用连着重启了四次，就是这么来
 * 的。留着地址，下面的 `parseMarkdownFileHref` 才认得出它是个文件，右键也才有东
 * 西可复制。
 *
 * 保留不等于会去访问：这些地址永远由我们自己的点击路由决定去向，从不交给浏览器
 * 的默认导航。
 */
const DANGEROUS_URL_SCHEMES = /^(?:javascript|data|vbscript):/i;

/** 交给 react-markdown 的地址处理：只挡危险协议，其余原样。 */
export function markdownUrlTransform(url: string): string {
  return DANGEROUS_URL_SCHEMES.test(url.trim()) ? "" : url;
}

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
