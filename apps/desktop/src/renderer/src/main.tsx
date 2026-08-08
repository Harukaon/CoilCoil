import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PreviewApp from "./PreviewApp";
import { ToastHost } from "./ui/toast";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

const previewId = new URLSearchParams(window.location.search).get("preview");

createRoot(root).render(
  <StrictMode>
    {previewId ? <PreviewApp id={previewId} /> : <><App /><ToastHost /></>}
  </StrictMode>,
);
