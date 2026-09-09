import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, FileText, Folder, Globe2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryDocumentSnapshot } from "@coilcoil/runtime-protocol";
import { buildMemoryNebula, groupMemoryProjects, type NebulaNode } from "./nebulaLayout";
import "@xyflow/react/dist/style.css";

/**
 * The memory store drawn as a map you can move around in.
 *
 * The canvas itself is React Flow's: panning, wheel zoom, fit-to-view, the
 * minimap and the zoom controls all come from the library. An earlier version
 * hand-rolled every one of those and shipped a bug in most of them. What stays
 * here is only what is specific to CoilCoil — what a card says, and what
 * clicking one opens.
 *
 * Projects start closed. This store holds sixty-five memories across nine
 * projects, and drawing all of them at once is unreadable at any zoom the
 * screen can offer; closed, the map is ten cards you can take in at a glance.
 */

type NebulaNodeData = NebulaNode & { selected: boolean; [key: string]: unknown };

function MemoryCard({ data }: NodeProps<Node<NebulaNodeData>>): React.JSX.Element {
  const node = data;
  return (
    <div className={`memory-node ${node.kind}${node.selected ? " selected" : ""}${node.exists ? "" : " empty"}`}>
      {/* Edges need somewhere to attach. Both handles sit at the card's centre
          and are invisible, so a line runs centre to centre whatever bearing
          the card happens to be on — without them React Flow draws no edges at
          all, which is how the first React Flow pass lost every link. */}
      <Handle type="target" position={Position.Top} className="memory-node-handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="memory-node-handle" isConnectable={false} />
      <span className="memory-node-icon">
        {node.kind === "global" ? <Globe2 size={15} />
          : node.kind === "project" ? <Folder size={14} />
          : <FileText size={11} />}
      </span>
      <span className="memory-node-text">
        <span className="memory-node-label">{node.label}</span>
        {node.kind === "entry" ? null : (
          <span className="memory-node-meta">
            {node.kind === "global"
              ? `${node.chars.toLocaleString()} 字`
              : node.childCount
                ? `${node.childCount} 条记忆`
                : node.exists ? "只有索引" : "还没有内容"}
          </span>
        )}
      </span>
      {node.kind === "project" && node.childCount ? (
        <ChevronDown className={`memory-node-caret${node.expanded ? " open" : ""}`} size={13} />
      ) : null}
    </div>
  );
}

const NODE_TYPES = { memory: MemoryCard };

/**
 * Run a framing call now and once more shortly after.
 *
 * React Flow measures nodes across a couple of frames, and a fit issued in the
 * same tick as the state change frames the previous set — the map stayed put
 * while sixty-five new cards appeared off-screen. The library's own fit button
 * always worked because a person clicks it later; the second call is that
 * delay, made deliberate.
 */
function frameTwice(run: () => void): () => void {
  const frame = requestAnimationFrame(run);
  const timers = [setTimeout(run, 160), setTimeout(run, 460)];
  return () => { cancelAnimationFrame(frame); for (const timer of timers) clearTimeout(timer); };
}

function NebulaCanvas({
  global,
  documents,
  selectedPath,
  onSelect,
}: {
  global?: MemoryDocumentSnapshot;
  documents: readonly MemoryDocumentSnapshot[];
  selectedPath?: string;
  onSelect: (node: NebulaNode) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // State, not refs: a ref written in an event handler is invisible to the
  // effect that runs from the same update, and the framing silently never ran.
  const [framing, setFraming] = useState<{ token: number; target: "all" | string }>();
  const shellRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  // Held in a ref and kept out of the effect's dependencies: these helpers are
  // not stable between renders, and listing them re-ran the effect on every
  // render, whose cleanup cancelled the framing timers before they could fire.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const layout = useMemo(() => buildMemoryNebula(global, documents, expanded), [documents, expanded, global]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const projectNames = useMemo(
    () => groupMemoryProjects(documents).filter((group) => group.entries.length).map((group) => group.name),
    [documents],
  );

  const nodes = useMemo((): Node<NebulaNodeData>[] => layout.nodes.map((node) => ({
    id: node.id,
    type: "memory",
    // React Flow positions from a node's top-left; the layout thinks in centres.
    position: { x: node.x - node.width / 2, y: node.y - node.height / 2 },
    width: node.width,
    height: node.height,
    draggable: false,
    data: { ...node, selected: Boolean(node.filePath) && node.filePath === selectedPath },
  })), [layout, selectedPath]);

  const edges = useMemo((): Edge[] => layout.links.map((link) => ({
    id: `${link.from}->${link.to}`,
    source: link.from,
    target: link.to,
    type: "straight",
    className: link.to.includes("/") ? "to-block" : undefined,
  })), [layout]);

  // Fit for the store, not for every expansion: refitting each time a project
  // opened shrank the map, and the memories you had just asked to read with it.
  /**
   * Frame a project together with the memories it has just opened.
   *
   * This waits for the layout, rather than running from the click: the click
   * only asks for the state change, and the child nodes it needs to frame do
   * not exist until the next render. Fitting from the click handler framed the
   * card on its own and left the whole block below the viewport.
   */
  /**
   * Frame a region of the map, computed rather than negotiated.
   *
   * Every heuristic offered for this — fitView, fitView with a node list,
   * fitBounds — behaved differently depending on when it was called relative to
   * React Flow's own measurement, and two of them silently did nothing. The
   * arithmetic is four lines and the library only has to apply the result.
   */
  const frameBounds = useCallback((nodes: readonly NebulaNode[], maxZoom: number): void => {
    const shell = shellRef.current;
    if (!shell || !nodes.length) return;
    const left = Math.min(...nodes.map((node) => node.x - node.width / 2));
    const right = Math.max(...nodes.map((node) => node.x + node.width / 2));
    const top = Math.min(...nodes.map((node) => node.y - node.height / 2));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height / 2));
    const padding = 56;
    const width = Math.max(1, shell.clientWidth - padding * 2);
    const height = Math.max(1, shell.clientHeight - padding * 2);
    const zoom = Math.max(0.08, Math.min(maxZoom, width / (right - left), height / (bottom - top)));
    flowRef.current.setViewport({
      x: shell.clientWidth / 2 - ((left + right) / 2) * zoom,
      y: shell.clientHeight / 2 - ((top + bottom) / 2) * zoom,
      zoom,
    });
  }, []);

  useEffect(() => {
    return frameTwice(() => frameBounds(layoutRef.current.nodes, 1));
  }, [documents, global, frameBounds]);


  useEffect(() => {
    if (!framing) return undefined;
    if (framing.target === "all") return frameTwice(() => frameBounds(layout.nodes, 1));
    const subtree = layout.nodes.filter(
      (node) => node.id === framing.target || node.parentId === framing.target,
    );
    // Until the layout catches up the block does not exist yet; the next run of
    // this effect, with the new layout, is the one that frames it.
    if (subtree.length < 2) return undefined;
    return frameTwice(() => frameBounds(subtree, 0.95));
  }, [framing, layout, frameBounds]);

  const toggle = useCallback((name: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const allOpen = projectNames.length > 0 && projectNames.every((name) => expanded.has(name));

  return (
    <div className="memory-nebula" ref={shellRef}>
      <div className="memory-nebula-tools">
        <button
          type="button"
          disabled={!projectNames.length}
          onClick={() => {
            // Opening or closing everything is an overview request, so the whole
            // map is framed — once the layout it asks for actually exists.
            setFraming({ token: Date.now(), target: "all" });
            setExpanded(allOpen ? new Set() : new Set(projectNames));
          }}
        >{allOpen ? "全部收起" : "全部展开"}</button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        proOptions={{ hideAttribution: true }}
        // The library's own signal that it is ready to be positioned; framing
        // before this is dropped on the floor without complaint.
        onInit={() => frameBounds(layoutRef.current.nodes, 1)}
        // Everything opened is 75 cards spread wider than any screen. The floor
        // has to be low enough that "全部展开" can actually frame it: that view is
        // for shape, and reading is what zooming back in is for.
        minZoom={0.08}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        onNodeClick={(_event, node) => {
          const data = node.data as NebulaNodeData;
          if (data.kind === "project" && data.childCount) {
            if (!expanded.has(data.label)) setFraming({ token: Date.now(), target: data.id });
            toggle(data.label);
          }
          onSelect(data);
        }}
      >
        {/* 画板得看得出是画板。默认那层点阵在当前缩放下半径不到半个像素，
            而且颜色被库自己的变量盖掉了，等于没有——改成两层网格：细格给出
            质感，粗格给出尺度感。颜色走 --xy-* 变量，这是库认的那个口子。
            底是纯白，所以格线只要「看得见但不抢眼」：细格几乎是白的，粗格
            也只比底色深一点点。 */}
        <Background variant={BackgroundVariant.Lines} gap={26} lineWidth={1} color="var(--nebula-grid-fine)" />
        <Background id="coarse" variant={BackgroundVariant.Lines} gap={130} lineWidth={1} color="var(--nebula-grid-coarse)" />
        <MiniMap pannable zoomable nodeStrokeWidth={2} style={{ width: 150, height: 104 }} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function MemoryNebula(props: {
  global?: MemoryDocumentSnapshot;
  documents: readonly MemoryDocumentSnapshot[];
  selectedPath?: string;
  onSelect: (node: NebulaNode) => void;
}): React.JSX.Element {
  return <ReactFlowProvider><NebulaCanvas {...props} /></ReactFlowProvider>;
}
