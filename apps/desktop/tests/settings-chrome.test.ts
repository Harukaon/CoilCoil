import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const settingsCss = readFileSync(resolve(rendererRoot, "features/settings/settings.css"), "utf8");
const styles = readFileSync(resolve(rendererRoot, "styles.css"), "utf8");

/** 取出某条规则花括号里的声明；settings.css 里长规则是多行的，所以按块匹配。 */
function declarations(css: string, selector: string, label: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  assert.ok(match, `${label} 里找不到 ${selector} 这条规则`);
  return match[1];
}

function property(css: string, selector: string, name: string, label: string): string {
  const block = declarations(css, selector, label);
  const match = new RegExp(`(?:^|;|\\n)\\s*${name}:\\s*([^;}]+)`).exec(block);
  assert.ok(match, `${selector} 上没有 ${name}`);
  return match[1].trim();
}

test("设置界面的两块底色读主界面同一组表面令牌", () => {
  // 写死明度档位是配色对不上的原因：表面令牌还带着「界面层次」的选择，
  // 明度阶梯跟不上。见 settings.css 顶部的注释。
  // 贴着窗口边的表面读的是 `-glass` 那一层：颜色仍然来自 `--pane-fill` /
  // `--side-fill`，只是留出 `--window-tint` 让系统的高斯模糊透上来。
  assert.equal(property(settingsCss, ".settings-screen", "background", "settings.css"), "var(--pane-glass)");
  assert.equal(property(settingsCss, ".settings-sidebar", "background", "settings.css"), "var(--side-glass)");
  // 主界面的对应两块必须读同一组令牌，否则设置一开就跳色。
  assert.equal(property(styles, ".conversation-pane", "background", "styles.css"), "var(--pane-glass)");
  assert.equal(property(styles, ".sidebar", "background", "styles.css"), "var(--side-glass)");
});

test("设置侧栏和主界面左侧栏用同一条分界线", () => {
  assert.equal(
    property(settingsCss, ".settings-sidebar", "border-right", "settings.css"),
    property(styles, ".sidebar", "border-right", "styles.css"),
  );
});

test("「返回工作区」的内容盒是完整的 40px，文字才居中", () => {
  const home = declarations(settingsCss, ".settings-sidebar-home", "settings.css");
  const padding = /(?:^|;)\s*padding:\s*([^;}]+)/.exec(home);
  assert.ok(padding, ".settings-sidebar-home 上没有 padding");
  // 上下都不留内边距：留了内容就会被挤到剩下的高度里居中，整行往上偏。
  // 和下面栏目列表的距离改用 margin 让出来。
  assert.equal(padding[1].trim(), "0 10px");
  assert.match(home, /margin-bottom:\s*6px/);
  assert.match(home, /align-items:\s*center/);
});

test("「返回工作区」悬浮时只是变底色，没有额外的样式", () => {
  // 用户的原话：「我不希望有一个奇奇怪怪的样式，居中就好了啊」。所以悬浮态和它
  // 下面那排栏目按钮一致——只换底色和字色，不加投影、不加描边、不加位移。
  const hover = declarations(settingsCss, ".settings-sidebar-home:hover", "settings.css");
  assert.ok(!/box-shadow:/.test(hover), "悬浮态又加回了投影");
  assert.ok(!/border(?:-\w+)?:/.test(hover), "悬浮态不应该多出描边");
  assert.ok(!/transform:/.test(hover), "悬浮态不应该有位移或缩放");
  assert.match(hover, /background:/);
});
