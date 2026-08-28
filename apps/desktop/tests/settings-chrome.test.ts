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
