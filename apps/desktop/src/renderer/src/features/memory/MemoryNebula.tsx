import { Globe2, FileText, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryDocumentSnapshot } from "@coilcoil/runtime-protocol";
import {
  buildMemoryNebula,
  clampZoom,
  nebulaCentre,
  zoomToFit,
  type NebulaNode,
} from "./nebulaLayout";

/**
 * The memory store drawn as a map you can move around in.
 *
 * Every node is a real file. Clicking one hands its path back so the panel can
 * open it for editing — the picture is a way into the memory, not a decoration
 * beside it.
 */
export function MemoryNebula({
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
  const layout = useMemo(() => buildMemoryNebula(global, documents), [global, documents]);
  const centre = useMemo(() => nebulaCentre(layout), [layout]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const fit = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = zoomToFit(layout, viewport.clientWidth - 32, viewport.clientHeight - 32);
    setZoom(next);
    setPan({ x: 0, y: 0 });
  }, [layout]);

  // Fit once per shape change. Refitting on every render would yank the map back
  // to centre while someone is reading a corner of it.
  useEffect(() => { fit(); }, [fit]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX - pan.x, y: event.clientY - pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({ x: event.clientX - drag.x, y: event.clientY - drag.y });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="memory-nebula">
      <div className="memory-nebula-tools no-drag">
        <button type="button" onClick={() => setZoom((current) => clampZoom(current - 0.15))} aria-label="缩小">−</button>
        <button type="button" onClick={fit}>适应</button>
        <button type="button" onClick={() => setZoom((current) => clampZoom(current + 0.15))} aria-label="放大">＋</button>
      </div>
      <div
        className={`memory-nebula-viewport ${dragging ? "dragging" : ""}`}
        ref={viewportRef}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={(event) => setZoom((current) => clampZoom(current - event.deltaY * 0.0015))}
      >
        <div
          className="memory-nebula-canvas"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg className="memory-nebula-links" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.links.map((link) => {
              const from = layout.nodes.find((node) => node.id === link.from);
              const to = layout.nodes.find((node) => node.id === link.to);
              if (!from || !to) return null;
              return <line
                key={`${link.from}->${link.to}`}
                x1={centre.x + from.x}
                y1={centre.y + from.y}
                x2={centre.x + to.x}
                y2={centre.y + to.y}
              />;
            })}
          </svg>
          {layout.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`memory-node ${node.kind} ${node.filePath && node.filePath === selectedPath ? "selected" : ""} ${node.exists ? "" : "empty"}`}
              style={{ left: centre.x + node.x, top: centre.y + node.y }}
              // A drag that ends on a card must not also count as opening it.
              onClick={() => { if (!dragRef.current) onSelect(node); }}
              title={node.filePath ?? node.label}
            >
              <span className="memory-node-icon">
                {node.kind === "global" ? <Globe2 size={14} />
                  : node.kind === "project" ? <FolderOpen size={13} />
                  : <FileText size={12} />}
              </span>
              <span className="memory-node-label">{node.label}</span>
              <span className="memory-node-meta">
                {node.kind === "entry"
                  ? `${node.chars.toLocaleString()} 字`
                  : node.childCount
                    ? `${node.childCount} 条`
                    : "空"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
