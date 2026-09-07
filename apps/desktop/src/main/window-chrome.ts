import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";
import type { DesktopPlatform } from "../shared/desktop-api";

/**
 * The window chrome each platform gets.
 *
 * macOS already hid its title bar and kept the traffic lights; Windows and Linux
 * were handed an empty object, so they got the full native stack — a title bar
 * and, below it, Electron's default menu bar — sitting above an application that
 * draws its own header. Two borrowed bars above a designed one.
 *
 * `hidden` with no overlay leaves a frameless window with no system buttons at
 * all, which is what lets the app draw its own to match its chrome. macOS keeps
 * its traffic lights, which sit outside the page and already look native.
 *
 * Type-only imports keep this loadable outside Electron, which is what lets it
 * be tested at all.
 */
export function windowChromeOptions(platform: DesktopPlatform): BrowserWindowConstructorOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      hasShadow: true,
      // 见 windowBlursBackdrop 的注释。
      vibrancy: "under-window",
    };
  }
  return {
    // No `titleBarOverlay`: the system buttons are declined outright so the app
    // can draw its own, which is what `WindowControls` does. See its comment for
    // what that costs.
    titleBarStyle: "hidden",
    // Windows 的等价物；见 windowBlursBackdrop。Linux 上没有对应的东西，
    // 那边的窗口底色仍然是实心的。
    ...(platform === "win32" ? { backgroundMaterial: "acrylic" as const } : {}),
    // Belt and braces with `hidden`, which already leaves the bar nowhere to
    // render: without a menu bar, Alt must not be able to summon one.
    autoHideMenuBar: true,
  };
}

/**
 * 这个平台会不会自己在窗口背后画高斯模糊。
 *
 * macOS 用 vibrancy、Windows 用 acrylic，两者都是系统画的：窗口自己只要留出
 * 一点透明度，模糊就从那一点透出来（渲染进程那边是 `--window-tint`）。反过来
 * 说，窗口底色只要是实心的就把它整个盖住，所以这两个平台的底色要跟着留同样的
 * 透明度，否则模糊等于没开。
 *
 * Linux 有没有模糊取决于合成器，问不出来，所以一律当作没有：在那边留一块半透明
 * 的窗口只会直接看见桌面本身，比不透还糟。
 */
export function windowBlursBackdrop(platform: DesktopPlatform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** 窗口底色。会画模糊的平台上留出 `--window-tint` 那 10%，让模糊透上来。 */
export function windowBackgroundColor(color: string, platform: DesktopPlatform): string {
  if (!windowBlursBackdrop(platform)) return color;
  const solid = /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
  return solid ? `${solid}e6` : color;
}

/**
 * The application menu, which exists for its accelerators rather than its bar.
 *
 * `setApplicationMenu(null)` is the obvious way to drop the menu bar and takes
 * every accelerator with it: these roles are what bind Ctrl/Cmd+C, V, X, A and Z.
 * macOS additionally needs an app menu for Cmd+Q and Cmd+W to exist at all. So
 * the menu stays everywhere and the bar is hidden instead — on Windows and Linux
 * by `autoHideMenuBar` plus a hidden title bar, which together leave it nothing
 * to draw into.
 */
export function applicationMenuTemplate(platform: DesktopPlatform): MenuItemConstructorOptions[] {
  return platform === "darwin"
    ? [{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]
    : [{ role: "editMenu" }, { role: "viewMenu" }];
}
