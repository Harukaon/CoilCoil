import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const description = "拖放：用户在页面里拖东西（拖得动、Esc 能取消、拖完照常点击）、Agent 用 drag 工具拖、从外面拖文件进上传区和选文件框、拖到空白处什么都不发生；面板上拖着文件经过时有提示";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("drag.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);
const takeLog = async (app) => JSON.parse(await inPage(app, "JSON.stringify(log.splice(0))"));

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("drag.html") } }, { echo: true }], "拖放");
  await ui.waitFor(async () => (await inPage(app, "document.readyState")) === "complete");
  await page.waitForTimeout(500);
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, `JSON.stringify(Object.fromEntries(["zone", "picker", "a", "b", "plain"].map((id) => [id, document.getElementById(id).getBoundingClientRect()]).concat([["size", { width: innerWidth, height: innerHeight }]])))`));
  const scale = Math.min(box.width / layout.size.width, box.height / layout.size.height);
  const center = (rect) => ({ x: box.x + (rect.x + rect.width / 2) * scale, y: box.y + (rect.y + rect.height / 2) * scale });
  const pageCenter = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

  // 1. 用户在画面上把 A 拖到 B。
  const a = center(layout.a);
  const b = center(layout.b);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  let log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog(app)); return log.some((line) => line.startsWith("a:dragend")); }, 5000);
  check("用户拖：页面开始拖了", log.includes("a:dragstart"), JSON.stringify(log));
  check("用户拖：拖进了 B", log.includes("b:dragenter"), JSON.stringify(log));
  check("用户拖：放在 B 上，拿到了拖的内容", log.includes("b:drop:from-a"), JSON.stringify(log));
  check("用户拖：拖拽正常结束", log.some((line) => line.startsWith("a:dragend:") && line !== "a:dragend:none"), JSON.stringify(log));

  // 2. 拖到一半按 Esc：取消，松在 B 上也不算放下。
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 8 });
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog(app)); return log.some((line) => line.startsWith("a:dragend")); }, 5000);
  check("Esc 取消拖拽：没有放下", !log.some((line) => line.startsWith("b:drop")), JSON.stringify(log));
  check("Esc 取消拖拽：拖拽结束了", log.includes("a:dragend:none"), JSON.stringify(log));

  // 3. 拖完以后普通点击照常。
  const plain = center(layout.plain);
  await page.mouse.click(plain.x, plain.y);
  check("拖完以后点按钮照常", await ui.waitFor(async () => (await takeLog(app)).includes("clicked"), 3000));

  // 4. Agent 用 drag 工具把 A 拖到 B。
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "拖放");
  const snapshot = await ui.lastEcho();
  const fromUid = /uid=(\S+) button "拖我"/.exec(snapshot)?.[1];
  const toUid = /uid=(\S+) button "放这里"/.exec(snapshot)?.[1];
  check("快照里找得到 A 和 B", fromUid && toUid, snapshot.slice(0, 300));
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "drag", args: { from_uid: fromUid, to_uid: toUid } } }, { echo: true }], "拖放");
  log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog(app)); return log.some((line) => line.startsWith("a:dragend")); }, 8000);
  check("Agent 拖：放在 B 上，拿到了拖的内容", log.includes("b:drop:from-a"), `${JSON.stringify(log)} ${(await ui.lastEcho()).slice(0, 200)}`);

  // 5. 从外面拖文件进来（桌面窗口松手后交给主进程的那一步，路径由预加载从真文件上取）。
  const folder = mkdtempSync(join(tmpdir(), "coilcoil-e2e-drop-"));
  const file = join(folder, "dropped.txt");
  writeFileSync(file, "hello from finder");
  // 当前会话和标签页的编号：面板往页面送鼠标移动时顺手记下来。
  await app.evaluate(({ ipcMain }) => {
    globalThis.__browserIds = undefined;
    ipcMain.once("browser:input", (_event, scopeId, tabId) => { globalThis.__browserIds = { scopeId, tabId }; });
  });
  await page.mouse.move(plain.x + 30, plain.y + 30);
  await page.mouse.move(plain.x + 40, plain.y + 40);
  const idsKnown = await ui.waitFor(async () => Boolean(await app.evaluate(() => globalThis.__browserIds)), 3000);
  check("拿到了当前会话和标签页", idsKnown);
  const dropFiles = (point, paths) => app.evaluate(({ BrowserWindow, ipcMain }, { point, paths }) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.webContents.isOffscreen());
    const { scopeId, tabId } = globalThis.__browserIds;
    ipcMain.emit("browser:drop-files", { sender: window.webContents }, scopeId, tabId, { ...point, modifiers: {} }, paths);
  }, { point, paths });
  await dropFiles(pageCenter(layout.zone), [file]);
  log = [];
  await ui.waitFor(async () => { log = log.concat(await takeLog(app)); return log.some((line) => line.startsWith("zone:text")); }, 5000);
  check("拖文件到上传区：网页看到的是文件", log.includes("zone:dragenter:Files"), JSON.stringify(log));
  check("拖文件到上传区：拿到了这个文件和它的内容", log.includes("zone:drop:dropped.txt") && log.includes("zone:text:hello from finder"), JSON.stringify(log));
  await dropFiles(pageCenter(layout.picker), [file]);
  check("拖文件到选文件框：文件进了框里", await ui.waitFor(async () => (await takeLog(app)).includes("picker:dropped.txt"), 5000));
  const before = await inPage(app, "location.href");
  await dropFiles({ x: layout.size.width - 20, y: layout.size.height - 20 }, [file]);
  await page.waitForTimeout(800);
  check("拖文件到空白处：页面没被换成这个文件", (await inPage(app, "location.href")) === before, String(await inPage(app, "location.href")));
  await dropFiles(pageCenter(layout.zone), ["/definitely/not/here.txt", "relative/path.txt"]);
  await page.waitForTimeout(500);
  check("不存在的、相对的路径不收", !(await takeLog(app)).some((line) => line.startsWith("zone:drop")));

  // 6. 面板上拖着文件经过：一圈提示；离开就收起。
  const hint = page.locator(".browser-drop-hint");
  await page.evaluate(() => {
    const layer = document.querySelector(".browser-live-input");
    const data = new DataTransfer();
    data.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
    layer.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  check("拖着文件经过：面板上有提示", await ui.waitFor(async () => (await hint.count()) === 1, 2000));
  await shot("drop-hint");
  await page.evaluate(() => {
    const layer = document.querySelector(".browser-live-input");
    layer.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: document.body, dataTransfer: new DataTransfer() }));
  });
  check("拖走了：提示收起", await ui.waitFor(async () => (await hint.count()) === 0, 2000));
}
