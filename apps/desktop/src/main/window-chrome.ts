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
    };
  }
  return {
    // No `titleBarOverlay`: the system buttons are declined outright so the app
    // can draw its own, which is what `WindowControls` does. See its comment for
    // what that costs.
    titleBarStyle: "hidden",
    // Belt and braces with `hidden`, which already leaves the bar nowhere to
    // render: without a menu bar, Alt must not be able to summon one.
    autoHideMenuBar: true,
  };
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
