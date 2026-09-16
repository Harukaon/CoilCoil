import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const styles = readFileSync(resolve(rendererRoot, "styles.css"), "utf8");

/** styles.css 一条规则写一行，取出选择器后面那对花括号里的声明。 */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, "m").exec(styles);
  assert.ok(match, `styles.css 里找不到 ${selector} 这条规则`);
  return match[1];
}

function pixels(selector: string, property: string): number {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)(?:px)?\\s*(?:;|$)`).exec(declarations(selector));
  assert.ok(match, `${selector} 上没有 ${property}`);
  return Number.parseFloat(match[1]);
}

/** 渲染层里所有文件，用来做整片扫描。 */
function rendererFiles(extensions: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
    }
  };
  walk(rendererRoot);
  return found;
}

/** 挂了 <WindowDragBar /> 的那些标题栏容器。 */
const DRAG_BAR_HOSTS = [
  "conversation-header",
  "inspector-header",
  "skills-workspace-header",
  "memory-workspace-header",
  "issue-board-header",
  "sidebar-drag",
];

test("拖动层铺满标题栏，并且排在内容下面", () => {
  const layer = declarations(".window-drag-layer");
  assert.match(layer, /position:\s*absolute/);
  assert.match(layer, /inset:\s*0/);
  // 层要在内容下面，否则它会把标题栏里按钮的点击吃掉。
  assert.match(declarations(".window-drag-layer ~ *"), /z-index:\s*1/);
});

test("宿主标题栏都给拖动层建立了定位上下文", () => {
  assert.match(declarations(".window-drag-bar"), /position:\s*relative/);
  for (const host of DRAG_BAR_HOSTS) {
    if (host === "issue-board-header") continue; // 它的样式在 features/issues/issues.css 里。
    assert.match(declarations(`.${host}`), /position:\s*relative/, `.${host} 需要 position: relative`);
  }
});

test("挂了拖动层的标题栏，标记类必须写在标记里", () => {
  // 以前这个类是脚本在运行时补上去的，跟着刷新机制一起拆了。现在没有任何脚本会补，
  // 漏写就等于拖动层没有定位上下文，会铺到更外面某个祖先上去。
  const offenders: string[] = [];
  for (const file of rendererFiles([".tsx"])) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("<WindowDragBar")) continue;
    if (file.endsWith("WindowDragBar.tsx")) continue;
    for (const host of DRAG_BAR_HOSTS) {
      if (!source.includes(host)) continue;
      const written = new RegExp(`className="[^"]*\\b${host}\\b[^"]*window-drag-bar`).test(source)
        || new RegExp(`className="[^"]*window-drag-bar[^"]*\\b${host}\\b`).test(source);
      if (!written) offenders.push(`${file.slice(rendererRoot.length + 1)} → .${host}`);
    }
  }
  assert.deepEqual(offenders, [], "挂 <WindowDragBar /> 的容器要同时写上 window-drag-bar");
});

test("拖动区只由拖动层提供，标题栏元素自己不写 app-region", () => {
  // 以前是「哪里拖不动就给哪个元素补一条 CSS」，补出来的规则彼此不知道对方存在。
  // 现在的约定是：只有 .window-drag 这一个类给 drag，只有交互元素给 no-drag。
  const dragRules = styles
    .split("\n")
    .filter((line) => /-webkit-app-region:\s*drag/.test(line))
    .map((line) => line.slice(0, line.indexOf("{")).trim());
  assert.deepEqual(dragRules, [".window-drag"]);
});

test("右侧栏标签条让出的宽度，正好够按钮、间距和那条拖动带", () => {
  const header = declarations(".inspector-header");
  const horizontalPadding = 2 * Number.parseFloat(/padding:\s*[\d.]+(?:px)?\s+([\d.]+)px/.exec(header)?.[1] ?? "NaN");
  const gaps = 2 * Number.parseFloat(/gap:\s*([\d.]+)px/.exec(header)?.[1] ?? "NaN");
  // 右侧永远是「打开面板」+「收起右侧栏」两个 icon-button，中间 2px。
  const actions = 2 * pixels(".icon-button", "width") + Number.parseFloat(/gap:\s*([\d.]+)px/.exec(declarations(".inspector-actions"))?.[1] ?? "NaN");
  const band = pixels(".inspector-drag-surface", "min-width");

  const reserved = Number.parseFloat(
    /max-width:\s*calc\(100% - ([\d.]+)px\)/.exec(declarations(".inspector-nav"))?.[1] ?? "NaN",
  );
  assert.ok(Number.isFinite(reserved), ".inspector-nav 必须用 calc(100% - Npx) 限宽");
  // 标签一多就会顶到 max-width；剩下的必须还够右侧按钮和整条拖动带，
  // 少一px 都会让标题栏先没得拖、再把按钮挤出可视区。
  assert.equal(reserved, band + actions + gaps + horizontalPadding);
  assert.ok(band >= 48, "拖动带留得太窄，按不住");
});

test("标题栏里的选择器不能用 :first-child——拖动层永远排在第一个", () => {
  // <WindowDragBar /> 插在最前面，`> div:first-child` 于是一条都匹配不上。记忆页
  // 的标题栏就是这么坏掉的：包图标和标题的那个 div 从 flex 掉回 block，图标被挤
  // 到标题栏外面。要按类型选就用 :first-of-type，最好直接给类名。
  const offenders: string[] = [];
  for (const file of rendererFiles([".css"])) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const brace = line.indexOf("{");
      if (brace < 0) continue;
      const selector = line.slice(0, brace);
      if (!selector.includes(":first-child")) continue;
      if (DRAG_BAR_HOSTS.some((host) => selector.includes(host))) offenders.push(selector.trim());
    }
  }
  assert.deepEqual(offenders, [], "标题栏里请改用 :first-of-type 或直接给类名");
});

test("no-window-drag 不是一个类，样式表里根本没有它", () => {
  // 写过这个类的两处元素本来就是 no-drag（一个是 button，一个自己写了 app-region），
  // 于是它看起来「有用」，实际上什么都没做——留着只会让下一个人以为标了就生效。
  const offenders = rendererFiles([".css", ".ts", ".tsx"])
    .filter((file) => readFileSync(file, "utf8").includes("no-window-drag"))
    .map((file) => file.slice(rendererRoot.length + 1));
  assert.deepEqual(offenders, [], "只有 .no-drag 这一个类，别再造一个同义词");
});

test("拆掉的刷新补丁不许再长回来", () => {
  // 2026-09-16 把整套「逼 Chromium 重算拖动矩形」的东西拆干净了：哨兵元素、悬停
  // 轮询、按下时重算、resize 重算、body 子节点监听、每条标题栏的两个观察器。它们
  // 治的是一个从来没被定位过的偶发失效，只是把现场盖住。再遇到拖不动，从「左侧栏
  // 那条是空的、会话标题栏上面压着文字」这个差别查起，不要往回加刷新。
  const banned = ["window-drag-sentinel", "refreshWindowDragRegions", "installWindowDragRegions", "observeWindowDragBar"];
  const offenders: string[] = [];
  for (const file of rendererFiles([".css", ".ts", ".tsx"])) {
    const source = readFileSync(file, "utf8");
    for (const token of banned) {
      if (source.includes(token)) offenders.push(`${file.slice(rendererRoot.length + 1)} → ${token}`);
    }
  }
  assert.deepEqual(offenders, [], "拖动带不要再加刷新机制，见 ui/WindowDragBar.tsx 的文件头");
});
