import type { CSSProperties } from "react";
import "./loaders.css";

/**
 * Loading indicators.
 *
 * Each one is copied from the implementation it arrived with — geometry, timings
 * and keyframes unchanged — and wrapped so it can be dropped anywhere:
 *
 * - `size` is the rendered box in pixels. Every loader is authored at its own
 *   natural size and scaled as a whole, because the SVG blur that shapes the
 *   gooey ones is an absolute length: shrinking the geometry alone would leave
 *   the blur oversized and the shape would smear instead of merging.
 * - `speed` overrides the animation cycle, where the source exposed one.
 * - Colour comes from `currentColor`, so a loader takes the colour of the text
 *   around it and needs no per-theme copy.
 *
 * The filters they reference are declared once in `index.html`.
 */
export interface LoaderProps {
  /** Rendered size in pixels. Square, except the jelly bar which is 2:1. */
  size?: number;
  /** Seconds per cycle, when the source loader exposes one. */
  speed?: number;
}

/**
 * Wrap a loader so it occupies `size` in layout while its own geometry stays at
 * the size it was authored for.
 *
 * The scale sits on its own frame element, never on the loader itself: two of
 * these animate their container's `transform`, and an animation overrides a
 * plain declaration, which would silently drop the scale.
 */
function Scaled({ authored, size, speed, ratio = 1, className, children }: {
  authored: number;
  size: number;
  speed?: number;
  /** Height as a fraction of width, for the loaders that are not square. */
  ratio?: number;
  className: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className="suo-loader-scaler"
      style={{ width: size, height: size * ratio }}
      role="status"
      aria-label="加载中"
    >
      <span
        className="suo-loader-frame"
        style={{
          "--suo-loader-scale": String(size / authored),
          width: authored,
          height: authored * ratio,
          ...(speed === undefined ? {} : { "--uib-speed": `${speed}s` }),
        } as CSSProperties}
      >
        <span className={className}>{children}</span>
      </span>
    </span>
  );
}

/** Ink drops crossing a rounded field, merging into one growing blot in the middle. */
export function BlobsLoader({ size = 300, speed }: LoaderProps): React.JSX.Element {
  return (
    <Scaled authored={300} size={size} speed={speed} className="suo-blobs">
      <span className="suo-blob-center" />
      <span className="suo-blob" />
      <span className="suo-blob" />
      <span className="suo-blob" />
      <span className="suo-blob" />
      <span className="suo-blob" />
      <span className="suo-blob" />
    </Scaled>
  );
}

/** Two dots on crossing orbits, the whole ring turning as they go. */
export function OrbitLoader({ size = 25, speed }: LoaderProps): React.JSX.Element {
  return <Scaled authored={25} size={size} speed={speed} className="suo-orbit" />;
}

/** Two rounds pulling apart and snapping back, flipping axis every other cycle. */
export function JellyLoader({ size = 40, speed }: LoaderProps): React.JSX.Element {
  return <Scaled authored={40} size={size} speed={speed} ratio={0.5} className="suo-jelly" />;
}

/** Three corners breathing while a fourth dot walks the triangle between them. */
export function JellyTriangleLoader({ size = 45, speed }: LoaderProps): React.JSX.Element {
  return (
    <Scaled authored={45} size={size} speed={speed} className="suo-jelly-triangle">
      <span className="suo-jelly-triangle-dot" />
      <span className="suo-jelly-triangle-traveler" />
    </Scaled>
  );
}
