import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "上层文件夹当工作区、里面放好几个小项目：Git 面板不卡、能选子仓库、能滚动、批量操作先确认";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
const identity = (repo) => {
  git(repo, "config", "user.name", "E2E");
  git(repo, "config", "user.email", "e2e@example.com");
  git(repo, "config", "commit.gpgsign", "false");
};

export async function run({ page, ui, check, shot, paths }) {
  const root = paths.projA;
  // 总数 5204 = 5200 个改过的文件 + loose1/、loose2/ + 子仓库 appA/、appB/（在上层仓库看来也是没跟踪的文件夹）。
  // 上层文件夹本身是个仓库：5200 个已跟踪文件全改了（超过 5000 的上限），还有两个没跟踪的
  // 小项目各几百个文件；另有两个子文件夹是独立的仓库。
  git(root, "init", "-q", "-b", "main");
  identity(root);
  mkdirSync(join(root, "tracked"));
  for (let index = 0; index < 5200; index += 1) writeFileSync(join(root, "tracked", `f${index}.txt`), "v1\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  for (let index = 0; index < 5200; index += 1) writeFileSync(join(root, "tracked", `f${index}.txt`), "v2\n");
  for (const project of ["loose1", "loose2"]) {
    mkdirSync(join(root, project, "src"), { recursive: true });
    for (let index = 0; index < 400; index += 1) writeFileSync(join(root, project, "src", `m${index}.ts`), "x\n");
  }
  for (const project of ["appA", "appB"]) {
    const repo = join(root, project);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    identity(repo);
    writeFileSync(join(repo, "index.js"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, "index.js"), `2 ${project}\n`);
  }

  await ui.newConversation("projA");
  const expand = page.getByRole("button", { name: "展开作业栏" });
  if (await expand.count()) await expand.click();
  await page.waitForTimeout(300);
  const started = Date.now();
  await page.getByRole("button", { name: "Git", exact: true }).first().click();
  const panel = page.locator(".git-panel");
  const notice = panel.locator(".git-notice");
  check("改动超过上限时提示总数", await ui.waitFor(async () => (await notice.count()) === 1, 20_000), await panel.innerText().catch(() => ""));
  const elapsed = Date.now() - started;
  check("打开很快（不到 10 秒）", elapsed < 10_000, `${elapsed}ms`);
  check("提示里写着总共多少处", (await notice.innerText()).includes("5204"), await notice.innerText());
  const rows = () => panel.locator(".git-section .git-file").count();
  check("挂在页面上的行数有上限", (await rows()) <= 200, String(await rows()));
  const alive = await page.evaluate(() => new Promise((resolve) => { const start = performance.now(); requestAnimationFrame(() => resolve(performance.now() - start)); }));
  check("界面还能响应", alive < 1000, `${alive}ms`);
  const folders = await panel.locator(".git-file-name").allInnerTexts();
  check("没跟踪的小项目各算一条文件夹", folders.includes("loose1/") && folders.includes("loose2/"), JSON.stringify(folders.filter((name) => name.endsWith("/"))));
  await panel.getByRole("button", { name: /显示更多/ }).click();
  check("显示更多再画一批", (await rows()) > 200 && (await rows()) <= 400, String(await rows()));

  const select = panel.getByRole("button", { name: "仓库" });
  await select.click();
  const options = (await page.getByRole("option").allInnerTexts()).map((text) => text.split("\n")[0]);
  await page.keyboard.press("Escape");
  check("找到工作区所在的仓库和两个子仓库", options.length === 3 && options.some((text) => text.includes("工作区所在的仓库")) && options.includes("appA") && options.includes("appB"), JSON.stringify(options));

  // 滚动：鼠标在面板上滚轮，面板真的滚下去。
  const scroller = page.locator(".git-tab-panel");
  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 2000);
  check("面板可以滚动", await ui.waitFor(async () => (await scroller.evaluate((element) => element.scrollTop)) > 0), String(await scroller.evaluate((element) => [element.scrollTop, element.scrollHeight, element.clientHeight].join("/"))));
  await shot("large");

  // 全部暂存：超过 50 处先确认，确认后整个仓库都暂存（包括没列出来的）。
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await panel.getByRole("button", { name: "全部暂存" }).click();
  const dialog = page.getByRole("dialog");
  check("批量暂存先确认，写明仓库和数量", await ui.waitFor(async () => (await dialog.getByText("暂存全部改动？").count()) === 1) && (await dialog.innerText()).includes("5204"), await dialog.innerText().catch(() => ""));
  await dialog.getByRole("button", { name: "全部暂存" }).click();
  check("确认后整个仓库都暂存了", await ui.waitFor(async () => git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean).length > 5000, 20_000));

  await select.click();
  await page.getByRole("option", { name: /^appA/ }).click();
  check("切到子仓库只看它自己的改动", await ui.waitFor(async () => JSON.stringify(await panel.locator(".git-file-name").allInnerTexts()) === '["index.js"]'), JSON.stringify(await panel.locator(".git-file-name").allInnerTexts()));
  check("子仓库里没有「改动太多」的提示", (await notice.count()) === 0);
}
