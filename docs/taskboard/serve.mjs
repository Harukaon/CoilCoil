#!/usr/bin/env node
/**
 * 看板服务：让页面上的改动直接写进 tasks.json。
 *
 * 双击打开的 index.html 走的是 file:// 协议，网页在这种情况下没有写磁盘的权限，
 * 所以原来只能「改动存在浏览器里 → 你点导出 → 覆盖 tasks.json」。这一步纯属白干：
 * 你已经在页面上点过一次了，还要再存一次文件。
 *
 * 从这个地址打开看板，页面每改一下就写一次盘，不需要再导出。
 *
 * 用法: node docs/taskboard/serve.mjs [端口]     默认 4399
 */
import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TASKS = join(here, "tasks.json");
const INDEX = join(here, "index.html");
const port = Number(process.argv[2] ?? process.env.PORT ?? 4399);

/** 写盘先写临时文件再改名：中途断电或者写到一半，原来那份仍然是完整的。 */
async function writeTasks(text) {
  const temp = `${TASKS}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, TASKS);
}

/** 读完整个请求体，超过 32MB 就拒绝——正常的看板连贴图都到不了这个量级。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(200, await readFile(INDEX), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/tasks.json") {
      return send(200, await readFile(TASKS));
    }
    if (req.method === "PUT" && url.pathname === "/tasks.json") {
      const text = await readBody(req);
      // 只做一层最起码的校验：写进去的必须还是一份看板数据。页面出 bug 写了个
      // 空对象进来，比不保存更糟——那等于把所有 Issue 一次抹掉。
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.tasks) || !data.tasks.length) {
        return send(400, JSON.stringify({ error: "不是一份有效的看板数据" }));
      }
      await writeTasks(`${JSON.stringify(data, null, 2)}\n`);
      return send(200, JSON.stringify({ ok: true, tasks: data.tasks.length }));
    }
    return send(404, JSON.stringify({ error: "没有这个地址" }));
  } catch (error) {
    console.error("[taskboard]", error);
    return send(500, JSON.stringify({ error: String(error?.message ?? error) }));
  }
});

// 只监听本机：这上面是没有任何鉴权的读写接口，不该暴露到局域网。
server.listen(port, "127.0.0.1", () => {
  console.log(`看板已启动：http://127.0.0.1:${port}/`);
  console.log("在这个地址上改动会直接写进 docs/taskboard/tasks.json，不需要再导出。");
});
