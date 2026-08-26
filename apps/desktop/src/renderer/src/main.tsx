import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BubbleApp } from "./BubbleApp";
import { BrowserGuestLayer } from "./features/browser/BrowserGuestLayer";
import { diagnostics, installRendererErrorHandlers } from "./diagnostics";
import { AppErrorBoundary } from "./ui/AppErrorBoundary";
import { WindowControls } from "./ui/WindowControls";
import { initTheme } from "./theme";
import { ToastHost } from "./ui/toast";
import { UpdateDialog } from "./ui/update/UpdateDialog";
import "./styles.css";

installRendererErrorHandlers();
initTheme();
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
