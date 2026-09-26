/**
 * 内置浏览器替 Agent 收掉了哪些标签页——在工具返回里告诉它。
 *
 * Agent 开的标签页每个会话只留最近用过的几张（桌面端 browser-agent-tabs.ts）：它
 * 再开新页、超过上限时，最久没用的那张会被关掉。关页发生在桌面端，Agent 看到的工具
 * 返回却是运行时这边的 chrome-devtools-mcp 生成的，所以每次调完内置浏览器，都来桌面
 * 端的 CDP 桥取一次「刚才收掉了哪些」，追加到这次返回的末尾。桥的地址和令牌就是
 * 连浏览器时用的那一套（COILCOIL_BROWSER_MCP_ARGS），不需要另开通道。
 *
 * 页面编号是 chrome-devtools-mcp 自己编的，桌面端不知道，所以这里记着最近一次页面
 * 列表里「编号 ↔ 网址」的对应，收页时按网址查回编号。
 */

export const BROWSER_MCP_SERVER = "coilcoil-browser";

export interface RecycledTab {
  url: string;
  title: string;
}

interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

export function recycledTabsEndpoint(scope: string, env: NodeJS.ProcessEnv = process.env): Endpoint | undefined {
  return browserBridgeEndpoint("recycled-tabs", scope, env);
}

/** 桌面端 CDP 桥上 CoilCoil 自己的 HTTP 接口（回收记录、标签页列表），和 CDP 连接同一套地址和令牌。 */
export function browserBridgeEndpoint(path: string, scope: string, env: NodeJS.ProcessEnv = process.env): Endpoint | undefined {
  try {
    const args = JSON.parse(env.COILCOIL_BROWSER_MCP_ARGS ?? "") as unknown;
    if (!Array.isArray(args)) return undefined;
    const valueAfter = (flag: string): string | undefined => {
      const index = args.indexOf(flag);
      return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] as string : undefined;
    };
    const endpoint = valueAfter("--wsEndpoint");
    if (!endpoint) return undefined;
    const socket = new URL(endpoint);
    const token = /^\/devtools\/browser\/([^/]+)$/.exec(socket.pathname)?.[1];
    if (!token) return undefined;
    const headers = JSON.parse(valueAfter("--wsHeaders") ?? "{}") as Record<string, string>;
    const url = new URL(`http://${socket.host}/coilcoil/${path}/${token}`);
    url.searchParams.set("scope", scope);
    return { url: url.toString(), headers };
  } catch {
    return undefined;
  }
}

/** 取一次就清空；桥不在（CLI、测试）或者出错都当作没有。 */
export async function takeRecycledTabs(
  scope: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ limit?: number; recycled: RecycledTab[] }> {
  const endpoint = recycledTabsEndpoint(scope, env);
  if (!endpoint) return { recycled: [] };
  try {
    const response = await fetchImpl(endpoint.url, { headers: endpoint.headers, signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { recycled: [] };
    const body = await response.json() as { limit?: unknown; recycled?: unknown };
    const recycled = Array.isArray(body.recycled)
      ? body.recycled.filter((entry): entry is RecycledTab =>
        Boolean(entry) && typeof (entry as RecycledTab).url === "string" && typeof (entry as RecycledTab).title === "string")
      : [];
    return { limit: typeof body.limit === "number" ? body.limit : undefined, recycled };
  } catch {
    return { recycled: [] };
  }
}

/**
 * 挂在 globalThis 上的共享状态。
 *
 * browser-act 和 mcp 两个扩展各自加载这个模块，拿到的是两份模块实例：编号记在
 * 一份里，另一份就查不到。按会话共享才对得上。
 */
function shared<T>(name: string, create: () => T): T {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(`coilcoil-workflow.browser-recycle.${name}`);
  globals[key] ??= create();
  return globals[key] as T;
}

/** 最近一次看到的页面编号，按会话记。 */
const pageIdsBySession = shared("page-ids", () => new Map<string, Map<string, number>>());

/** 从 chrome-devtools-mcp 的页面列表（`1: 标题 (网址) [selected]`）里记下编号。 */
export function rememberPageIds(session: string, text: string): void {
  const found = new Map<string, number>();
  for (const match of text.matchAll(/^(\d+): .* \(([^()\s]+)\)/gm)) found.set(match[2], Number(match[1]));
  if (found.size) pageIdsBySession.set(session, found);
}

export function recycleNotice(
  session: string,
  result: { limit?: number; recycled: RecycledTab[] },
): string {
  if (!result.recycled.length) return "";
  const ids = pageIdsBySession.get(session);
  const lines = result.recycled.map((tab) => {
    const id = ids?.get(tab.url);
    return `- ${id !== undefined ? `id=${id} 的标签页` : "一张标签页"}，url 是：${tab.url}${tab.title ? `（${tab.title}）` : ""}`;
  });
  const limit = result.limit !== undefined ? `${result.limit} 张` : "上限";
  return [
    "",
    `【浏览器提示】你打开的标签页超过了 ${limit}，已自动回收最久没用的：`,
    ...lines,
    "之后还要用这些页面，就用 new_page 按上面的 url 重新打开；页面编号以 list_pages 为准。",
  ].join("\n");
}

/** 还没交给 Agent 的提示：一个工具可能连着调好几次浏览器，攒到它返回时一起说。 */
const pendingNotices = shared("pending-notices", () => new Map<string, string[]>());

/**
 * 每调完一次内置浏览器就调一次。
 *
 * 先取回收记录、用旧的编号对应算出提示，再用这次的返回更新编号：新开页面那次的
 * 页面列表里已经没有被收掉的那张了，先更新就查不到它原来的编号。
 */
export async function noteBrowserCall(session: string | undefined, text: string): Promise<void> {
  if (!session) return;
  const notice = recycleNotice(session, await takeRecycledTabs(session));
  if (notice) pendingNotices.set(session, [...pendingNotices.get(session) ?? [], notice]);
  rememberPageIds(session, text);
}

/** 工具返回前取走攒下的提示，追加在返回文本末尾；没有就是空串。 */
export function drainBrowserNotice(session: string | undefined): string {
  if (!session) return "";
  const notices = pendingNotices.get(session) ?? [];
  pendingNotices.delete(session);
  return notices.join("\n");
}
