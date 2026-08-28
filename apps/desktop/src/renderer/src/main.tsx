import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BubbleApp } from "./BubbleApp";
import { BrowserGuestLayer } from "./features/browser/BrowserGuestLayer";
import { diagnostics, installRendererErrorHandlers } from "./diagnostics";
import { AppErrorBoundary } from "./ui/AppErrorBoundary";
import { WindowControls } from "./ui/WindowControls";
import { installWindowDragRegions } from "./ui/window-drag";
import { initTheme } from "./theme";
import { ToastHost } from "./ui/toast";
import { UpdateDialog } from "./ui/update/UpdateDialog";
import "./styles.css";
import "./mobile.css";
import "./features/composer/mobile-model-picker.css";

/**
 * Mark the browser-side client and turn off Safari's automatic zoom.
 *
 * Tapping a field makes iOS scale the whole page up and leave it there, which
 * on a remote-control screen is disorienting rather than helpful. Doing it in
 * the viewport declaration keeps the app's own type sizes untouched, and only
 * the remote client is affected — the desktop window never runs this.
 */
if (window.coilcoil?.isRemote) {
  document.documentElement.dataset.client = "remote";
  const viewport = document.querySelector<HTMLMetaElement>("meta[name=viewport]");
  if (viewport) {
    viewport.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  }
}

installRendererErrorHandlers();
initTheme();
// 手机远程端没有窗口可拖，别白挂一个 pointermove 监听。
if (!window.coilcoil?.isRemote) installWindowDragRegions();
diagnostics.info("process", "renderer_started", { userAgent: navigator.userAgent });

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

// The bubble is this same bundle loaded with #bubble: one renderer to build, and
// the workspace's reducers and styles come along unchanged.
const isBubble = window.location.hash === "#bubble";
if (isBubble) document.documentElement.classList.add("bubble");

createRoot(root).render(isBubble ? (
  <StrictMode>
    <AppErrorBoundary>
      <BubbleApp />
    </AppErrorBoundary>
    <ToastHost />
  </StrictMode>
) : (
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
    {/* Sibling of App, not a child: App early-returns for settings and swaps its
        whole tree for the skills workspace, either of which would destroy every
        agent's page if the guests lived inside it. */}
    {/* Outside the boundary: these are what a crashed App is reported through,
        so they have to survive it. */}
    <BrowserGuestLayer />
    <WindowControls />
    <ToastHost />
    <UpdateDialog />
  </StrictMode>
));
