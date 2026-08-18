import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BrowserGuestLayer } from "./features/browser/BrowserGuestLayer";
import { ToastHost } from "./ui/toast";
import { UpdateDialog } from "./ui/update/UpdateDialog";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

createRoot(root).render(
  <StrictMode>
    <App />
    {/* Sibling of App, not a child: App early-returns for settings and swaps its
        whole tree for the skills workspace, either of which would destroy every
        agent's page if the guests lived inside it. */}
    <BrowserGuestLayer />
    <ToastHost />
    <UpdateDialog />
  </StrictMode>,
);
