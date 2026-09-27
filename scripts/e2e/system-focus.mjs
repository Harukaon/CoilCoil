import { execFileSync } from "node:child_process";

/** 系统前台是哪个程序（进程号）；拿不到时是 undefined。 */
function frontPid() {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    // 只要 pid 的 -only 写法拿不到东西，取整段信息里的「pid = 123」。
    const info = execFileSync("lsappinfo", ["info", asn], { encoding: "utf8" });
    const pid = Number(/\bpid = (\d+)/.exec(info)?.[1]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 「App 窗口还是系统里的当前窗口」：App 弹了系统面板、系统对话框，它就不是了。
 *
 * 有人正用着这台电脑时，前台随时会被别的程序拿走（他点了一下浏览器），那不是 App 的毛病：
 * 前台是别的程序时这一项跳过；前台还是 App 自己、当前窗口却不是 App 窗口，才算失败。
 */
export async function checkAppWindowFocused(app, check, label) {
  const focused = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getFocusedWindow();
    return window ? (window.webContents.isOffscreen() ? "离屏页面" : "App 窗口") : "没有";
  });
  if (focused === "App 窗口") {
    check(label, true);
    return;
  }
  const ours = await app.evaluate(() => process.pid);
  const front = frontPid();
  if (front !== undefined && front !== ours) {
    console.log(`SKIP  ${label}：前台被别的程序拿走了（有人正用着电脑），只查了页面内的焦点`);
    return;
  }
  check(label, false, `App 自己在前台，当前窗口却是：${focused}`);
}

/**
 * 让测试里的 App 窗口一直露在最上面（浮动层），不被正用着电脑的人的其他窗口挡住。
 *
 * 窗口被完全挡住时，面板里的网页按设计降到一秒一帧省电（和最小化一样）；量帧率、看画面
 * 跟不跟得上的场景要先确保窗口露着，不然测出来的是「挡住了」而不是毛病。返回还原的函数。
 */
export async function keepAppWindowUncovered(app) {
  const level = (onTop) => app.evaluate(({ BrowserWindow }, onTop) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && !item.webContents.isOffscreen());
    if (onTop) window?.setAlwaysOnTop(true, "floating");
    else window?.setAlwaysOnTop(false);
  }, onTop);
  await level(true);
  return () => level(false).catch(() => undefined);
}
