import { X } from "lucide-react";
import { memo, useState } from "react";
import { GALAXY_VIEWBOX, contextGalaxyBreakdown, type ContextGalaxy, type GalaxyNode } from "./contextGalaxyModel";
import { tokenNumber, toolDisplayName } from "./runtimePresentation";
import "./contextGalaxy.css";

/** Leaves store the raw tool name so aggregation stays free of presentation. */
function displayLabel(node: GalaxyNode): string {
  return node.toolName ? toolDisplayName(node.toolName) : node.label;
}

function shareText(share: number): string {
  if (share <= 0) return "0%";
  return share < 0.001 ? "<0.1%" : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}

/**
 * A label only earns its place if it fits inside the circle. Everything is in
 * viewBox units; CJK glyphs are square at the font size, latin roughly half.
 */
function labelFits(label: string, radius: number, fontSize: number): boolean {
  const width = [...label].reduce((total, char) => total + (/[一-鿿]/.test(char) ? fontSize : fontSize * 0.55), 0);
  return width <= (radius - 0.8) * 2;
}

function GalaxyFigure({
  galaxy,
  interactive,
  activeId,
  onActivate,
}: {
  galaxy: ContextGalaxy;
  interactive: boolean;
  activeId?: string;
  onActivate?: (node?: GalaxyNode) => void;
}): React.JSX.Element {
  const root = galaxy.nodes.find((node) => node.depth === 0);
  return (
    <svg viewBox={`0 0 ${GALAXY_VIEWBOX} ${GALAXY_VIEWBOX}`} role="img" aria-label="上下文构成">
      {galaxy.links.map((link) => (
        <line className="context-galaxy-link" key={`${link.from}->${link.to}`} x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} />
      ))}
      {galaxy.nodes.map((node) => {
        const residual = node.id === "cat:residual";
        const label = displayLabel(node);
        const fontSize = node.depth === 0 ? 3.4 : 2.6;
        const showLabel = node.depth === 0 || (interactive && labelFits(label, node.radius, fontSize));
        return (
          <g
            className={`context-galaxy-target ${activeId === node.id ? "is-active" : ""}`}
            key={node.id}
            {...(interactive
              ? {
                tabIndex: 0,
                role: "button",
                "aria-label": `${label}：${tokenNumber(node.tokens)} Token，占 ${shareText(node.share)}`,
                onPointerEnter: () => onActivate?.(node),
                onPointerLeave: () => onActivate?.(undefined),
                onFocus: () => onActivate?.(node),
                onBlur: () => onActivate?.(undefined),
              }
              : {})}
          >
            {/* An opaque disc under each node so overlapping tints stay legible. */}
            <circle className="context-galaxy-ring" cx={node.x} cy={node.y} r={node.radius} />
            <circle
              className={`context-galaxy-node depth-${node.depth} ${residual ? "residual" : ""}`}
              cx={node.x}
              cy={node.y}
              r={node.radius}
            />
            {showLabel ? (
              <text className={`context-galaxy-label ${node.depth === 0 ? "on-root" : ""}`} x={node.x} y={node.depth === 0 ? node.y - 1.6 : node.y}>
                {label}
              </text>
            ) : null}
            {node.depth === 0 && root ? (
              <text className="context-galaxy-value" x={node.x} y={node.y + 2.6}>{tokenNumber(root.tokens)}</text>
            ) : null}
            {/* Small leaves would otherwise be pinpoint targets. */}
            {interactive ? <circle className="context-galaxy-hit" cx={node.x} cy={node.y} r={Math.max(node.radius, 4)} /> : null}
          </g>
        );
      })}
    </svg>
  );
}

export const ContextGalaxyThumbnail = memo(function ContextGalaxyThumbnail({
  galaxy,
  onOpen,
}: {
  galaxy: ContextGalaxy;
  onOpen: () => void;
}): React.JSX.Element {
  const legend = contextGalaxyBreakdown(galaxy).slice(0, 3);
  return (
    <button className="runtime-galaxy-trigger context-galaxy" type="button" onClick={onOpen}>
      <span className="context-galaxy-figure" aria-hidden="true">
        <GalaxyFigure galaxy={galaxy} interactive={false} />
      </span>
      <span className="runtime-galaxy-legend">
        {legend.map((node) => (
          <div key={node.id}>
            <i className={node.id === "cat:residual" ? "residual" : ""} />
            <strong>{displayLabel(node)}</strong>
            <small>{tokenNumber(node.tokens)} · {shareText(node.share)}</small>
          </div>
        ))}
      </span>
    </button>
  );
});

export const ContextGalaxyBoard = memo(function ContextGalaxyBoard({
  galaxy,
  contextWindow,
  onClose,
}: {
  galaxy: ContextGalaxy;
  contextWindow?: number;
  onClose: () => void;
}): React.JSX.Element {
  const [active, setActive] = useState<GalaxyNode>();
  const rows = contextGalaxyBreakdown(galaxy);
  const root = galaxy.nodes.find((node) => node.depth === 0);
  const tipSide = active && active.x > GALAXY_VIEWBOX / 2 ? "left" : "right";

  return (
    <section className="context-galaxy-board context-galaxy" role="dialog" aria-modal="true" aria-labelledby="context-galaxy-title">
      <header>
        <div>
          <h2 id="context-galaxy-title">上下文构成</h2>
          <p>
            圆面积表示 Token 占用；扇区角度只用于排布，不代表占比。工具活动按具体工具展开，调用与结果合并计算。
          </p>
        </div>
        <button type="button" aria-label="关闭" onClick={onClose}><X size={15} /></button>
      </header>

      <div className="context-galaxy-canvas">
        {galaxy.degenerate ? (
          <p className="context-galaxy-empty">当前会话还没有可估算的上下文。</p>
        ) : (
          <>
            <div className="context-galaxy-figure">
              <GalaxyFigure galaxy={galaxy} interactive activeId={active?.id} onActivate={setActive} />
            </div>
            {active ? (
              <div
                className="context-galaxy-tip"
                style={{
                  left: tipSide === "right" ? `${active.x + active.radius}%` : undefined,
                  right: tipSide === "left" ? `${GALAXY_VIEWBOX - active.x + active.radius}%` : undefined,
                  top: `${Math.min(88, Math.max(2, active.y))}%`,
                }}
              >
                <strong>{displayLabel(active)}</strong>
                <small>
                  {tokenNumber(active.tokens)} Token · 占 {shareText(active.share)}
                  {active.itemCount ? ` · ${active.itemCount} 条` : ""}
                </small>
                {active.detail ? <p>{active.detail}</p> : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="context-galaxy-side">
        <div className="context-galaxy-total">
          <strong>{tokenNumber(root?.tokens ?? 0)}</strong>
          <small>
            {contextWindow ? `上下文窗口 ${tokenNumber(contextWindow)} Token` : "当前上下文估算"}
            {galaxy.reportedTotal !== undefined ? " · 服务端上报" : " · 本地估算"}
          </small>
        </div>

        <div className="context-galaxy-table">
          {rows.map((node) => (
            <div className={active?.id === node.id ? "is-active" : ""} key={node.id}>
              <i className={node.id === "cat:residual" ? "residual" : ""} />
              <strong>{displayLabel(node)}</strong>
              <em>{shareText(node.share)}</em>
              <b>{tokenNumber(node.tokens)}</b>
            </div>
          ))}
        </div>

        {galaxy.residual > 0 ? (
          <p className="context-galaxy-note">
            「其他 · 未归类」是服务端上报的总量减去可归类分项的差额，包含消息封装与估算误差。
          </p>
        ) : null}
        {galaxy.overshoot > 0 ? (
          <p className="context-galaxy-note warn">
            分项估算合计比服务端上报的总量多 {tokenNumber(galaxy.overshoot)} Token。分项未按比例缩放，占比以估算合计为分母。
          </p>
        ) : null}
        <p className="context-galaxy-note">
          分项由本地 chars/4 估算得出，与服务端上报的总量口径不同，两者不会完全一致。
        </p>
      </div>
    </section>
  );
});
