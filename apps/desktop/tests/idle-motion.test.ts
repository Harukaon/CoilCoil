import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { installIdleMotionPause, motionStateFor } from "../src/renderer/src/ui/idle-motion.ts";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const styles = readFileSync(resolve(rendererRoot, "styles.css"), "utf8");

test("看不见、或者用户在别的 App 里，装饰动画就该停", () => {
  assert.equal(motionStateFor({ hidden: false, focused: true }), "running");
  // 窗口还露着，但用户在别处干活——这一段占的时间最长，正是要省的。
  assert.equal(motionStateFor({ hidden: false, focused: false }), "paused");
  assert.equal(motionStateFor({ hidden: true, focused: true }), "paused");
  assert.equal(motionStateFor({ hidden: true, focused: false }), "paused");
});

/** 一份够 installIdleMotionPause 跑起来的最小 DOM，可选带上主进程的焦点桥。 */
function fakeDocument(withFocusBridge = false): {
  target: Document;
  root: { dataset: Record<string, string | undefined> };
  fire: () => void;
  setFocused: (focused: boolean) => void;
  listeners: number;
  focusListeners: number;
} {
  const dataset: Record<string, string | undefined> = {};
  const handlers = new Set<() => void>();
  const focusHandlers = new Set<(focused: boolean) => void>();
  const defaultView = withFocusBridge
    ? {
        coilcoil: {
          onWindowFocusChange: (listener: (focused: boolean) => void) => {
            focusHandlers.add(listener);
            return () => focusHandlers.delete(listener);
          },
        },
      }
    : undefined;
  const target = {
    hidden: false,
    defaultView,
    documentElement: { dataset },
    addEventListener: (type: string, handler: () => void) => {
      if (type === "visibilitychange") handlers.add(handler);
    },
    removeEventListener: (type: string, handler: () => void) => {
      if (type === "visibilitychange") handlers.delete(handler);
    },
  };
  return {
    target: target as unknown as Document,
    root: { dataset },
    fire: () => handlers.forEach((handler) => handler()),
    setFocused: (focused: boolean) => focusHandlers.forEach((handler) => handler(focused)),
    get listeners() {
      return handlers.size;
    },
    get focusListeners() {
      return focusHandlers.size;
    },
  };
}

test("data-motion 跟着可见性走，卸载后不留下停住的状态", () => {
  const dom = fakeDocument();
  const stop = installIdleMotionPause(dom.target);
  assert.equal(dom.root.dataset.motion, "running");

  (dom.target as unknown as { hidden: boolean }).hidden = true;
  dom.fire();
  assert.equal(dom.root.dataset.motion, "paused");

  (dom.target as unknown as { hidden: boolean }).hidden = false;
  dom.fire();
  assert.equal(dom.root.dataset.motion, "running");

  stop();
  assert.equal(dom.listeners, 0);
  // 留着 paused 会让下一次挂载前的这段时间里动画停着不动。
  assert.equal(dom.root.dataset.motion, undefined);
});

test("拿不到窗口焦点桥时退化成只看可见性，而不是一直停着", () => {
  // 手机远程端的桥是另一份实现，未必有 onWindowFocusChange。
  const dom = fakeDocument();
  const stop = installIdleMotionPause(dom.target);
  assert.equal(dom.root.dataset.motion, "running", "没有焦点信号时不该默认当作失焦");
  stop();
});

test("窗口露着但用户去了别的 App，一样停；卸载时把焦点订阅也退掉", () => {
  const dom = fakeDocument(true);
  const stop = installIdleMotionPause(dom.target);
  assert.equal(dom.root.dataset.motion, "running");
  assert.equal(dom.focusListeners, 1);

  // hidden 始终是 false：这一段正是 document.hidden 覆盖不到、却最费电的场景。
  dom.setFocused(false);
  assert.equal(dom.root.dataset.motion, "paused");
  dom.setFocused(true);
  assert.equal(dom.root.dataset.motion, "running");

  stop();
  assert.equal(dom.focusListeners, 0);
});

test("暂停用的是 play-state，而且真的挂在墨团标志上", () => {
  const rule = /^:root\[data-motion="paused"\][^{]*\{([^}]*)\}/m.exec(styles);
  assert.ok(rule, "styles.css 里找不到 data-motion=paused 这条规则");
  // animation: none 会让切回来时跳一帧，进度得留着。
  assert.match(rule[1], /animation-play-state:\s*paused/);
  assert.doesNotMatch(rule[1], /animation:\s*none/);
  assert.match(rule[0], /\.coil-logo-mask/);
});
