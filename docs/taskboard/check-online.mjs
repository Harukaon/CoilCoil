/**
 * 联机模式自检：确认从 serve.mjs 那个地址打开时，页面上的改动真的写进了磁盘。
 *
 * check.mjs 验的是双击打开（file://）那条路，页面的改动只存在浏览器里。这一份验
 * 的是另一条：起服务、用 Electron 打开 http 地址、在页面里改一条状态、然后回头看
 * docs/taskboard/tasks.json 是不是真的变了。
 *
 * 跑之前会把 tasks.json 备份下来，跑完无论成败都还原，不会动你的真实数据。
 *
 * 用法: node docs/taskboard/check-online.mjs
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const tasksFile = join(here, "tasks.json");
const backup = join(mkdtempSync(join(tmpdir(), "coilcoil-board-online-")), "tasks.json");
const port = 4571;

copyFileSync(tasksFile, backup);
const restore = () => copyFileSync(backup, tasksFile);

const server = spawn(process.execPath, [join(here, "serve.mjs"), String(port)], { stdio: "ignore" });
const done = (code, message) => {
  restore();
  server.kill();
  if (message) console.log(message);
  process.exit(code);
};
process.on("exit", () => server.kill());

const main = `
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: false } });
  const fail = (message) => { console.log("FAIL " + message); app.exit(1); };
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) fail("页面报错: " + message); });
  await win.loadURL("http://127.0.0.1:${port}/");
  try {
    const result = await win.webContents.executeJavaScript(${JSON.stringify(pageScript())}, true);
    console.log(result);
    app.exit(String(result).startsWith("OK") ? 0 : 1);
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
});
`;

function pageScript() {
  return `(async () => {
  const steps = [];
  const check = (ok, what) => { steps.push((ok ? "· " : "✗ ") + what); if (!ok) throw new Error(what); };
  const tick = () => new Promise((r) => setTimeout(() => setTimeout(r, 0), 0));
  const until = async (fn, what) => {
    for (let i = 0; i < 200; i += 1) { if (fn()) return; await tick(); }
    throw new Error("等不到：" + what);
  };

  check(ONLINE === true, "从 http 地址打开时进的是联机模式");
  // 等磁盘上那份读回来并换掉页面里的数据：内置的 SEED 只是先把界面画出来，
  // 在它被换掉之前改东西会被覆盖。
  await until(() => document.getElementById("dirty").textContent.includes("直接存进"),
    "从磁盘读到了任务数据");
  check(state.tasks.length > 0, "读回来的数据里有任务");
  check(document.querySelectorAll(".card").length > 0, "卡片渲染出来了");
  // 联机模式不该再往 localStorage 里塞任务数据，那会变成两份真相。
  check(localStorage.getItem("suocode-taskboard-v2") === null, "联机模式不写 localStorage");

  const target = state.tasks[0];
  const before = target.status;
  const next = before === "todo" ? "doing" : "todo";
  setStatus(target, next);
  save();
  await until(() => document.getElementById("dirty").textContent.includes("已保存"), "页面报告已保存");
  check(!document.getElementById("dirty").classList.contains("bad"), "保存没有报错");

  const fromDisk = await (await fetch("tasks.json", { cache: "no-store" })).json();
  const saved = fromDisk.tasks.find((t) => t.id === target.id);
  check(saved.status === next, "改动真的写进了磁盘上的 tasks.json");
  check(!!saved.statusAt, "写进去的还带着「我什么时候点的」这个时间");

  return "OK " + steps.length + " 项全部通过\\n" + steps.join("\\n");
})()`;
}

const dir = mkdtempSync(join(tmpdir(), "coilcoil-board-online-run-"));
const entry = join(dir, "main.cjs");
writeFileSync(entry, main, "utf8");

// 给服务一点起身时间；起不来的话下面加载页面时会直接失败，不需要额外探活。
setTimeout(() => {
  const electron = join(repo, "node_modules", ".bin", "electron");
  const child = spawn(electron, [entry], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  child.on("exit", (code) => {
    try { unlinkSync(entry); } catch { /* 临时文件，删不掉也无所谓 */ }
    const restored = JSON.parse(readFileSync(backup, "utf8"));
    done(code ?? 1, `（tasks.json 已还原，${restored.tasks.length} 条）`);
  });
}, 800);
