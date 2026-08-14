import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserDebugClient, pausedCallFrames } from "./browser-debug-client";

const endpoint = process.env.SUOCODE_BROWSER_DEBUG_CDP_ENDPOINT?.trim();
const token = process.env.SUOCODE_BROWSER_DEBUG_CDP_TOKEN?.trim();
const outputDir = process.env.SUOCODE_BROWSER_DEBUG_OUTPUT_DIR?.trim() || join(process.cwd(), ".suocode", "browser-artifacts");
if (!endpoint || !token) throw new Error("缺少 SuoCode 内置浏览器调试连接配置。");

const client = new BrowserDebugClient(endpoint, token);
const server = new McpServer({ name: "suocode-browser-debugger", version: "0.1.0" }, {
  instructions: [
    "这是 SuoCode 内置浏览器的低频高级调试层。普通查看、点击、填写和导航优先使用 suocode-browser。",
    "仅在源码断点、请求拦截、持续事件、HAR 或 Application 存储分析时调用这里的工具。",
    "所有行号和列号对模型使用 1-based，内部会转换为 CDP 的 0-based。",
  ].join("\n"),
});

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function remoteValue(value: unknown): unknown {
  const response = object(value);
  const remote = object(response.result);
  if ("value" in remote) return remote.value;
  return {
    type: remote.type,
    subtype: remote.subtype,
    description: remote.description,
    objectId: remote.objectId,
    exceptionDetails: response.exceptionDetails,
  };
}

async function origin(): Promise<string> {
  const response = await client.pageCommand("Runtime.evaluate", { expression: "location.origin", returnByValue: true });
  const value = remoteValue(response);
  if (typeof value !== "string" || !value) throw new Error("当前页面没有可用的 origin。");
  return value;
}

server.registerTool("browser_debugger_enable", {
  title: "启用源码调试器",
  description: "启用当前标签页的 Debugger 域。只有需要断点、暂停、单步或调用栈时才使用。",
}, async () => {
  const enabled = await client.pageCommand("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
  await client.pageCommand("Runtime.enable");
  return result({ enabled: true, ...object(enabled) });
});

server.registerTool("browser_debugger_set_breakpoint", {
  title: "设置源码断点",
  description: "按脚本 URL 或 URL 正则设置断点。line/column 均从 1 开始。",
  inputSchema: z.object({
    url: z.string().optional().describe("精确脚本 URL"),
    urlRegex: z.string().optional().describe("脚本 URL 正则；与 url 二选一"),
    line: z.number().int().min(1),
    column: z.number().int().min(1).default(1),
    condition: z.string().optional(),
  }),
}, async ({ url, urlRegex, line, column, condition }) => {
  if (!url && !urlRegex) throw new Error("url 与 urlRegex 至少提供一个。");
  await client.pageCommand("Debugger.enable");
  const response = await client.pageCommand("Debugger.setBreakpointByUrl", {
    ...(url ? { url } : { urlRegex }),
    lineNumber: line - 1,
    columnNumber: column - 1,
    ...(condition ? { condition } : {}),
  });
  return result(response);
});

server.registerTool("browser_debugger_remove_breakpoint", {
  title: "删除源码断点",
  description: "删除 browser_debugger_set_breakpoint 返回的 breakpointId。",
  inputSchema: z.object({ breakpointId: z.string() }),
}, async ({ breakpointId }) => {
  await client.pageCommand("Debugger.removeBreakpoint", { breakpointId });
  return result({ removed: breakpointId });
});

server.registerTool("browser_debugger_pause_on_exceptions", {
  title: "异常暂停策略",
  description: "控制 JavaScript 在不暂停、未捕获异常或全部异常时暂停。",
  inputSchema: z.object({ state: z.enum(["none", "uncaught", "all"]) }),
}, async ({ state }) => {
  await client.pageCommand("Debugger.enable");
  await client.pageCommand("Debugger.setPauseOnExceptions", { state });
  return result({ state });
});

server.registerTool("browser_debugger_control", {
  title: "控制暂停与单步",
  description: "暂停、继续、单步进入、单步跳过、单步跳出，或运行到指定源码位置。",
  inputSchema: z.object({
    action: z.enum(["pause", "resume", "step_into", "step_over", "step_out", "run_to_location"]),
    scriptId: z.string().optional(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).default(1),
  }),
}, async ({ action, scriptId, line, column }) => {
  await client.pageCommand("Debugger.enable");
  const methods = {
    pause: "Debugger.pause",
    resume: "Debugger.resume",
    step_into: "Debugger.stepInto",
    step_over: "Debugger.stepOver",
    step_out: "Debugger.stepOut",
    run_to_location: "Debugger.continueToLocation",
  } as const;
  const params = action === "run_to_location"
    ? { location: { scriptId, lineNumber: (line ?? 1) - 1, columnNumber: column - 1 } }
    : {};
  if (action === "run_to_location" && !scriptId) throw new Error("run_to_location 需要 scriptId。");
  await client.pageCommand(methods[action], params);
  return result({ action });
});

server.registerTool("browser_debugger_call_stack", {
  title: "查看调用栈与作用域",
  description: "读取最近一次暂停事件的调用栈、源码位置、scope objectId 与命中断点。",
}, async () => {
  const paused = client.latestPaused();
  if (!paused) return result({ paused: false, message: "当前页面没有暂停。" });
  return result({
    paused: true,
    reason: paused.params.reason,
    data: paused.params.data,
    hitBreakpoints: paused.params.hitBreakpoints,
    frames: pausedCallFrames(paused.params),
  });
});

server.registerTool("browser_debugger_evaluate", {
  title: "在暂停帧中求值",
  description: "在指定 callFrameId 中读取局部变量或执行表达式；省略 callFrameId 时在页面全局求值。",
  inputSchema: z.object({
    expression: z.string(),
    callFrameId: z.string().optional(),
    returnByValue: z.boolean().default(true),
  }),
}, async ({ expression, callFrameId, returnByValue }) => {
  const response = callFrameId
    ? await client.pageCommand("Debugger.evaluateOnCallFrame", { callFrameId, expression, returnByValue, generatePreview: true })
    : await client.pageCommand("Runtime.evaluate", { expression, returnByValue, generatePreview: true, awaitPromise: true });
  return result(remoteValue(response));
});

const interceptionPattern = z.object({
  urlPattern: z.string().default("*"),
  resourceType: z.string().optional(),
  requestStage: z.enum(["Request", "Response"]).default("Request"),
});

server.registerTool("browser_network_interception", {
  title: "请求拦截开关",
  description: "启用或关闭 Fetch 请求拦截。启用后用 browser_network_paused 查看请求，再用 browser_network_resolve 继续、Mock 或失败。",
  inputSchema: z.object({
    action: z.enum(["enable", "disable"]),
    patterns: z.array(interceptionPattern).optional(),
    handleAuthRequests: z.boolean().default(false),
  }),
}, async ({ action, patterns, handleAuthRequests }) => {
  if (action === "disable") {
    await client.pageCommand("Fetch.disable");
    return result({ enabled: false });
  }
  await client.pageCommand("Fetch.enable", { patterns: patterns?.length ? patterns : [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests });
  return result({ enabled: true, patterns: patterns?.length ? patterns : [{ urlPattern: "*", requestStage: "Request" }] });
});

server.registerTool("browser_network_paused", {
  title: "查看被拦截请求",
  description: "列出等待 continue/fulfill/fail 的请求。",
}, async () => result(client.pausedNetworkRequests().map((event) => ({ sequence: event.sequence, ...event.params }))));

server.registerTool("browser_network_resolve", {
  title: "处理被拦截请求",
  description: "继续请求、返回自定义响应，或让请求失败。body 使用普通文本，工具会自动转 base64。",
  inputSchema: z.object({
    requestId: z.string(),
    action: z.enum(["continue", "fulfill", "fail"]),
    url: z.string().optional(),
    method: z.string().optional(),
    postData: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    responseCode: z.number().int().min(100).max(599).default(200),
    responsePhrase: z.string().optional(),
    body: z.string().optional(),
    errorReason: z.string().default("Failed"),
  }),
}, async ({ requestId, action, url, method, postData, headers, responseCode, responsePhrase, body, errorReason }) => {
  if (action === "continue") {
    await client.pageCommand("Fetch.continueRequest", {
      requestId,
      ...(url ? { url } : {}),
      ...(method ? { method } : {}),
      ...(postData ? { postData: Buffer.from(postData).toString("base64") } : {}),
      ...(headers ? { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } : {}),
    });
  } else if (action === "fulfill") {
    await client.pageCommand("Fetch.fulfillRequest", {
      requestId,
      responseCode,
      ...(responsePhrase ? { responsePhrase } : {}),
      ...(headers ? { responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) } : {}),
      ...(body !== undefined ? { body: Buffer.from(body).toString("base64") } : {}),
    });
  } else {
    await client.pageCommand("Fetch.failRequest", { requestId, errorReason });
  }
  client.resolvePausedRequest(requestId);
  return result({ requestId, action });
});

server.registerTool("browser_debug_events", {
  title: "查询浏览器事件",
  description: "按 CDP 事件名读取最近事件。适合 console、network、WebSocket、DOM、Debugger 和 Page 生命周期排查。",
  inputSchema: z.object({
    methods: z.array(z.string()).optional(),
    sinceSequence: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }),
}, async ({ methods, sinceSequence, limit }) => result(client.eventLog({ methods, sinceSequence, limit })));

server.registerTool("browser_wait_for_event", {
  title: "等待浏览器事件",
  description: "等待一个或多个 CDP 事件，可用 text 对事件参数做简单包含匹配。用于等待请求、控制台、下载、WebSocket 帧或暂停。",
  inputSchema: z.object({
    methods: z.array(z.string()).min(1),
    text: z.string().optional(),
    sinceSequence: z.number().int().min(0).default(0),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  }),
}, async ({ methods, text, sinceSequence, timeoutMs }) => result(await client.waitForEvent({ methods, text, sinceSequence, timeoutMs })));

server.registerTool("browser_network_recording", {
  title: "网络记录与 HAR",
  description: "开始/停止当前标签页的网络记录，查看摘要，或导出 HAR 文件。",
  inputSchema: z.object({
    action: z.enum(["start", "stop", "status", "export_har"]),
    filePath: z.string().optional(),
  }),
}, async ({ action, filePath }) => {
  if (action === "start") {
    await client.pageCommand("Network.enable", { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 20_000_000 });
    client.startNetworkRecording();
    return result({ recording: true });
  }
  if (action === "stop") {
    client.stopNetworkRecording();
    return result({ recording: false, requests: client.networkRecords().length });
  }
  if (action === "status") return result({ recording: client.isNetworkRecording(), requests: client.networkRecords().length });
  const path = resolve(filePath || join(outputDir, `network-${new Date().toISOString().replaceAll(":", "-")}.har`));
  return result(await client.exportHar(path));
});

server.registerTool("browser_network_body", {
  title: "读取网络响应正文",
  description: "按 Network.requestId 读取响应正文；用于 Chrome DevTools 网络列表未返回完整 body 的情况。",
  inputSchema: z.object({ requestId: z.string() }),
}, async ({ requestId }) => result(await client.pageCommand("Network.getResponseBody", { requestId })));

server.registerTool("browser_websocket_frames", {
  title: "查看 WebSocket 帧",
  description: "按连接 URL、requestId 或正文过滤最近的 WebSocket 建连、发送、接收、错误和关闭事件。",
  inputSchema: z.object({
    requestId: z.string().optional(),
    url: z.string().optional(),
    text: z.string().optional(),
    sinceSequence: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }),
}, async ({ requestId, url, text, sinceSequence, limit }) => {
  await client.pageCommand("Network.enable");
  const methods = [
    "Network.webSocketCreated",
    "Network.webSocketWillSendHandshakeRequest",
    "Network.webSocketHandshakeResponseReceived",
    "Network.webSocketFrameSent",
    "Network.webSocketFrameReceived",
    "Network.webSocketFrameError",
    "Network.webSocketClosed",
  ];
  const events = client.eventLog({ methods, sinceSequence, limit: 500 });
  return result(events.filter((event) => {
    const id = typeof event.params.requestId === "string" ? event.params.requestId : "";
    const serialized = JSON.stringify(event.params);
    return (!requestId || id === requestId)
      && (!url || (client.webSocketUrl(id) || "").includes(url))
      && (!text || serialized.includes(text));
  }).slice(-limit).map((event) => ({
    ...event,
    url: typeof event.params.requestId === "string" ? client.webSocketUrl(event.params.requestId) : undefined,
  })));
});

server.registerTool("browser_downloads", {
  title: "管理浏览器下载",
  description: "启用下载、查看/等待下载事件或取消下载。文件默认保存到 SuoCode 私有 browser-artifacts/debug 目录。",
  inputSchema: z.object({
    action: z.enum(["enable", "list", "wait", "cancel"]),
    downloadPath: z.string().optional(),
    guid: z.string().optional(),
    timeoutMs: z.number().int().min(1).max(300_000).default(60_000),
  }),
}, async ({ action, downloadPath, guid, timeoutMs }) => {
  if (action === "enable") {
    const path = resolve(downloadPath || join(outputDir, "downloads"));
    await mkdir(path, { recursive: true });
    await client.activeSession();
    await client.command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path, eventsEnabled: true });
    return result({ enabled: true, downloadPath: path });
  }
  if (action === "cancel") {
    if (!guid) throw new Error("cancel 需要 guid。");
    await client.command("Browser.cancelDownload", { guid });
    return result({ cancelled: guid });
  }
  const methods = ["Browser.downloadWillBegin", "Browser.downloadProgress"];
  if (action === "wait") return result(await client.waitForEvent({ methods, timeoutMs, sinceSequence: 0, ...(guid ? { text: guid } : {}) }));
  return result(client.eventLog({ methods, limit: 500 }).filter((event) => !guid || JSON.stringify(event.params).includes(guid)));
});

server.registerTool("browser_coverage", {
  title: "JavaScript/CSS Coverage",
  description: "开始或停止 Coverage；停止时返回按脚本汇总的函数/执行范围，以及 CSS 已用与未用规则数量。",
  inputSchema: z.object({
    action: z.enum(["start", "stop"]),
    maxEntries: z.number().int().min(1).max(500).default(100),
  }),
}, async ({ action, maxEntries }) => {
  if (action === "start") {
    await client.pageCommand("Profiler.enable");
    await client.pageCommand("DOM.enable");
    await client.pageCommand("CSS.enable");
    await client.pageCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true, allowTriggeredUpdates: false });
    await client.pageCommand("CSS.startRuleUsageTracking");
    return result({ recording: true });
  }
  const js = object(await client.pageCommand("Profiler.takePreciseCoverage"));
  const css = object(await client.pageCommand("CSS.stopRuleUsageTracking"));
  await client.pageCommand("Profiler.stopPreciseCoverage");
  const scripts = Array.isArray(js.result) ? js.result : [];
  const rules = Array.isArray(css.ruleUsage) ? css.ruleUsage : [];
  return result({
    recording: false,
    scripts: scripts.slice(0, maxEntries).map((scriptValue) => {
      const script = object(scriptValue);
      const functions = Array.isArray(script.functions) ? script.functions : [];
      return {
        scriptId: script.scriptId,
        url: script.url,
        functions: functions.length,
        ranges: functions.reduce((total, functionValue) => total + (Array.isArray(object(functionValue).ranges) ? (object(functionValue).ranges as unknown[]).length : 0), 0),
      };
    }),
    css: {
      rules: rules.length,
      used: rules.filter((value) => object(value).used === true).length,
      unused: rules.filter((value) => object(value).used !== true).length,
    },
  });
});

server.registerTool("browser_application_storage", {
  title: "Application 存储调试（Storage usage/quota）",
  description: "查看浏览器 Application Storage 的站点 storage usage/quota、IndexedDB 数据库/结构/记录，或清理指定类型的站点数据。",
  inputSchema: z.object({
    action: z.enum(["usage", "cookies", "clear_cookies", "indexeddb_databases", "indexeddb_schema", "indexeddb_data", "cache_names", "cache_entries", "cache_delete", "service_workers", "clear"]),
    origin: z.string().optional(),
    databaseName: z.string().optional(),
    objectStoreName: z.string().optional(),
    indexName: z.string().default(""),
    skipCount: z.number().int().min(0).default(0),
    pageSize: z.number().int().min(1).max(500).default(100),
    storageTypes: z.string().default("all"),
    cacheId: z.string().optional(),
    pathFilter: z.string().default(""),
  }),
}, async ({ action, origin: requestedOrigin, databaseName, objectStoreName, indexName, skipCount, pageSize, storageTypes, cacheId, pathFilter }) => {
  const securityOrigin = requestedOrigin || await origin();
  if (action === "usage") return result(await client.pageCommand("Storage.getUsageAndQuota", { origin: securityOrigin }));
  if (action === "cookies") return result(await client.pageCommand("Storage.getCookies"));
  if (action === "clear_cookies") {
    await client.pageCommand("Storage.clearCookies");
    return result({ cleared: true, type: "cookies" });
  }
  if (action === "clear") {
    await client.pageCommand("Storage.clearDataForOrigin", { origin: securityOrigin, storageTypes });
    return result({ cleared: true, origin: securityOrigin, storageTypes });
  }
  if (action === "cache_names") return result(await client.pageCommand("CacheStorage.requestCacheNames", { securityOrigin }));
  if (action === "cache_entries") {
    if (!cacheId) throw new Error("cache_entries 需要 cacheId。");
    return result(await client.pageCommand("CacheStorage.requestEntries", { cacheId, skipCount, pageSize, pathFilter }));
  }
  if (action === "cache_delete") {
    if (!cacheId) throw new Error("cache_delete 需要 cacheId。");
    await client.pageCommand("CacheStorage.deleteCache", { cacheId });
    return result({ deleted: cacheId });
  }
  if (action === "service_workers") {
    await client.pageCommand("ServiceWorker.enable");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    return result(client.eventLog({ methods: ["ServiceWorker.workerRegistrationUpdated", "ServiceWorker.workerVersionUpdated"], limit: 100 }));
  }
  await client.pageCommand("IndexedDB.enable");
  if (action === "indexeddb_databases") {
    return result(await client.pageCommand("IndexedDB.requestDatabaseNames", { securityOrigin }));
  }
  if (!databaseName) throw new Error(`${action} 需要 databaseName。`);
  if (action === "indexeddb_schema") {
    return result(await client.pageCommand("IndexedDB.requestDatabase", { securityOrigin, databaseName }));
  }
  if (!objectStoreName) throw new Error("indexeddb_data 需要 objectStoreName。");
  return result(await client.pageCommand("IndexedDB.requestData", {
    securityOrigin,
    databaseName,
    objectStoreName,
    indexName,
    skipCount,
    pageSize,
  }));
});

const shutdown = async (): Promise<void> => {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
};
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("disconnect", () => { void shutdown().finally(() => process.exit(0)); });

await server.connect(new StdioServerTransport());
