import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "Git 面板的提交历史：线条图画出分叉和合并，展开提交看文件和 diff";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function identity(repo, name) {
  git(repo, "config", "user.name", name);
  git(repo, "config", "user.email", `${name.toLowerCase()}@example.com`);
  git(repo, "config", "commit.gpgsign", "false");
}

export async function run({ page, ui, check, shot, root, paths }) {
  const repo = paths.projA;
  const remote = join(root, "remote.git");
  git(repo, "init", "-q", "-b", "main");
  identity(repo, "E2E");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "初始化");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  // 一个功能分支合并回 main（--no-ff 留下合并提交）。
  git(repo, "switch", "-q", "-c", "feature");
  writeFileSync(join(repo, "feature.txt"), "功能\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "功能分支的提交");
  git(repo, "switch", "-q", "main");
  writeFileSync(join(repo, "README.md"), "# projA\n\nmain 上的改动\n");
  git(repo, "commit", "-q", "-am", "main 上的提交");
  git(repo, "merge", "-q", "--no-ff", "-m", "合并 feature", "feature");
  git(repo, "push", "-q", "-u", "origin", "main");
  // 远程多了一个提交、本地也多了一个：两边分叉。
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", remote, other]);
  identity(other, "Other");
  writeFileSync(join(other, "remote.txt"), "远程\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "远程的提交");
  git(other, "push", "-q");
  git(repo, "fetch", "-q");
  writeFileSync(join(repo, "local.txt"), "本地\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "本地的提交");
  // 一个没合并的旁支，只有「显示所有分支」时才看得到。
  git(repo, "branch", "side", "HEAD~2");
  git(repo, "switch", "-q", "side");
  writeFileSync(join(repo, "side.txt"), "旁支\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "旁支的提交");
  git(repo, "switch", "-q", "main");

  await page.evaluate(() => { for (const key of ["coilcoil.git.historyOpen", "coilcoil.git.historyAll"]) window.localStorage.removeItem(key); });
  await ui.newConversation("projA");
  const expand = page.getByRole("button", { name: "展开作业栏" });
  if (await expand.count()) await expand.click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Git", exact: true }).first().click();

  const panel = page.locator(".git-panel");
  const subjects = () => panel.locator(".git-commit-subject").allInnerTexts();
  check("提交历史默认展开，列出当前分支和上游的提交", await ui.waitFor(async () => (await subjects()).length === 6), JSON.stringify(await subjects()));
  const listed = await subjects();
  check("最新的本地提交在最上面", listed[0] === "本地的提交" || listed[0] === "远程的提交", JSON.stringify(listed));
  check("没合并的旁支默认不显示", !listed.includes("旁支的提交"));
  check("最早的提交在最下面", listed.at(-1) === "初始化");

  const row = (subject) => panel.locator(".git-commit-item", { has: page.locator(".git-commit-subject", { hasText: subject }) });
  check("HEAD 那一行加粗标出来", await row("本地的提交").evaluate((element) => element.classList.contains("head")));
  const mergeCircles = await row("合并 feature").locator(".git-graph circle").count();
  check("合并提交画成双圈", mergeCircles === 2, String(mergeCircles));
  const widest = Math.max(...await panel.locator(".git-commit-line .git-graph").evaluateAll((svgs) => svgs.map((svg) => Number(svg.getAttribute("width")))));
  check("分叉的地方图上有两条泳道", widest >= 33, String(widest));
  const lineColors = new Set(await panel.locator(".git-commit-line .git-graph path").evaluateAll((paths) => paths.map((path) => path.getAttribute("stroke"))));
  check("当前分支和上游用不同颜色的线", lineColors.has("var(--git-graph-ref)") && lineColors.has("var(--git-graph-remote)"), JSON.stringify([...lineColors]));
  const badges = await panel.locator(".git-ref").allInnerTexts();
  check("分支标签：main 和 origin/main", badges.includes("main") && badges.includes("origin/main"), JSON.stringify(badges));
  await shot("history");

  // 展开合并提交：它相对主线带进来的是 feature.txt。
  await row("合并 feature").locator(".git-commit-line").click();
  const fileNames = () => row("合并 feature").locator(".git-file-name").allInnerTexts();
  check("展开合并提交看到它带进来的文件", await ui.waitFor(async () => JSON.stringify(await fileNames()) === JSON.stringify(["feature.txt"])), JSON.stringify(await fileNames()));
  await row("合并 feature").locator(".git-file-open").first().click();
  await panel.locator(".git-diff-body").waitFor({ timeout: 10_000 });
  const title = await panel.locator(".git-diff-title").innerText();
  check("diff 标题写着是哪个提交", title.includes("feature.txt") && title.includes("合并 feature"), title.replace(/\n/g, " "));
  const added = await panel.locator(".git-diff-text.add").allInnerTexts();
  check("历史提交的 diff 显示新增内容", added.some((text) => text.includes("功能")), JSON.stringify(added));
  await shot("history-diff");
  await panel.getByRole("button", { name: "返回改动列表" }).click();
  check("从 diff 回来，展开的提交还展开着", (await fileNames()).includes("feature.txt"));

  // 从面板提交一次，新提交马上出现在最上面。
  writeFileSync(join(repo, "later.txt"), "later\n");
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await panel.getByRole("textbox", { name: "提交说明" }).fill("面板里的新提交");
  await panel.locator(".git-commit-button").click();
  check("新提交出现在历史最上面", await ui.waitFor(async () => (await subjects())[0] === "面板里的新提交"), JSON.stringify((await subjects()).slice(0, 2)));

  await panel.getByRole("button", { name: "显示所有分支" }).click();
  check("显示所有分支后看得到旁支", await ui.waitFor(async () => (await subjects()).includes("旁支的提交")), JSON.stringify(await subjects()));
  await shot("history-all");

  await panel.locator(".git-history .git-section-toggle").click();
  check("提交历史可以折叠", await ui.waitFor(async () => (await panel.locator(".git-commit-line").count()) === 0));
}
