/** Browser actions share one progressively disclosed browser entry point. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserBridgeEndpoint, drainBrowserNotice, noteBrowserCall } from "./browser-recycle-notice.ts";
import { requestMcpManager } from "./mcp-tools.ts";
import { registerBrowserGateway, type BrowserAction } from "./browser-tool.ts";

export const LEGACY_BROWSER_TOOLS = ["browser_open", "browser_navigate", "browser_click", "browser_type", "browser_tabs"] as const;

const BROWSER_SERVER = "coilcoil-browser";

/**
 * 从 chrome-devtools-mcp 的页面列表里认出当前选中的那一页。
 *
 * new_page 开完就选中新页，它的回执里那一行带 `[selected]`。以前这里取的是列表里
 * 第一个匹配的行，也就是第一个标签页：句柄绑错页，之后拿「新页」的句柄导航、点击，
 * 动的全是第一个标签页，用户正看着的页面被换掉。
 */
export function selectedPageId(listing: string): number | undefined {
  const match = /^(\d+):[^\n]*\[selected\]/m.exec(listing);
  return match ? Number(match[1]) : undefined;
}

/**
 * chrome-devtools-mcp 打开/导航网页时要等整页 load 事件，默认只等 10 秒。慢图片、慢脚本、
 * 长连接都会拖住 load，可页面早就能看能点了——会话记录里这类「超时」多数时候快照已经有完整页面。
 */
export function isLoadTimeout(message: string): boolean {
  return /Navigation timeout of \d+ ?ms exceeded/i.test(message);
}

/** 页面列表里某一页（不给编号就取选中页）当前的网址。 */
export function listedPageUrl(listing: string, pageId?: number): string | undefined {
  for (const match of listing.matchAll(/^(\d+): (.*)$/gm)) {
    const line = match[2];
    if (pageId !== undefined ? Number(match[1]) !== pageId : !/\[selected\]/.test(line)) continue;
    const urls = [...line.matchAll(/\(([^()\s]+)\)/g)];
    return urls.at(-1)?.[1];
  }
  return undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

/** load 没等完时，页面是不是已经换到新地址（主文档到了，剩下的是资源还在加载）。 */
export function navigationCommitted(current: string | undefined, target: string, before?: string): boolean {
  if (!current || current === "about:blank" || current.startsWith("chrome-error:")) return false;
  if (current === target) return true;
  // 还停在旧地址：哪怕同站，也说明新页面没换上来。
  if (before !== undefined && current === before) return false;
  return sameOrigin(current, target) || before !== undefined;
}

/**
 * 把浏览器报的标签页一张张对到 chrome-devtools-mcp 的页面编号上。
 *
 * 两边都按打开的先后排：先按「标题和网址都一样」对，对不上再只按网址对；同样的有好几张
 * （比如几张空白页）就按先后一一对上，不会两张标签页拿到同一个编号。
 *
 * 一行长这样：`1: 标题 (网址) [selected] isolatedContext=...`。网址取这一行最后一个括号
 * 里的（标题里也可能有括号），后面还跟着别的标记，行尾不能卡死。
 */
export function pageIdsForTabs(listing: string, tabs: ReadonlyArray<{ title: string; url: string }>): Array<number | undefined> {
  const pages = [...listing.matchAll(/^(\d+): (.*) \(([^()\s]+)\)/gm)]
    .map((match) => ({ id: Number(match[1]), title: match[2].trim(), url: match[3], used: false }));
  const take = (match: (page: typeof pages[number]) => boolean): number | undefined => {
    const page = pages.find((item) => !item.used && match(item));
    if (!page) return undefined;
    page.used = true;
    return page.id;
  };
  const ids: Array<number | undefined> = tabs.map((tab) => take((page) => page.url === tab.url && page.title === tab.title.trim()));
  return ids.map((id, index) => id ?? take((page) => page.url === tabs[index].url));
}

/**
 * 这一步操作让网页弹出了 alert / confirm：操作本身已经生效，页面停在对话框上等回答。
 *
 * chrome-devtools-mcp 会一直等页面动起来，等不到就报「点击失败」，可按钮其实已经点到了；
 * 照「失败」处理会让模型再点一次。这里认出这种情况，如实告诉它下一步该做什么。
 */
export function pendingDialogNotice(message: string): string | undefined {
  const match = /Open dialog\s*(alert|confirm|prompt|beforeunload):\s*([^\n]*?)\.?\s*Call handle_dialog/i.exec(message);
  if (!match) return undefined;
  return `操作已生效，网页弹出了一个 ${match[1]} 对话框：「${match[2]}」。页面在等回答，别再重复这一步：用 browser 调用 devtools.handle_dialog（accept 或 dismiss）处理它，用户也可能直接在面板里点掉。`;
}

interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  /** 用户正看着的那张。 */
  active: boolean;
  owner: "agent" | "user";
}

async function bridgeRequest<T>(path: string, scope: string | undefined, init: { method?: string; query?: Record<string, string> } = {}): Promise<T> {
  const endpoint = scope ? browserBridgeEndpoint(path, scope) : undefined;
  if (!endpoint) throw new Error("内置浏览器不可用（只有桌面端有）。");
  const url = new URL(endpoint.url);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, { method: init.method ?? "GET", headers: endpoint.headers, signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `内置浏览器返回 ${response.status}`);
  return body;
}

function textResult(text: string, details: Record<string, unknown>, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
} {
  return { content: [{ type: "text", text }], details, isError };
}

async function callBrowser(
  events: { emit(channel: string, data: unknown): void },
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  session?: string,
): Promise<{ text: string; json: unknown }> {
  const manager = requestMcpManager(events);
  if (!manager) throw new Error("MCP 客户端当前不可用。");
  const result = await manager.callTool(BROWSER_SERVER, tool, args, signal);
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = Array.isArray(content)
    ? content.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n")
    : JSON.stringify(result);
  // 记下页面编号、取回「超过上限被收掉的 Agent 标签页」，工具返回时一起告诉 Agent。
  await noteBrowserCall(session, text);
  // MCP 工具出错是「返回 isError」，不是抛异常。不在这里转成异常，下面各个工具的
  // 失败分支就永远走不到：点不中报成「点击完成」，导航失败报成「导航完成」。
  if ((result as { isError?: unknown }).isError === true) throw new Error(text || `${tool} 失败`);
  return { text: text || "（服务器没有返回内容）", json: result };
}

/** 报错里带上当前页面状态，模型不用盲猜下一步。 */
async function currentState(
  events: { emit(channel: string, data: unknown): void },
  pageId?: number,
  signal?: AbortSignal,
  session?: string,
): Promise<string> {
  try {
    const args: Record<string, unknown> = {};
    if (pageId !== undefined) args.pageId = pageId;
    const { text } = await callBrowser(events, "take_snapshot", args, signal, session);
    return text.slice(0, 2000);
  } catch {
    return "（当前页面状态读取失败）";
  }
}

const handleFields = {
  handle: Type.Optional(Type.String({
    description: "Page handle returned by open. With a handle you do not need pageId; with neither, the call applies to the currently selected page.",
  })),
  pageId: Type.Optional(Type.Number({
    description: "Kept for backward compatibility: the numeric page id. Prefer handle, and use the handle of a newly opened page.",
  })),
} as const;

export default function browserActExtension(pi: ExtensionAPI): void {
  // 这个扩展属于一个会话；会话 id 用来找它那一份浏览器的回收记录。
  let sessionId: string | undefined;
  const actions = new Map<string, BrowserAction>();
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    const execute = tool.execute;
    actions.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        sessionId = ctx?.sessionManager?.getSessionId() ?? sessionId;
        const result = await execute(toolCallId, params as never, signal, onUpdate, ctx);
        const notice = drainBrowserNotice(sessionId);
        const first = result.content[0];
        if (notice && first?.type === "text") first.text += notice;
        return result;
      },
    });
  };
  // 句柄 → pageId，每个会话一份：页面编号是这个会话自己那条浏览器连接里的编号。
  const handleToPage = new Map<string, number>();
  let nextHandleId = 1;
  const newHandle = (pageId?: number): string => {
    const handle = `btab-${nextHandleId++}`;
    if (pageId !== undefined) handleToPage.set(handle, pageId);
    return handle;
  };
  /** 同一张页面再列一次，还是原来那个句柄。 */
  const handleFor = (pageId: number): string => {
    for (const [handle, id] of handleToPage) if (id === pageId) return handle;
    return newHandle(pageId);
  };
  const resolvePageId = (handle?: string, pageId?: number): number | undefined => {
    if (pageId !== undefined) return pageId;
    if (handle) {
      if (!handleToPage.has(handle)) throw new Error("Unknown browser handle; list tabs to obtain a current handle.");
      return handleToPage.get(handle);
    }
    return undefined;
  };

  registerTool({
    name: "open",
    label: "Browser Open",
    description: [
      "Open a web page in the built-in browser and return a handle for it.",
      "Use these browser actions to interact with pages; discover additional debugging operations with browser action=tools.",
      "Pass the returned handle to the later calls instead of tracking pageId numbers yourself.",
      "Do your own work in pages you opened yourself. When the user says 'this page' or 'the one I opened', call tabs to find the page the user is looking at and act through its handle. A page the user opened may hold work in progress, so do not navigate or change forms there unless asked.",
    ].join(" "),
    parameters: Type.Object({
      url: Type.String({ description: "Address to open" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const { text } = await callBrowser(pi.events, "new_page", { url: params.url }, signal, sessionId);
        // new_page 不直接给 id，但它会选中新页，回执里的页面列表把它标成 [selected]。
        let pageId = selectedPageId(text);
        if (pageId === undefined) {
          try {
            pageId = selectedPageId((await callBrowser(pi.events, "list_pages", {}, signal, sessionId)).text);
          } catch {
            // 拿不到 id 也不致命：句柄先返回，后续操作回落到选中页。
          }
        }
        const handle = newHandle(pageId);
        return textResult(`已打开 ${params.url}，句柄 ${handle}。${pageId !== undefined ? `（pageId ${pageId}）` : "后续操作拿句柄即可。"}\n${text.slice(0, 1500)}`, { handle, pageId, server: BROWSER_SERVER });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isLoadTimeout(message)) {
          // 新页在等 load 之前就已建好并选中：句柄照发，不然模型拿不到这张页，只会再开一张。
          let listing = "";
          try { listing = (await callBrowser(pi.events, "list_pages", {}, signal, sessionId)).text; } catch { /* 下面按未加载处理 */ }
          const pageId = selectedPageId(listing);
          const handle = newHandle(pageId);
          const state = await currentState(pi.events, pageId, signal, sessionId);
          if (navigationCommitted(listedPageUrl(listing, pageId), params.url)) {
            return textResult(`已打开 ${params.url}，句柄 ${handle}。页面主体已可用，部分图片或脚本还在加载，可以直接继续操作。\n--- 当前页面 ---\n${state}`, { handle, pageId, server: BROWSER_SERVER, slowLoad: true });
          }
          return textResult(`页面已建好（句柄 ${handle}），但 ${params.url} 还没加载出来。不要再开新页，稍后用这个句柄取快照确认。\n--- 当前页面 ---\n${state}`, { error: "open_slow", message, handle, pageId }, true);
        }
        return textResult(`打开失败：${message}`, { error: "open_failed", message }, true);
      }
    },
  });

  registerTool({
    name: "navigate",
    label: "Browser Navigate",
    description: "Navigate the page behind a handle to a new address and wait until it has loaded. When it times out, the error carries the current page state; read that state before retrying instead of retrying blindly.",
    parameters: Type.Object({
      ...handleFields,
      url: Type.String({ description: "Target address" }),
    }),
    async execute(_toolCallId, params, signal) {
      const pageId = resolvePageId(params.handle, params.pageId);
      const args: Record<string, unknown> = { url: params.url };
      if (pageId !== undefined) args.pageId = pageId;
      let before: string | undefined;
      try { before = listedPageUrl((await callBrowser(pi.events, "list_pages", {}, signal, sessionId)).text, pageId); } catch { /* 拿不到旧地址只是少一个判断依据 */ }
      try {
        const { text } = await callBrowser(pi.events, "navigate_page", args, signal, sessionId);
        const state = await currentState(pi.events, pageId, signal, sessionId);
        return textResult(`导航完成。\n${text.slice(0, 1000)}\n--- 当前页面 ---\n${state}`, { handle: params.handle, pageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state = await currentState(pi.events, pageId, signal, sessionId);
        if (isLoadTimeout(message)) {
          let current: string | undefined;
          try { current = listedPageUrl((await callBrowser(pi.events, "list_pages", {}, signal, sessionId)).text, pageId); } catch { /* 按未提交处理 */ }
          if (navigationCommitted(current, params.url, before)) {
            return textResult(`导航完成：页面主体已可用（${current}），部分图片或脚本还在加载，可以直接继续操作。\n--- 当前页面 ---\n${state}`, { handle: params.handle, pageId, slowLoad: true });
          }
        }
        return textResult(
          `导航失败：${message}\n不要直接重试——先看下面的页面状态确认这一步到底做没做成。\n--- 当前页面 ---\n${state}`,
          { error: "navigate_failed", message, handle: params.handle, pageId },
          true,
        );
      }
    },
  });

  registerTool({
    name: "click",
    label: "Browser Click",
    description: "Click a page element. The current page state comes back automatically after every click; when the click misses (for example the uid has expired), a fresh snapshot comes back instead, and you should click again with the uid from that new snapshot.",
    parameters: Type.Object({
      ...handleFields,
      uid: Type.String({ description: "Element uid seen in take_snapshot" }),
    }),
    async execute(_toolCallId, params, signal) {
      const pageId = resolvePageId(params.handle, params.pageId);
      const args: Record<string, unknown> = { uid: params.uid };
      if (pageId !== undefined) args.pageId = pageId;
      try {
        const { text } = await callBrowser(pi.events, "click", args, signal, sessionId);
        const state = await currentState(pi.events, pageId, signal, sessionId);
        return textResult(`点击完成。\n${text.slice(0, 800)}\n--- 当前页面 ---\n${state}`, { handle: params.handle, pageId });
      } catch (error) {
        const first = error instanceof Error ? error.message : String(error);
        const dialog = pendingDialogNotice(first);
        if (dialog) return textResult(dialog, { dialog: true, handle: params.handle, pageId });
        // uid 过期是最常见的失败：重取一次快照交出去，让模型用新快照里的 uid 再点。
        // 不替它挑元素：新快照里「同一个」元素是谁，只有看得懂页面的模型说得清。
        try {
          const fresh = await currentState(pi.events, pageId, signal, sessionId);
          return textResult(
            `点击失败（${first}）。已重取快照，请用下面新快照里的 uid 再点一次。\n--- 当前页面 ---\n${fresh}`,
            { error: "click_stale", message: first, handle: params.handle, pageId, retried: true },
            true,
          );
        } catch {
          return textResult(`点击失败：${first}`, { error: "click_failed", message: first }, true);
        }
      }
    },
  });

  registerTool({
    name: "type",
    label: "Browser Type",
    description: "Fill text into an input and read it back to confirm. Take a snapshot with take_snapshot first to get the input's uid.",
    parameters: Type.Object({
      ...handleFields,
      uid: Type.String({ description: "Uid of the input" }),
      value: Type.String({ description: "Text to fill in" }),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after filling to submit; default false" })),
    }),
    async execute(_toolCallId, params, signal) {
      const pageId = resolvePageId(params.handle, params.pageId);
      const args: Record<string, unknown> = { uid: params.uid, value: params.value };
      if (pageId !== undefined) args.pageId = pageId;
      try {
        const { text } = await callBrowser(pi.events, "fill", args, signal, sessionId);
        if (params.submit) {
          const pressArgs: Record<string, unknown> = { key: "Enter" };
          if (pageId !== undefined) pressArgs.pageId = pageId;
          await callBrowser(pi.events, "press_key", pressArgs, signal, sessionId);
        }
        const state = await currentState(pi.events, pageId, signal, sessionId);
        return textResult(`输入完成。\n${text.slice(0, 500)}\n--- 当前页面 ---\n${state}`, { handle: params.handle, pageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const dialog = pendingDialogNotice(message);
        if (dialog) return textResult(dialog, { dialog: true, handle: params.handle, pageId });
        const state = await currentState(pi.events, pageId, signal, sessionId);
        return textResult(
          `输入失败：${message}\n--- 当前页面 ---\n${state}`,
          { error: "type_failed", message, handle: params.handle, pageId },
          true,
        );
      }
    },
  });

  registerTool({
    name: "tabs",
    label: "Browser Tabs",
    description: "List every page of the built-in browser in this conversation (the ones you opened and the ones the user opened), give each a handle, and mark which one the user is looking at. You and the user share the very same pages: act on a page directly with its handle through click, type or navigate; there is nothing to take over and the page is not reloaded.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      try {
        const { tabs } = await bridgeRequest<{ tabs: BrowserTabInfo[] }>("tabs", sessionId);
        if (!tabs.length) return textResult("这个对话里还没有打开的网页。要看网页就用 open 打开。", { tabs });
        // 新开的页面刚出现在浏览器里时，页面列表可能要等一下才列得到。
        let ids: Array<number | undefined> = [];
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, 200));
          ids = pageIdsForTabs((await callBrowser(pi.events, "list_pages", {}, signal, sessionId)).text, tabs);
          if (ids.every((id) => id !== undefined)) break;
        }
        // 对不上编号的不给句柄：没有编号的句柄会落到「当前选中的页」上，可能是另一张。
        const rows = tabs.map((tab, index) => ({ ...tab, pageId: ids[index], handle: ids[index] === undefined ? undefined : handleFor(ids[index]) }));
        const lines = rows.map((row) =>
          `- ${row.handle ?? "（刚打开，还拿不到句柄，稍后再列一次）"}${row.active ? "（用户正看着）" : ""}${row.owner === "user" ? "（用户开的）" : "（你开的）"}：${row.title || "无标题"}（${row.url}）`);
        return textResult(`这个对话里的网页：\n${lines.join("\n")}\n拿句柄操作。用户开的页面里可能有他正在做的事，没让你动就别去导航、改表单。`, {
          tabs: rows.map(({ handle, pageId, title, url, active, owner }) => ({ handle, pageId, title, url, active, owner })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`读取失败：${message}`, { error: "tabs_failed", message }, true);
      }
    },
  });
  registerBrowserGateway(pi, actions);
}
