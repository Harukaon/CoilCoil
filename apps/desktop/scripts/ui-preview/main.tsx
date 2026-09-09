/**
 * A page that renders one CoilCoil panel on its own, so it can be looked at.
 *
 * The memory nebula shipped once without ever having been rendered: its unit
 * tests checked the layout arithmetic, which was right, while the cards the
 * arithmetic was placing were four times the size it assumed. Nothing but a
 * picture catches that, and a picture needs somewhere to draw.
 *
 * Built by `npm run preview:ui`, screenshotted with headless Chrome.
 */
import { createRoot } from "react-dom/client";
import { MemoryWorkspace } from "../../src/renderer/src/features/memory/MemoryWorkspace";
import { initTheme } from "../../src/renderer/src/theme";
import fixture from "./memory-fixture.json";
import "../../src/renderer/src/styles.css";

const parameters = new URLSearchParams(location.search);

// The panel and the theme reach for a scattering of bridge methods. A proxy
// answers all of them with a no-op so the preview cannot die on one it does not
// know about, while the calls that decide what is drawn are implemented for real.
const implemented: Record<string, unknown> = {
  platform: "darwin",
  request: async (command: { type: string }) => {
    if (command.type === "get_memory_configuration") return fixture;
    throw new Error(`预览环境没有实现：${command.type}`);
  },
  onRuntimeEvent: () => () => undefined,
};
(window as unknown as { coilcoil: unknown }).coilcoil = new Proxy(implemented, {
  get: (base, key: string) => key in base ? base[key] : async () => undefined,
});

initTheme();
document.documentElement.dataset.platform = "darwin";
if (parameters.get("theme") === "dark") document.documentElement.dataset.theme = "dark";

// A blank screenshot explains nothing, so anything that throws is painted.
const showFailure = (what: string, error: unknown): void => {
  const box = document.createElement("pre");
  box.style.cssText = "padding:16px;font:12px/1.5 monospace;color:#b00;white-space:pre-wrap";
  box.textContent = `${what}\n${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`;
  document.body.appendChild(box);
};
window.addEventListener("error", (event) => showFailure("window error", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => showFailure("unhandled rejection", event.reason));

/**
 * `?measure=1` prints the geometry of the pieces that matter.
 *
 * Screenshots show that something is wrong; measurements say which box is the
 * wrong size. Guessing between the two is how the first version shipped.
 */
// `?expand=feedmob,Home` (or `all`) opens projects the way a click would, so a
// screenshot can show the state that actually stresses the layout.
if (parameters.get("expand")) {
  setTimeout(() => {
    const wanted = parameters.get("expand")!.split(",");
    if (wanted.includes("all")) {
      // Use the real control rather than clicking nine cards: that is what a
      // person does, and the two take different code paths.
      const button = [...document.querySelectorAll<HTMLElement>(".memory-nebula-tools button")]
        .find((candidate) => candidate.textContent?.includes("全部展开"));
      button?.click();
      // Then ask React Flow's own fit control, to tell a timing bug in our
      // effect apart from the library refusing to frame this much content.
      if (parameters.get("thenFit")) {
        setTimeout(() => {
          const controls = [...document.querySelectorAll<HTMLElement>(".react-flow__controls-button")];
          controls.at(-1)?.click();
        }, 900);
      }
      return;
    }
    const cards = [...document.querySelectorAll<HTMLElement>(".memory-node.project")];
    for (const card of cards) {
      const name = card.querySelector(".memory-node-label")?.textContent ?? "";
      if (wanted.includes("all") || wanted.includes(name)) card.click();
    }
  }, 400);
}

if (parameters.get("trace")) {
  const seen: string[] = [];
  setInterval(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    const count = document.querySelectorAll(".react-flow__node").length;
    const transform = `nodes=${count} ${viewport?.style.transform ?? "none"}`;
    if (seen.at(-1) !== transform) seen.push(transform);
    const box = document.getElementById("trace") ?? Object.assign(document.createElement("pre"), { id: "trace" });
    box.textContent = seen.map((line, index) => `${index}: ${line}`).join("\n");
    document.body.appendChild(box);
  }, 120);
}

if (parameters.get("measure")) {
  setTimeout(() => {
    const rows: string[] = [];
    for (const selector of [
      ".memory-workspace", ".memory-workspace-content", ".memory-controls",
      ".memory-stage", ".memory-nebula", ".memory-nebula-viewport",
      ".memory-nebula-canvas", ".memory-inspector",
      ".memory-node.global", ".memory-node.project", ".memory-node.entry",
    ]) {
      const element = document.querySelector(selector);
      if (!element) { rows.push(`${selector}: 不存在`); continue; }
      const box = element.getBoundingClientRect();
      rows.push(`${selector}: ${Math.round(box.width)}x${Math.round(box.height)} @${Math.round(box.left)},${Math.round(box.top)}`);
    }
    const nodes = [...document.querySelectorAll<HTMLElement>(".memory-node")];
    rows.push(`节点数 ${nodes.length}`);
    // Overlap is the thing the arithmetic cannot see.
    let collisions = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i].getBoundingClientRect();
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j].getBoundingClientRect();
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) collisions++;
      }
    }
    rows.push(`重叠的节点对 ${collisions}`);
    // Naming them is the difference between knowing there is a bug and knowing
    // where it is; the count alone sent me looking in the wrong function twice.
    const named: string[] = [];
    for (let i = 0; i < nodes.length && named.length < 12; i++) {
      const a = nodes[i].getBoundingClientRect();
      for (let j = i + 1; j < nodes.length && named.length < 12; j++) {
        const b = nodes[j].getBoundingClientRect();
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
          const name = (element: HTMLElement) =>
            `${element.className.replace("memory-node ", "")}:${element.querySelector(".memory-node-label")?.textContent}`;
          named.push(`${name(nodes[i])} × ${name(nodes[j])}`);
        }
      }
    }
    rows.push(...named);
    const box = document.createElement("pre");
    box.id = "measure";
    box.textContent = rows.join("\n");
    document.body.appendChild(box);
  }, 1600);
}

createRoot(document.getElementById("root")!).render(
  <div className="app-shell left-collapsed" style={{ display: "grid", gridTemplateColumns: "0 1fr", gridTemplateRows: "100%", height: "100vh" }}>
    <MemoryWorkspace leftOpen={false} onOpenLeft={() => undefined} onClose={() => undefined} />
  </div>,
);
