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
import { InspectorPane } from "../../src/renderer/src/features/inspector/InspectorPane";
import { ProviderModelCard, type EditableModel } from "../../src/renderer/src/features/settings/ModelSettings";
import { RuntimePanel } from "../../src/renderer/src/features/runtime/RuntimePanel";
import "../../src/renderer/src/features/settings/settings.css";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Cpu, Files, Globe, TerminalSquare } from "lucide-react";
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

/**
 * `?panel=inspector&tabs=N&width=W` draws the right-hand pane on its own.
 *
 * The header there splits a fixed width between the tab strip, a band reserved
 * for dragging the window, and two buttons. Which of the three ends up with the
 * slack is not visible in any test — only in a picture.
 */
const INSPECTOR_TABS = [
  { id: "runtime", label: "运行时", icon: Cpu, closable: true },
  { id: "files", label: "文件", icon: Files, closable: true },
  { id: "browser", label: "浏览器", icon: Globe, closable: true },
  { id: "term-1", label: "term-1 · npm run dev", icon: TerminalSquare, closable: true },
  { id: "term-2", label: "term-2 · wrangler tail", icon: TerminalSquare, closable: true },
];

/** 模型目录：折叠成一行一条，加上那条带搜索框的工具栏。 */
const MODEL_ROWS: EditableModel[] = [
  { uid: "m1", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  { uid: "m2", id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 400000, maxTokens: 131072, reasoning: true, input: ["text", "image"] },
  { uid: "m3", id: "minimax-m3", name: "MiniMax M3", contextWindow: 1000000, maxTokens: 512000, input: ["text"] },
  { uid: "m4", id: "deepseek-v4", contextWindow: 128000, input: ["text"] },
];

function ModelCatalogPreview(): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set(parameters.get("open")?.split(",") ?? []));
  const rows = MODEL_ROWS.map((model, index) => ({ model, index }))
    .filter(({ model }) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="settings-screen" style={{ display: "block" }}><div style={{ padding: 20, width: 760, margin: "0 auto" }}>
      <div className="provider-model-toolbar provider-model-toolbar-top">
        <button className="secondary-button" type="button">拉取上游模型列表</button>
        <label className="provider-model-search">
          <Search size={14} />
          <input value={query} placeholder={`在 ${MODEL_ROWS.length} 个模型里搜索`} aria-label="搜索模型" onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <div className="provider-model-list" style={{ marginTop: 10 }}>
        {rows.map(({ model, index }) => (
          <ProviderModelCard
            key={model.uid}
            model={model}
            index={index}
            apiOptions={[{ value: "", label: "继承服务商协议" }]}
            advanced={{ thinkingLevelMap: "{}", samplingParams: "{}", headers: "{}", compat: "{}", costTiers: "[]" }}
            expanded={open.has(model.uid)}
            onToggle={() => setOpen((current) => { const next = new Set(current); if (next.has(model.uid)) next.delete(model.uid); else next.add(model.uid); return next; })}
            onChange={() => undefined}
            onAdvancedChange={() => undefined}
            onRemove={() => undefined}
          />
        ))}
      </div>
    </div></div>
  );
}

/** 右侧「运行时」面板，用来看没配模型的子 Agent 那一行长什么样。 */
function RuntimePanelPreview(): React.JSX.Element {
  // 分区默认折叠，截图前先把要看的那个点开——和用户点它是同一条路径。
  useEffect(() => {
    const wanted = parameters.get("section");
    if (!wanted) return;
    const timer = setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>("button, summary")]
        .find((node) => node.textContent?.includes(wanted));
      target?.click();
    }, 300);
    return () => clearTimeout(timer);
  }, []);
  const configured = parameters.get("configured") === "1";
  return (
    <div className="inspector-pane" style={{ width: 420, height: "100vh", overflow: "auto" }}>
      <RuntimePanel
        runtimeId="preview"
        tokenUsage={{ input: 12000, output: 3400, cacheRead: 0, cacheWrite: 0, total: 15400, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as never}
        contextUsage={{ used: 15400, total: 400000, percent: 3.85 } as never}
        cwd="/Users/hao/Desktop/feedmob"
        inspection={{
          tools: [],
          mcpServers: [],
          skills: [],
          effectiveSystemPrompt: "",
          estimates: { total: 15400, system: 2000, tools: 1200, messages: 12200 },
          subagent: { models: configured
            ? { explore: "pierce/glm-5.3-flash", worker: "pierce/gpt-5.6-luna", reviewer: "pierce/gpt-5.6-sol" }
            : { explore: "", worker: "", reviewer: "" } },
        } as never}
      />
    </div>
  );
}

const panel = parameters.get("panel");
const root = createRoot(document.getElementById("root")!);
if (panel === "runtime") {
  root.render(<RuntimePanelPreview />);
} else if (panel === "models") {
  root.render(<ModelCatalogPreview />);
} else if (panel === "inspector") {
  const count = Number.parseInt(parameters.get("tabs") ?? "1", 10);
  const width = parameters.get("width") ?? "360";
  root.render(
    <div className="app-shell" style={{ display: "grid", gridTemplateColumns: `1fr ${width}px`, gridTemplateRows: "100%", height: "100vh" }}>
      <div />
      <InspectorPane
        tabs={INSPECTOR_TABS.slice(0, Math.max(1, count))}
        activeTab={INSPECTOR_TABS[0].id}
        onSelectTab={() => undefined}
        onCloseTab={() => undefined}
        addOptions={[{ id: "files", label: "文件", icon: Files }]}
        onAddTab={() => undefined}
        onClose={() => undefined}
        emptyState={<p>没有面板</p>}
      >
        <div style={{ padding: 16, font: "12px/1.6 system-ui" }}>面板内容</div>
      </InspectorPane>
    </div>,
  );
} else {
  root.render(
    <div className="app-shell left-collapsed" style={{ display: "grid", gridTemplateColumns: "0 1fr", gridTemplateRows: "100%", height: "100vh" }}>
      <MemoryWorkspace leftOpen={false} onOpenLeft={() => undefined} onClose={() => undefined} />
    </div>,
  );
}
