import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/*
 * 全局视觉约定的防回归。用户反复提过两件事：不要多余的描边，浮层要靠投影分层。
 * 这里盯住的是「浮起来的那一层」——下拉、菜单、tooltip、toast、对话框、输入框——
 * 不是页面里的普通卡片。
 */

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const read = (file: string): string => readFileSync(resolve(rendererRoot, file), "utf8");

const styles = read("styles.css");
const dialogCss = read("ui/dialog/dialog.css");
const toastCss = read("ui/toast/toast.css");
const settingsCss = read("features/settings/settings.css");
const bubbleCss = read("bubble.css");

/** 取出某条规则花括号里的声明。规则有单行写法也有多行写法，都按块匹配。 */
function declarations(css: string, selector: string, label: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  assert.ok(match, `${label} 里找不到 ${selector} 这条规则`);
  return match[1];
}

/** 浮层清单：选择器 → 它所在的样式表。加了新的浮层就往这里补一行。 */
const OVERLAYS: [string, string, string][] = [
  [".coil-select-popover", styles, "styles.css"],
  [".conversation-context-menu", styles, "styles.css"],
  [".archive-dialog", styles, "styles.css"],
  [".prompt-anchor-card", styles, "styles.css"],
  [".subagent-dialog", styles, "styles.css"],
  [".model-popover", styles, "styles.css"],
  [".path-popover, .context-popover", styles, "styles.css"],
  [".performance-popover", styles, "styles.css"],
  [".performance-tooltip", styles, "styles.css"],
  [".inspector-add-popover", styles, "styles.css"],
  [".browser-identity-popover", styles, "styles.css"],
  [".coil-tooltip", styles, "styles.css"],
  [".composer", styles, "styles.css"],
  [".composer-activity", styles, "styles.css"],
  [".scroll-to-bottom", styles, "styles.css"],
  [".coil-modal", dialogCss, "dialog.css"],
  [".toast-item", toastCss, "toast.css"],
  [".mcp-json-dialog", settingsCss, "settings.css"],
  [".upstream-model-picker", settingsCss, "settings.css"],
  [".bubble-shell", bubbleCss, "bubble.css"],
];

test("浮层和输入框都不描边", () => {
  for (const [selector, css, label] of OVERLAYS) {
    const block = declarations(css, selector, label);
    // 允许写 `border: 0`（明确声明不要边框），别的 border 声明都不行：
    // 一条线画上去，浮层就又变回「有框的盒子」了。
    for (const [, declaration] of block.matchAll(/(?:^|;|\n)\s*(border(?:-\w+)*:\s*[^;}]+)/g)) {
      const value = declaration.slice(declaration.indexOf(":") + 1).trim();
      const isRadius = declaration.startsWith("border-radius");
      assert.ok(isRadius || value === "0" || value === "none", `${selector} 上多了描边：${declaration.trim()}`);
    }
  }
});

test("浮层的投影统一走 --shadow-* 令牌", () => {
  // 散着写具体数值，下次「阴影调小一点」又得满地找。
  for (const [selector, css, label] of OVERLAYS) {
    if (selector === ".composer" || selector === ".composer-activity" || selector === ".bubble-shell") continue; // 这三层不是浮层阶梯里的
    const block = declarations(css, selector, label);
    const shadow = /box-shadow:\s*([^;}]+)/.exec(block);
    assert.ok(shadow, `${selector}（${label}）上没有 box-shadow，浮层不描边就只能靠投影分层`);
    assert.match(shadow[1].trim(), /^var\(--shadow-(xs|sm|md|lg|xl)\)$/, `${selector} 的投影没走令牌`);
  }
});

test("--shadow-* 这一档阶梯是从浅到深、都很克制的一层投影", () => {
  const root = declarations(styles, ":root", "styles.css");
  const blurs = ["xs", "sm", "md", "lg", "xl"].map((step) => {
    const match = new RegExp(`--shadow-${step}:\\s*([^;]+)`).exec(root);
    assert.ok(match, `styles.css 的 :root 里没有 --shadow-${step}`);
    assert.ok(!match[1].includes("inset"), `--shadow-${step} 不要用阴影画描边`);
    const parts = match[1].trim().split(/\s+/);
    assert.equal(parts[0], "0", `--shadow-${step} 不要横向偏移`);
    return Number.parseFloat(parts[2]);
  });
  for (let i = 1; i < blurs.length; i += 1) {
    assert.ok(blurs[i] > blurs[i - 1], "阴影阶梯要一档比一档明显，不能拉平");
  }
  assert.ok(blurs[blurs.length - 1] <= 48, "最深的一档也别超过 48px 模糊，否则整屏发脏");
});
