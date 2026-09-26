/**
 * 交互层浏览器工具：像人一样操作页面，而不是调试页面。
 *
 * coilcoil-browser 是调试型工具（脚本/控制台/网络/性能/快照），模型拿它做点击、
 * 等待、切页时错误率 8.27%（4573 次调用里 378 次错，导航/等待/选页占大头）。
 * 这一层只做四件事，每一步都自动带上当前页面状态，模型不用自己拼 pageId、
 * 不用猜工具名、不用在导航后手动重取快照：
 *
 * - browser_open：开页即返回句柄，后续操作拿句柄而不是 pageId 数字
 * - browser_navigate：导航含等待可加载，超时报错带当前状态
 * - browser_click：点击后自动重读快照；点不中时把新快照交回去，让模型用新 uid 再点
 * - browser_type：输入后回读确认
 * - browser_user_tabs / browser_take_over：用户自己开的标签页 Agent 碰不了，要用就先接管
 *
 * 调试继续用 coilcoil-browser，两层分家。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { browserBridgeEndpoint, drainBrowserNotice, noteBrowserCall } from "./browser-recycle-notice.ts";
import { requestMcpManager } from "./mcp-tools.ts";

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

/** 在 chrome-devtools-mcp 的页面列表里找某个网址的页面编号；有好几张就要最新（编号最大）的。 */
export function pageIdForUrl(listing: string, url: string): number | undefined {
  let found: number | undefined;
  for (const match of listing.matchAll(/^(\d+): .* \(([^()\s]+)\)/gm)) {
    if (match[2] === url) found = Math.max(found ?? 0, Number(match[1]));
  }
  return found;
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
  return `操作已生效，网页弹出了一个 ${match[1]} 对话框：「${match[2]}」。页面在等回答，别再重复这一步：用 coilcoil-browser 的 handle_dialog（accept 或 dismiss）处理它，用户也可能直接在面板里点掉。`;
}

interface UserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
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
    description: "browser_open 返回的页面句柄。传了句柄就不用传 pageId；两个都不传则作用于当前选中页。",
  })),
  pageId: Type.Optional(Type.Number({
    description: "兼容旧调用：页面的数字 id。推荐用 handle，新开的页直接拿 handle。",
  })),
} as const;

export default function browserActExtension(pi: ExtensionAPI): void {
  // 这个扩展属于一个会话；会话 id 用来找它那一份浏览器的回收记录。
  let sessionId: string | undefined;
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    const execute = tool.execute;
    pi.registerTool({
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        sessionId = ctx?.sessionManager?.getSessionId() ?? sessionId;
        const result = await execute(toolCallId, params, signal, onUpdate, ctx);
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
  const resolvePageId = (handle?: string, pageId?: number): number | undefined => {
    if (pageId !== undefined) return pageId;
    if (handle && handleToPage.has(handle)) return handleToPage.get(handle);
    return undefined;
  };

  registerTool({
    name: "browser_open",
    label: "Browser Open",
    description: "打开一个网页并返回句柄。交互（点击/输入/导航）用 browser_navigate、browser_click、browser_type 拿句柄操作；调试（脚本/控制台/网络/性能）继续用 coilcoil-browser。你只能操作自己开的、或者用 browser_take_over 接管过来的标签页。",
    promptSnippet: "browser_open: 打开网页拿句柄，后续交互拿句柄操作",
    promptGuidelines: [
      "需要像人一样点页面、填表单时用这一组；看 DOM、跑脚本、查控制台网络性能时用 coilcoil-browser。",
      "返回的 handle 贯穿后续操作，不要自己记 pageId 数字。",
      "用户自己开着的网页你看不到也碰不了；用户让你看「这个页面」「我开的那个」时，先 browser_user_tabs 找到它，再 browser_take_over 接管。",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "要打开的地址" }),
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
        return textResult(`打开失败：${message}`, { error: "open_failed", message }, true);
      }
    },
  });

  registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "让句柄对应的页面导航到新地址，含等待可加载。超时时报错自带当前页面状态，不要盲重试。",
    promptSnippet: "browser_navigate: 导航含等待，失败看报错里的页面状态",
    parameters: Type.Object({
      ...handleFields,
      url: Type.String({ description: "目标地址" }),
    }),
    async execute(_toolCallId, params, signal) {
      const pageId = resolvePageId(params.handle, params.pageId);
      const args: Record<string, unknown> = { url: params.url };
      if (pageId !== undefined) args.pageId = pageId;
      try {
        const { text } = await callBrowser(pi.events, "navigate_page", args, signal, sessionId);
        const state = await currentState(pi.events, pageId, signal, sessionId);
        return textResult(`导航完成。\n${text.slice(0, 1000)}\n--- 当前页面 ---\n${state}`, { handle: params.handle, pageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state = await currentState(pi.events, pageId, signal, sessionId);
        return textResult(
          `导航失败：${message}\n不要直接重试——先看下面的页面状态确认这一步到底做没做成。\n--- 当前页面 ---\n${state}`,
          { error: "navigate_failed", message, handle: params.handle, pageId },
          true,
        );
      }
    },
  });

  registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "点击页面元素。每次点击后自动带回当前页面状态；点不中（比如 uid 过期）时会带回一份新快照，用新快照里的 uid 再点。",
    promptSnippet: "browser_click: 点完自动带回页面状态，点不中时带回新快照",
    parameters: Type.Object({
      ...handleFields,
      uid: Type.String({ description: "take_snapshot 里看到的元素 uid" }),
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
    name: "browser_type",
    label: "Browser Type",
    description: "往输入框填内容，填完回读确认。需要先 take_snapshot 拿到输入框的 uid。",
    promptSnippet: "browser_type: 填完回读确认",
    parameters: Type.Object({
      ...handleFields,
      uid: Type.String({ description: "输入框的 uid" }),
      value: Type.String({ description: "要填的内容" }),
      submit: Type.Optional(Type.Boolean({ description: "填完是否回车提交，默认 false" })),
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
    name: "browser_user_tabs",
    label: "Browser User Tabs",
    description: "列出用户自己在内置浏览器里开着的标签页（标题、网址、是不是用户正看着的那张）。这些标签页你碰不了，要用哪一张就用 browser_take_over 接管。",
    promptSnippet: "browser_user_tabs: 看用户开着哪些网页，要用再接管",
    parameters: Type.Object({}),
    async execute() {
      try {
        const { tabs } = await bridgeRequest<{ tabs: UserTab[] }>("user-tabs", sessionId);
        if (!tabs.length) return textResult("用户现在没有开着的标签页。", { tabs });
        const lines = tabs.map((tab) => `- tab=${tab.id}${tab.active ? "（用户正看着）" : ""}：${tab.title || "无标题"}（${tab.url}）`);
        return textResult(`用户开着的标签页：\n${lines.join("\n")}\n要操作哪一张，用 browser_take_over 传它的 tab。`, { tabs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`读取失败：${message}`, { error: "user_tabs_failed", message }, true);
      }
    },
  });

  registerTool({
    name: "browser_take_over",
    label: "Browser Take Over",
    description: "接管用户的一张标签页：它变成你的，页面原样保留（网址、前进后退、表单里填的内容；登录状态也在），之后拿返回的句柄操作。用户在界面上会看到这张标签页交给了你，随时可以再接管回去。",
    promptSnippet: "browser_take_over: 接管用户的标签页，返回句柄",
    parameters: Type.Object({
      tab: Type.String({ description: "browser_user_tabs 列出来的 tab" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const taken = await bridgeRequest<{ url: string; title: string }>("take-over", sessionId, { method: "POST", query: { tab: params.tab } });
        // 新页面刚出现在浏览器里，页面列表可能要等一下才列得到。
        let pageId: number | undefined;
        let listing = "";
        for (let attempt = 0; attempt < 10 && pageId === undefined; attempt += 1) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, 200));
          listing = (await callBrowser(pi.events, "list_pages", {}, signal, sessionId)).text;
          pageId = pageIdForUrl(listing, taken.url);
        }
        const handle = newHandle(pageId);
        return textResult(
          `已接管：${taken.title || "无标题"}（${taken.url}），句柄 ${handle}。${pageId !== undefined ? `（pageId ${pageId}）` : ""}\n${listing.slice(0, 1200)}`,
          { handle, pageId, url: taken.url },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`接管失败：${message}`, { error: "take_over_failed", message }, true);
      }
    },
  });
}
