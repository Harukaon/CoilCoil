import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const description = "网页要系统窗口的两件事——选文件、打印：Agent 点到时什么都不弹、不抢焦点、App 不卡；Agent 用自己的工具照样能上传；用户自己点时，选文件照常、打印出一份 PDF";

const inPage = (app, code) => app.evaluate(({ webContents }, code) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("system.html"));
  return contents ? contents.executeJavaScript(code) : undefined;
}, code);
const title = (app) => inPage(app, "document.title");

/** App 窗口还是系统里的当前窗口：弹了系统面板的话，它就不是了。 */
const appWindowFocused = (app) => app.evaluate(({ BrowserWindow }) => {
  const focused = BrowserWindow.getFocusedWindow();
  return Boolean(focused && !focused.webContents.isOffscreen());
});

export async function run({ app, page, ui, site, check, shot }) {
  const folder = mkdtempSync(join(tmpdir(), "coilcoil-e2e-upload-"));
  const upload = join(folder, "agent-upload.txt");
  const picked = join(folder, "user-picked.txt");
  writeFileSync(upload, "from agent");
  writeFileSync(picked, "from user");
  // 系统的选文件面板、PDF 查看器在测试里换成替身：记下调用，不真的弹出来。
  await app.evaluate(({ dialog, shell }, picked) => {
    globalThis.__openDialogs = 0;
    globalThis.__openedPaths = [];
    dialog.showOpenDialog = async () => { globalThis.__openDialogs += 1; return { canceled: false, filePaths: [picked] }; };
    shell.openPath = async (path) => { globalThis.__openedPaths.push(path); return ""; };
  }, picked);
  const openDialogs = () => app.evaluate(() => globalThis.__openDialogs);
  const openedPaths = () => app.evaluate(() => globalThis.__openedPaths);

  await ui.newConversation("projA");
  await ui.openBrowserPanel();
  await ui.send([{ tool: "browser_open", args: { url: site.url("system.html") } }, { echo: true }], "系统窗口");
  await ui.send([{ tool: "browser_click", args: { handle: "btab-1", uid: "999_999" } }, { echo: true }], "系统窗口");
  const snapshot = await ui.lastEcho();
  const fileUid = /uid=(\S+) button "上传文件/.exec(snapshot)?.[1] ?? /uid=(\S+)[^\n]*上传文件/.exec(snapshot)?.[1];
  const printUid = /uid=(\S+) button "打印"/.exec(snapshot)?.[1];
  check("快照里找得到上传框和打印按钮", fileUid && printUid, snapshot.slice(0, 400));

  // 1. 用户在对话框里打字，Agent 这一轮点上传框、点打印：什么都不弹，焦点不动，App 不卡。
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.webContents.isOffscreen());
    app.focus({ steal: true });
    window?.show();
    window?.focus();
  });
  // 新版 macOS 在有人正用着电脑时不让别的程序抢前台：拿不到就跳过「系统焦点」那一项，
  // 只看页面内的焦点（那是用户真正会碰到的：字打到哪儿去了）。
  const systemFocus = await ui.waitFor(() => appWindowFocused(app), 3000);
  const composer = page.locator(".prompt-editor");
  const echoes = await page.getByText("工具返回", { exact: false }).count();
  await composer.click();
  await page.keyboard.insertText(`系统窗口 MOCK:${JSON.stringify([
    { tool: "browser_click", args: { handle: "btab-1", uid: fileUid } },
    { tool: "browser_click", args: { handle: "btab-1", uid: printUid } },
    { echo: true },
  ])}`);
  await page.keyboard.press("Enter");
  await ui.waitFor(async () => (await page.getByText("工具返回", { exact: false }).count()) > echoes, 60_000);
  check("Agent 点打印：页面没被打印框卡住，接着往下跑了", await ui.waitFor(async () => (await title(app)) === "printed-1"), await title(app));
  if (systemFocus) check("App 窗口还是当前窗口：没弹系统面板", await appWindowFocused(app));
  else console.log("SKIP  App 窗口还是当前窗口：这次测试拿不到系统焦点（有人正用着电脑），只查了页面内的焦点");
  check("焦点还在对话框里", await page.evaluate(() => Boolean(document.activeElement?.closest(".prompt-editor"))));
  await page.keyboard.type("照常打字");
  check("接着打的字进了对话框", (await composer.innerText()).includes("照常打字"));
  check("Agent 点的：没弹选文件面板，也没出 PDF", (await openDialogs()) === 0 && (await openedPaths()).length === 0,
    JSON.stringify({ dialogs: await openDialogs(), pdf: await openedPaths() }));

  // 2. Agent 用自己的工具上传：拦截不影响它。
  await ui.send([{ tool: "mcp", args: { action: "call", server: "coilcoil-browser", tool: "upload_file", args: { uid: fileUid, filePath: upload } } }, { echo: true }], "系统窗口");
  check("Agent 用 upload_file 上传成功", await ui.waitFor(async () => (await title(app)) === "file-agent-upload.txt"), `${await title(app)} ${(await ui.lastEcho()).slice(0, 200)}`);

  // 3. 用户自己在画面上点上传框：弹选文件的面板（这里是替身），挑的文件进了页面。
  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, "JSON.stringify({ f: document.getElementById('f').getBoundingClientRect(), p: document.getElementById('p').getBoundingClientRect(), width: innerWidth, height: innerHeight })"));
  const scale = Math.min(box.width / layout.width, box.height / layout.height);
  const at = (rect) => ({ x: box.x + (rect.x + 30) * scale, y: box.y + (rect.y + rect.height / 2) * scale });
  const fileAt = at(layout.f);
  await page.mouse.click(fileAt.x, fileAt.y);
  check("用户点上传框：弹了选文件的面板", await ui.waitFor(async () => (await openDialogs()) === 1), String(await openDialogs()));
  check("用户挑的文件进了页面", await ui.waitFor(async () => (await title(app)) === "file-user-picked.txt"), await title(app));

  // 4. 用户自己点打印：存成 PDF 交给系统打开（这里是替身，记下路径）。
  const printAt = at(layout.p);
  await page.mouse.click(printAt.x, printAt.y);
  check("用户点打印：页面照常往下跑", await ui.waitFor(async () => (await title(app)) === "printed-2"), await title(app));
  check("用户点打印：出了一份 PDF 交给系统打开", await ui.waitFor(async () => (await openedPaths()).length === 1), JSON.stringify(await openedPaths()));
  const [pdf] = await openedPaths();
  check("那份 PDF 是真的 PDF", Boolean(pdf) && readFileSync(pdf).subarray(0, 4).toString() === "%PDF");
  await shot("after");
}
