import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { appIconFilename, appIconPath, DARK_APP_ICON, LIGHT_APP_ICON } from "../src/main/app-icon.ts";

const desktopRoot = resolve(import.meta.dirname, "..");

function pngDimensions(path: string): { width: number; height: number; colorType: number } {
  const data = readFileSync(path);
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colorType: data[25],
  };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("application icons select the supplied artwork for each system tone", () => {
  assert.equal(appIconFilename(false), LIGHT_APP_ICON);
  assert.equal(appIconFilename(true), DARK_APP_ICON);
  assert.equal(
    appIconPath({ dark: false, packaged: true, resourcesPath: "/app/resources", mainDirectory: "/app/out/main" }),
    join("/app/resources", "icons", LIGHT_APP_ICON),
  );
  assert.equal(
    appIconPath({ dark: true, packaged: false, resourcesPath: "/app/resources", mainDirectory: "/app/out/main" }),
    join("/app/out/main", "../../build", DARK_APP_ICON),
  );
});

test("packaged application icon assets are square RGBA images and the two tones differ", () => {
  const defaultIcon = join(desktopRoot, "build/icon.png");
  const lightIcon = join(desktopRoot, `build/${LIGHT_APP_ICON}`);
  const darkIcon = join(desktopRoot, `build/${DARK_APP_ICON}`);
  for (const path of [defaultIcon, lightIcon, darkIcon]) {
    assert.deepEqual(pngDimensions(path), { width: 1024, height: 1024, colorType: 6 });
  }
  assert.equal(digest(defaultIcon), digest(lightIcon), "the installer icon should use the light-tone artwork by default");
  assert.notEqual(digest(lightIcon), digest(darkIcon));
});

test("侧栏左下角那枚标志挂的就是 Dock 那张图标", () => {
  // 用户要求左下角和 Dock 栏里是同一个图标，所以那里不再画墨团，改成贴应用图标本身。
  // 界面上只有 26px，挂 1024px 的原图既费带宽（手机遥控也要下载）又没意义，所以
  // assets/ 下放的是缩到 128px 的副本——应用图标以后要是换了，这两张得跟着重新导出。
  const light = join(desktopRoot, "src/renderer/src/assets/app-icon-light.png");
  const dark = join(desktopRoot, "src/renderer/src/assets/app-icon-dark.png");
  for (const path of [light, dark]) {
    assert.deepEqual(pngDimensions(path), { width: 128, height: 128, colorType: 6 });
  }
  assert.notEqual(digest(light), digest(dark), "明暗两张成了同一张，暗色下会看不清");

  const sidebar = readFileSync(join(desktopRoot, "src/renderer/src/features/workspaces/WorkspaceSidebar.tsx"), "utf8");
  const footer = /<div className="sidebar-footer">([\s\S]*?)<div className="brand-copy">/.exec(sidebar);
  assert.ok(footer, "找不到侧栏底部那一块");
  assert.match(footer[1], /className="brand-icon"/);
  assert.doesNotMatch(footer[1], /CoilLogo/, "左下角又被换回墨团标志了");

  // 静态背景图，别再给它加滤镜或者动画——#37 就是为了把这枚 26px 图标的每帧滤镜账单去掉。
  const styles = readFileSync(join(desktopRoot, "src/renderer/src/styles.css"), "utf8");
  const rules = styles.split("\n").filter((line) => line.includes(".brand-icon"));
  assert.ok(rules.length >= 2, "styles.css 里找不到 .brand-icon 的明暗两条规则");
  for (const rule of rules) {
    assert.doesNotMatch(rule, /animation|filter:/, `.brand-icon 上又出现了每帧要算的东西：${rule}`);
  }
  assert.ok(rules.some((rule) => rule.includes("app-icon-light.png")));
  assert.ok(rules.some((rule) => rule.includes("app-icon-dark.png")));
});
