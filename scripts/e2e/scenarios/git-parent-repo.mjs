import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const description = "Git 面板只认工作区自己的仓库：上层文件夹是仓库、工作区自己不是时，不显示上层仓库的改动和历史";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const init = (cwd) => {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "E2E");
  git(cwd, "config", "user.email", "e2e@example.com");
  git(cwd, "config", "commit.gpgsign", "false");
};

export async function run({ page, ui, check, shot, root, paths }) {
  // 上层文件夹是一个仓库，里面放着别的项目的提交；projA 是它下面一个还没建 git 的子文件夹，
  // projB 是它下面一个自己也有 git 的子项目。
  init(root);
  writeFileSync(join(root, "other-project.txt"), "别的项目\n");
  git(root, "add", "other-project.txt");
  git(root, "commit", "-q", "-m", "上层仓库的提交：别的项目");
  init(paths.projB);
  git(paths.projB, "add", "-A");
  git(paths.projB, "commit", "-q", "-m", "projB 自己的提交");

  const openGit = async () => {
    const expand = page.getByRole("button", { name: "展开作业栏" });
    if (await expand.count()) await expand.click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Git", exact: true }).first().click();
    await page.waitForTimeout(1500);
  };
  const panel = page.locator(".git-panel");
  const text = () => panel.innerText().catch(() => "");

  // 1. 工作区自己还没有 git：面板说没有仓库，不拿上层仓库的东西充数。
  await ui.newConversation("projA");
  await openGit();
  check("没有 git 的子文件夹：面板显示「没有 git 仓库」", await ui.waitFor(async () => (await text()).includes("没有 git 仓库")), await text());
  check("没有 git 的子文件夹：看不到上层仓库的提交", !(await text()).includes("上层仓库的提交"), await text());
  check("没有 git 的子文件夹：没有「丢弃全部」这类会动到上层仓库的按钮", (await panel.getByRole("button", { name: /丢弃/ }).count()) === 0);
  await shot("no-repo");

  // 2. 子项目自己有 git：只显示它自己的，照常能用。
  await ui.newConversation("projB");
  await openGit();
  const history = panel.getByText("projB 自己的提交", { exact: false });
  check("自己有 git 的子项目：显示的是它自己的仓库", await ui.waitFor(async () => (await text()).includes("main") && !(await text()).includes("没有 git 仓库")), await text());
  check("自己有 git 的子项目：历史里是它自己的提交", await ui.waitFor(async () => (await history.count()) > 0), await text());
  check("自己有 git 的子项目：历史里没有上层仓库的提交", !(await text()).includes("上层仓库的提交"), await text());
  await shot("own-repo");
}
