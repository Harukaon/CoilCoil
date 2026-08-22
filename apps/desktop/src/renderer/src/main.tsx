import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BrowserGuestLayer } from "./features/browser/BrowserGuestLayer";
import { diagnostics, installRendererErrorHandlers } from "./diagnostics";
import { AppErrorBoundary } from "./ui/AppErrorBoundary";
import { initTheme } from "./theme";
import { ToastHost } from "./ui/toast";
import { UpdateDialog } from "./ui/update/UpdateDialog";
import "./styles.css";

installRendererErrorHandlers();
initTheme();
diagnostics.info("process", "renderer_started", { userAgent: navigator.userAgent });

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

createRoot(root).render(
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
    <ToastHost />
    <UpdateDialog />
  </StrictMode>,
);
