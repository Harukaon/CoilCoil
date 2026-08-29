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
  assert.equal(property(settingsCss, ".settings-screen", "background", "settings.css"), "var(--pane-fill)");
  assert.equal(property(settingsCss, ".settings-sidebar", "background", "settings.css"), "var(--side-fill)");
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

test("悬浮阴影是一层很浅的投影，不额外加描边", () => {
  const hover = declarations(settingsCss, ".settings-sidebar-home:hover", "settings.css");
  const shadow = /box-shadow:\s*([^;}]+)/.exec(hover);
  assert.ok(shadow, "悬浮态上没有 box-shadow");
  // 克制：一层、偏移和模糊都在个位数 px、透明度不到 15%，也不是 inset 描边环。
  const [offsetX, offsetY, blur] = shadow[1].trim().split(/\s+/);
  assert.equal(offsetX, "0");
  assert.ok(Number.parseFloat(offsetY) <= 2, `阴影下移了 ${offsetY}，太重`);
  assert.ok(Number.parseFloat(blur) <= 4, `阴影模糊 ${blur}，太重`);
  assert.ok(!shadow[1].includes(","), "只要一层阴影");
  assert.ok(!shadow[1].includes("inset"), "不要用阴影画描边");
  const alpha = /\/\s*(\d+)%/.exec(shadow[1]);
  assert.ok(alpha && Number.parseInt(alpha[1], 10) <= 15, "阴影太深");
  // 悬浮不加边框，用户不喜欢多余描边。
  assert.ok(!/border(?:-\w+)?:/.test(hover), "悬浮态不应该多出描边");
});
