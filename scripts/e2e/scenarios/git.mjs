import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "Git 面板：看改动和 diff、暂存、提交、新建分支、推送、丢弃";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function run({ page, ui, check, shot, root, paths }) {
  const repo = paths.projA;
  const remote = join(root, "remote.git");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "E2E");
  git(repo, "config", "user.email", "e2e@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "# projA\n\n新的一行\n");
  writeFileSync(join(repo, "scratch.txt"), "临时文件\n");

  await ui.newConversation("projA");
  const expand = page.getByRole("button", { name: "展开作业栏" });
  if (await expand.count()) await expand.click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Git", exact: true }).first().click();

  const panel = page.locator(".git-panel");
  const fileRow = (name) => panel.locator(".git-file", { has: page.locator(".git-file-name", { hasText: name }) });
  check("改动列表里有修改的和未跟踪的文件", await ui.waitFor(async () => (await fileRow("README.md").count()) === 1 && (await fileRow("scratch.txt").count()) === 1),
    await panel.innerText().catch(() => ""));
  check("状态字母：README 是 M，scratch 是 U",
    (await fileRow("README.md").locator(".git-file-state").innerText()) === "M" && (await fileRow("scratch.txt").locator(".git-file-state").innerText()) === "U");
  check("分支按钮显示 main", (await panel.getByRole("button", { name: "切换分支" }).innerText()).includes("main"));
  await shot("changes");

  // diff：默认单栏，切到左右对照，再回来。
  await fileRow("README.md").locator(".git-file-open").click();
  await panel.locator(".git-diff-body").waitFor({ timeout: 10_000 });
  const added = await panel.locator(".git-diff-text.add").allInnerTexts();
  check("单栏 diff 显示新增行", added.some((text) => text.includes("新的一行")), JSON.stringify(added));
  await panel.getByRole("button", { name: "左右对照" }).click();
  check("可以切到左右对照", await panel.locator(".git-diff-body.split").count() === 1);
  const rightSide = await panel.locator(".git-diff-body.split .git-diff-text.add").allInnerTexts();
  check("左右对照里新增行在右边", rightSide.includes("新的一行"), JSON.stringify(rightSide));
  await shot("diff-split");
  await panel.getByRole("button", { name: "返回改动列表" }).click();

  // 只暂存 README，然后提交。
  await fileRow("README.md").hover();
  await panel.getByRole("button", { name: "暂存 README.md" }).click();
  check("暂存后出现「已暂存的更改」", await ui.waitFor(async () => (await panel.getByText("已暂存的更改").count()) === 1));
  check("git 里 README 确实进了暂存区", git(repo, "diff", "--cached", "--name-only") === "README.md");
  await panel.getByRole("textbox", { name: "提交说明" }).fill("从面板提交");
  const commitButton = panel.locator(".git-commit-button");
  check("提交按钮写着只提交暂存的 1 个文件", (await commitButton.innerText()).includes("提交 1 个文件"));
  await commitButton.click();
  check("提交成功，暂存区清空", await ui.waitFor(async () => (await panel.getByText("已暂存的更改").count()) === 0));
  check("git log 里有这次提交", git(repo, "log", "-1", "--format=%s") === "从面板提交");
  check("没暂存的 scratch.txt 没被提交", git(repo, "status", "--porcelain") === "?? scratch.txt");

  // 新建分支并切过去，然后推送（第一次推送自动设上游）。
  await panel.getByRole("button", { name: "切换分支" }).click();
  await panel.getByRole("textbox", { name: "新分支名" }).fill("feature/e2e");
  await panel.getByRole("textbox", { name: "新分支名" }).press("Enter");
  check("切到了新分支", await ui.waitFor(async () => (await panel.getByRole("button", { name: "切换分支" }).innerText()).includes("feature/e2e")));
  check("git 里当前分支是 feature/e2e", git(repo, "branch", "--show-current") === "feature/e2e");
  await panel.getByRole("button", { name: "推送" }).click();
  check("推送到远程仓库", await ui.waitFor(async () => {
    try { return git(remote, "rev-parse", "feature/e2e") === git(repo, "rev-parse", "HEAD"); } catch { return false; }
  }, 20_000));
  check("推送后设好了上游", await ui.waitFor(async () => {
    try { return git(repo, "rev-parse", "--abbrev-ref", "@{upstream}") === "origin/feature/e2e"; } catch { return false; }
  }));

  // 丢弃未跟踪文件要先确认。
  await fileRow("scratch.txt").hover();
  await panel.getByRole("button", { name: "丢弃 scratch.txt" }).click();
  await page.getByRole("button", { name: "丢弃", exact: true }).click();
  check("确认后未跟踪文件被删掉", await ui.waitFor(async () => !existsSync(join(repo, "scratch.txt"))));
  check("工作区干净了", await ui.waitFor(async () => (await panel.getByText("工作区是干净的").count()) === 1));
  await shot("clean");
}
