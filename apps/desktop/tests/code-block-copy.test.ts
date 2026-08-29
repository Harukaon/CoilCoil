import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { codeBlockText } from "../src/renderer/src/features/conversation/CollapsibleCodeBlock.tsx";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const styles = readFileSync(resolve(rendererRoot, "styles.css"), "utf8");
const component = readFileSync(resolve(rendererRoot, "features/conversation/CollapsibleCodeBlock.tsx"), "utf8");

/** styles.css 一条规则写一行，取出选择器后面那对花括号里的声明。 */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, "m").exec(styles);
  assert.ok(match, `styles.css 里找不到 ${selector} 这条规则`);
  return match[1];
}

/** 用一对最小的假节点冒充 <pre>/<code>，这里跑不起真的 DOM。 */
function fakePre(preText: string, codeText?: string): HTMLElement {
  const code = codeText === undefined ? null : { textContent: codeText };
  return { textContent: preText, querySelector: () => code } as unknown as HTMLElement;
}

test("复制按钮钉在代码块右下角，不是右上角", () => {
  // 用户两次强调过位置：右上角会压住第一行代码。以后有人想挪走，先过这一关。
  const rule = declarations(".markdown-code-copy");
  assert.match(rule, /(?:^|;)\s*bottom:\s*\d/, "复制按钮没有 bottom，可能被挪到了顶部");
  assert.match(rule, /(?:^|;)\s*right:\s*\d/, "复制按钮没有 right，可能被挪到了左边");
  assert.doesNotMatch(rule, /(?:^|;)\s*top:/, "复制按钮上出现了 top，位置被挪到了上方");
  assert.doesNotMatch(rule, /(?:^|;)\s*left:/, "复制按钮上出现了 left，位置被挪到了左边");
  assert.match(rule, /(?:^|;)\s*position:\s*absolute/);
});

test("按钮挂在不滚动的那一层上，横向滚动时不会被滚走", () => {
  assert.match(declarations(".markdown-code-surface"), /(?:^|;)\s*position:\s*relative/);
  // 横向滚动的是 <pre>：按钮必须是它的兄弟节点，而不是它的子节点。
  const surface = /<div className="markdown-code-surface">([\s\S]*?)<\/div>/.exec(component);
  assert.ok(surface, "CollapsibleCodeBlock 里找不到 .markdown-code-surface 这一层");
  const [pre, button] = [surface[1].indexOf("</pre>"), surface[1].indexOf("markdown-code-copy")];
  assert.ok(pre >= 0 && button > pre, "复制按钮跑进 <pre> 里面了，会跟着横向滚动一起滚走");
});

test("平时不显形，悬浮代码块才浮现", () => {
  assert.match(declarations(".markdown-code-copy"), /(?:^|;)\s*opacity:\s*0\s*(?:;|$)/);
  assert.ok(
    styles.includes(".markdown-code-surface:hover .markdown-code-copy"),
    "没有悬浮显形的规则，按钮会一直挂在那里",
  );
});

test("复制的是代码原文，不带行号也不带末尾空行", () => {
  // 行号槽若来日挂到 <pre> 上，取 <code> 就能把它挡在外面。
  assert.equal(codeBlockText(fakePre("1 2 3 const a = 1;\n", "const a = 1;\n")), "const a = 1;");
  assert.equal(codeBlockText(fakePre("第一行\n第二行\n")), "第一行\n第二行");
  // 中间的空行是代码的一部分，只砍最后那个换行。
  assert.equal(codeBlockText(fakePre("a\n\nb\n\n")), "a\n\nb\n");
  assert.equal(codeBlockText(null), "");
});
