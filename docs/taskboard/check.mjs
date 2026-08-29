/**
 * 看板自检：用 Electron 把 index.html 真正加载起来，把每个交互点一遍。
 *
 * 之所以要这一步：这个页面是双击打开的单文件，没有构建、没有类型检查，
 * 语法过了不代表按钮真的能按。这里跑的是「打开页面 → 新建 → 编辑 → 回复 →
 * 改状态 → 筛选 → 删除」这条主路径，任何一步抛错就退出码非零。
 *
 * 用法: node docs/taskboard/check.mjs   （必须在装了 electron 的那一侧跑）
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

const main = `
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { sandbox: false } });
  const fail = (message) => { console.log("FAIL " + message); app.exit(1); };
  win.webContents.on("console-message", (_e, level, message) => {
    // 页面里任何一次未捕获的报错都算失败。
    if (level >= 3) fail("页面报错: " + message);
  });
  await win.loadFile(${JSON.stringify(join(here, "index.html"))});
  try {
    const result = await win.webContents.executeJavaScript(${JSON.stringify(readCheckScript())}, true);
    console.log(result);
    app.exit(String(result).startsWith("OK") ? 0 : 1);
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
});
`;

function readCheckScript() {
  // 在页面里跑的检查脚本。返回以 OK 开头的字符串表示通过。
  return `(async () => {
  const $ = (id) => document.getElementById(id);
  const steps = [];
  const check = (ok, what) => { steps.push((ok ? "· " : "✗ ") + what); if (!ok) throw new Error(what); };
  // 弹窗的 close 事件是下一拍才派发的，页面重画又在它里面，所以每次等两拍。
  const tick = () => new Promise((r) => setTimeout(() => setTimeout(r, 0), 0));

  // 起手式：内置数据渲染出来了
  localStorage.clear();
  state = load(); ui = loadUi(); refreshAreas(); render();
  const seeded = state.tasks.length;
  check(seeded > 0, "内置数据里有 " + seeded + " 个 Issue");
  check(document.querySelectorAll(".card").length > 0, "卡片渲染出来了");
  check(document.querySelectorAll(".stats-legend span").length === 6, "进度条图例有五列加一个总计");

  // 新建：走的是自己的表单弹窗，不是浏览器 prompt
  check(typeof window.prompt === "function", "环境里确实有 prompt（下面要确认我们没用它）");
  check(!/[^.\\w]prompt\\(/.test(document.querySelector("script").textContent), "页面里没有再调用浏览器 prompt");
  check(!/[^.\\w]confirm\\(/.test(document.querySelector("script").textContent), "页面里没有再调用浏览器 confirm");
  check(!/[^.\\w]alert\\(/.test(document.querySelector("script").textContent), "页面里没有再调用浏览器 alert");

  $("new").click(); await tick();
  check($("formDlg").open, "新建弹窗打开了");
  $("fOk").click(); await tick();
  check($("formDlg").open, "标题为空时不许提交");
  check($("fErr").textContent.length > 0, "空标题会在字段下面给出提示，而不是弹 alert");
  $("fName").value = "自检用的临时 Issue";
  $("fBody").value = "这条是自检脚本建的，跑完会删掉。";
  $("fArea2").value = "自检";
  $("fPrio2").value = "high";
  $("fOk").click(); await tick(); await tick();
  check(!$("formDlg").open, "填好标题后弹窗关闭");
  check(state.tasks.length === seeded + 1, "新 Issue 进了数据");
  const made = state.tasks[state.tasks.length - 1];
  check(made.priority === "high" && made.area === "自检", "优先级和模块都存下来了");
  check($("dlg").open, "新建之后自动打开了详情");

  // 回复：写字 + 发送
  $("eNew").value = "自检写的一条回复。";
  $("eSend").click(); await tick();
  check((made.userComments || []).length === 1, "回复存下来了");
  check($("mine").querySelectorAll(".note.mine").length === 1, "回复渲染出来了");

  // 回复：改
  document.querySelector("[data-edit]").click(); await tick();
  check($("eNew").value === "自检写的一条回复。", "点修改会把原文填回输入框");
  $("eNew").value = "改过之后的内容。";
  $("eSend").click(); await tick();
  check(made.userComments[0].text === "改过之后的内容。", "回复改得动");
  check(!!made.userComments[0].editedAt, "改过的回复带上了修改时间");

  // 回复：删（走自己的确认弹窗）
  document.querySelector("[data-del]").click(); await tick();
  check($("confirmDlg").open, "删除会先弹自己的确认框");
  $("cNo").click(); await tick();
  check(made.userComments.length === 1, "取消之后没有真删");
  document.querySelector("[data-del]").click(); await tick();
  $("cYes").click(); await tick(); await tick();
  check(made.userComments.length === 0, "确认之后删掉了");

  // 状态：下拉改
  $("eStatus").value = "review";
  $("eStatus").dispatchEvent(new Event("change"));
  check(made.status === "review", "状态改得动");

  // 编辑标题正文
  $("eEdit").click(); await tick();
  check($("formDlg").open && $("fName").value === made.title, "编辑弹窗带出了现有标题");
  $("fName").value = "改过标题的自检 Issue";
  $("fOk").click(); await tick(); await tick();
  check(made.title === "改过标题的自检 Issue" && made.titleEdited === true, "标题改得动并标记为用户改过");

  // 前后翻
  check(!!$("aPrev") && !!$("aNext"), "详情底部有前后翻按钮");

  $("dlg").close(); await tick();
  check(!$("dlg").open, "详情关得掉");

  // 筛选
  $("q").value = "自检"; render();
  const hits = document.querySelectorAll(".card").length;
  check(hits >= 1, "搜索能搜到（含正文和回复）");
  $("q").value = "不可能存在的字符串zzzq"; render();
  check(document.querySelectorAll(".card").length === 0, "搜不到时列是空的");
  $("clearF").click(); await tick();
  check(document.querySelectorAll(".card").length > 0, "清除筛选恢复了");

  $("fPrio").value = "high"; render();
  check([...document.querySelectorAll(".card")].every((c) => c.classList.contains("p-high")), "按优先级筛得动");
  $("fPrio").value = ""; render();

  // 排序
  $("sort").value = "prio"; render();
  check(document.querySelectorAll(".card").length > 0, "按优先级排序不炸");
  $("sort").value = "id"; render();

  // 隐藏某一列
  document.querySelector("[data-col-toggle='done']").click(); await tick();
  check(!document.querySelector("[data-col='done']"), "点图例能隐藏一整列");
  document.querySelector("[data-col-toggle='done']").click(); await tick();
  check(!!document.querySelector("[data-col='done']"), "再点一次又回来了");

  // 未读标记
  const withNotes = state.tasks.find((t) => (t.agentNotes || []).length);
  if (withNotes) {
    delete ui.seen[withNotes.id]; saveUi(); render();
    check(!!document.querySelector(".card .new-tag"), "没看过的 Issue 有「新」标记");
    openTask(withNotes.id); await tick();
    $("dlg").close(); await tick();
    const card = document.querySelector("[data-id='" + withNotes.id + "']");
    check(!!card, "看过的那条卡片还在（id " + withNotes.id + "）");
    check(!card.querySelector(".new-tag"),
      "看过之后标记消失（unseen=" + unseenCount(withNotes) + " seen=" + ui.seen[withNotes.id] +
      " 最新一条=" + (withNotes.agentNotes[withNotes.agentNotes.length-1] || {}).at + "）");
  }

  // 草稿
  openTask(made.id); await tick();
  $("eNew").value = "写了一半"; $("eNew").dispatchEvent(new Event("input"));
  $("dlg").close(); await tick();
  openTask(made.id); await tick();
  check($("eNew").value === "写了一半", "写了一半关掉，再打开草稿还在");
  $("eNew").value = ""; $("eNew").dispatchEvent(new Event("input"));

  // 删除 Issue
  $("aDel").click(); await tick();
  check($("confirmDlg").open, "删 Issue 也走自己的确认框");
  $("cYes").click(); await tick(); await tick();
  check(state.tasks.length === seeded, "自检建的 Issue 已经删掉，数据回到起点");

  localStorage.clear();
  return "OK " + steps.length + " 项全部通过\\n" + steps.join("\\n");
})()`;
}

const dir = mkdtempSync(join(tmpdir(), "coilcoil-board-check-"));
const entry = join(dir, "main.cjs");
writeFileSync(entry, main, "utf8");

const electron = join(repo, "node_modules", ".bin", "electron");
const child = spawn(electron, [entry], { stdio: "inherit", env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } });
child.on("exit", (code) => process.exit(code ?? 1));
