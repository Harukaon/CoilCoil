import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_MONO_FONT,
  DEFAULT_SURFACE_STYLE,
  DEFAULT_UI_FONT,
  monoFontStack,
  MONO_FONTS,
  resolveMonoFont,
  resolveUiFont,
  SURFACE_STYLES,
  uiFontStack,
  UI_FONTS,
} from "../src/renderer/src/theme.ts";

test("new installations default to the layered surface style", () => {
  assert.equal(DEFAULT_SURFACE_STYLE, "layered");
  assert.deepEqual(SURFACE_STYLES.map((style) => style.id), ["flat", "layered"]);
});

test("认不出来的字体设置回落到默认那一档", () => {
  assert.equal(resolveUiFont("serif"), "serif");
  assert.equal(resolveMonoFont("menlo"), "menlo");
  // 存过的旧值、手改坏的值、没存过：都回到默认，不要留下一个空的 font-family。
  assert.equal(resolveUiFont(null), DEFAULT_UI_FONT);
  assert.equal(resolveUiFont("sf-mono"), DEFAULT_UI_FONT);
  assert.equal(resolveMonoFont(undefined), DEFAULT_MONO_FONT);
  assert.equal(resolveMonoFont("helvetica"), DEFAULT_MONO_FONT);
});

test("每一档字体都有完整的兜底链，中文都兜得住", () => {
  for (const font of UI_FONTS) {
    const families = font.stack.split(",").map((name) => name.trim());
    // 中文兜底：衬线那一档走宋体，其余走苹方。
    assert.ok(
      families.includes('"PingFang SC"') || families.includes('"Songti SC"'),
      `${font.id} 的字体栈里没有中文兜底`,
    );
    // 最后一环必须是通用族，前面全都没装时才有得可退。
    assert.ok(["sans-serif", "serif", "monospace"].includes(families[families.length - 1]), `${font.id} 的字体栈没有以通用族结尾`);
    // 系统自带的字体才允许出现在这里：不打包也不下载任何字体文件。
    assert.ok(!/url\(|@font-face/.test(font.stack), `${font.id} 不能引用字体文件`);
  }
  for (const font of MONO_FONTS) {
    const families = font.stack.split(",").map((name) => name.trim());
    assert.ok(families.includes('"PingFang SC"'), `${font.id} 的字体栈里没有中文兜底`);
    assert.equal(families[families.length - 1], "monospace");
  }
});

test("字体栈只有一份，取哪一档都能取到", () => {
  assert.equal(uiFontStack("serif"), UI_FONTS.find((font) => font.id === "serif")?.stack);
  assert.equal(monoFontStack(DEFAULT_MONO_FONT), MONO_FONTS[0].stack);
});

test("界面字体的默认档与 styles.css 里的兜底一致", () => {
  // JS 跑起来之前先按 CSS 的兜底渲染，两边不一致就会开屏闪一下字体。
  const styles = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/styles.css"), "utf8");
  const match = /font-family: var\(--font-ui, ([^)]+)\);/.exec(styles);
  assert.ok(match, "styles.css 里没有 var(--font-ui, …) 这条兜底");
  assert.equal(match[1].trim(), uiFontStack(DEFAULT_UI_FONT));
});
