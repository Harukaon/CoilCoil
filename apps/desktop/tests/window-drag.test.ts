import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  DRAG_BAR_CLASS,
  HOVER_REFRESH_INTERVAL_MS,
  initialHoverRefreshState,
  isDragBarPoint,
  nextHoverRefresh,
  TITLE_BAR_STRIP_PX,
} from "../src/renderer/src/ui/window-drag.ts";

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

test("刚进入拖动带就重算，停在里面按间隔重算，离开后复位", () => {
  const entered = nextHoverRefresh(initialHoverRefreshState, true, 1_000);
  assert.equal(entered.refresh, true);
  assert.deepEqual(entered.state, { inside: true, refreshedAt: 1_000 });

  const stillInside = nextHoverRefresh(entered.state, true, 1_000 + HOVER_REFRESH_INTERVAL_MS - 1);
  assert.equal(stillInside.refresh, false);
  assert.deepEqual(stillInside.state, entered.state);

  const afterInterval = nextHoverRefresh(entered.state, true, 1_000 + HOVER_REFRESH_INTERVAL_MS);
  assert.equal(afterInterval.refresh, true);
  assert.equal(afterInterval.state.refreshedAt, 1_000 + HOVER_REFRESH_INTERVAL_MS);

  const left = nextHoverRefresh(entered.state, false, 1_010);
  assert.equal(left.refresh, false);
  assert.equal(left.state.inside, false);
  // 重新进来必须立刻重算，哪怕离上一次不到一个间隔——按下鼠标就在这一下之后。
  assert.equal(nextHoverRefresh(left.state, true, 1_020).refresh, true);
});

test("压在标题栏上就算数，不管指针命中的是哪个元素", () => {
  // 上一版认的是拖动层元素本身，可它被压在内容底下：右侧栏那条空带、技能/记忆页
  // 标题栏里包标题的那个 div 都盖在它上面，于是那几条标题栏一次都没刷新过。
  assert.equal(isDragBarPoint(true, 900), true, "标题栏不一定在窗口顶上（设置页就是）");
  assert.equal(isDragBarPoint(false, 0), true);
  assert.equal(isDragBarPoint(false, TITLE_BAR_STRIP_PX), true);
  assert.equal(isDragBarPoint(false, TITLE_BAR_STRIP_PX + 1), false, "顶上那条以外不该白刷");
});

test("顶部兜底的那条盖得住最高的一条标题栏", () => {
  // 谁将来加了标题栏却忘了标 .window-drag-bar，靠这条兜底。
  const rows = /grid-template-rows:\s*([\d.]+)px/.exec(declarations(".conversation-pane"));
  assert.ok(rows, ".conversation-pane 的 grid-template-rows 必须以标题栏高度开头");
  assert.ok(TITLE_BAR_STRIP_PX >= Number.parseFloat(rows[1]), "兜底范围比会话标题栏还矮");
});

test("标记类的名字和样式表里的一致", () => {
  assert.match(declarations(`.${DRAG_BAR_CLASS}`), /position:\s*relative/);
});

test("拖动层铺满标题栏，并且排在内容下面", () => {
  const layer = declarations(".window-drag-layer");
  assert.match(layer, /position:\s*absolute/);
  assert.match(layer, /inset:\s*0/);
  // 层要在内容下面，否则它会把标题栏里按钮的点击吃掉。
  assert.match(declarations(".window-drag-layer ~ *"), /z-index:\s*1/);
});

test("哨兵不占任何可见区域", () => {
  // 翻转它只是为了把矩形列表标脏；它要是有面积，就会真的挡住或让出一块窗口。
  assert.equal(pixels(".window-drag-sentinel", "width"), 0);
  assert.equal(pixels(".window-drag-sentinel", "height"), 0);
});

test("宿主标题栏都给拖动层建立了定位上下文", () => {
  for (const selector of [
    ".conversation-header",
    ".inspector-header",
    ".skills-workspace-header",
    ".memory-workspace-header",
    ".sidebar-drag",
  ]) {
    assert.match(declarations(selector), /position:\s*relative/, `${selector} 需要 position: relative`);
  }
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

test("拖动区只由拖动层提供，标题栏元素自己不写 app-region", () => {
  // 以前是「哪里拖不动就给哪个元素补一条 CSS」，补出来的规则彼此不知道对方存在。
  // 现在的约定是：只有 .window-drag 这一个类给 drag，只有交互元素给 no-drag。
  const dragRules = styles
    .split("\n")
    .filter((line) => /-webkit-app-region:\s*drag/.test(line))
    .map((line) => line.slice(0, line.indexOf("{")).trim());
  assert.deepEqual(dragRules, [".window-drag"]);
});
