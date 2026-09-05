import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { acceleratorFromKeyPress, formatAccelerator } from "../src/renderer/src/features/settings/shortcutAccelerator.ts";

const press = (overrides: Partial<Parameters<typeof acceleratorFromKeyPress>[0]> & { key: string }) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("command and control collapse into one portable name", () => {
  // Recording on a Mac must still mean something on the user's Windows machine.
  assert.deepEqual(acceleratorFromKeyPress(press({ key: " ", metaKey: true, shiftKey: true })), {
    ok: true,
    accelerator: "CommandOrControl+Shift+Space",
  });
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "k", ctrlKey: true })), {
    ok: true,
    accelerator: "CommandOrControl+K",
  });
});

test("a global shortcut is refused without a modifier", () => {
  // A bare letter would be taken from every other application on the machine.
  const result = acceleratorFromKeyPress(press({ key: "k" }));
  assert.equal(result.ok, false);
});

test("a modifier alone is not a shortcut yet", () => {
  assert.equal(acceleratorFromKeyPress(press({ key: "Shift", shiftKey: true })).ok, false);
  assert.equal(acceleratorFromKeyPress(press({ key: "Meta", metaKey: true })).ok, false);
});

test("named keys use the names Electron knows", () => {
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "ArrowUp", altKey: true })), { ok: true, accelerator: "Alt+Up" });
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "Enter", metaKey: true })), { ok: true, accelerator: "CommandOrControl+Return" });
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "F5", ctrlKey: true })), { ok: true, accelerator: "CommandOrControl+F5" });
  assert.equal(acceleratorFromKeyPress(press({ key: "Unidentified", ctrlKey: true })).ok, false);
});

test("the shortcut is displayed the way each platform writes it", () => {
  assert.equal(formatAccelerator("CommandOrControl+Shift+Space", "darwin"), "⌘⇧Space");
  assert.equal(formatAccelerator("CommandOrControl+Shift+Space", "win32"), "Ctrl+Shift+Space");
  assert.equal(formatAccelerator("Alt+Up", "darwin"), "⌥Up");
});

test("快速提问气泡整条停用了，没有任何地方还能给它抢一个全局快捷键", () => {
  // 用户把 Ctrl+E 设成了呼出这个小弹窗，然后说这个功能不完善、要关掉。关的是整条
  // 入口，不是只解绑那一个键：主进程不再注册全局快捷键，设置里也不再有能设它的栏目。
  // 上面那些用例留着，是因为按键换算这套逻辑本身没坏，功能回来时直接接着用。
  const desktopRoot = resolve(import.meta.dirname, "..");
  const bubble = readFileSync(resolve(desktopRoot, "src/main/bubble-window.ts"), "utf8");
  assert.match(bubble, /const BUBBLE_ENABLED: boolean = false;/, "气泡的停用开关被打开了");
  assert.match(bubble, /if \(!BUBBLE_ENABLED\) return \(\) => undefined;/, "停用开关没有拦在 setupBubbleWindow 最前面");

  const settings = readFileSync(resolve(desktopRoot, "src/renderer/src/features/settings/SettingsDialog.tsx"), "utf8");
  const tabs = /<nav className="settings-tabs"[\s\S]*?<\/nav>/.exec(settings);
  assert.ok(tabs, "找不到设置左侧的栏目列表");
  assert.doesNotMatch(tabs[0], /setSection\("shortcuts"\)/, "设置里又多出了能进「快捷键」页的入口");
});
