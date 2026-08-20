import type { CSSProperties } from "react";

/**
 * The activity indicator: two blobs of ink rolling along one baseline, merged
 * into a single splitting shape by the gooey filter declared in `index.html`.
 *
 * The shape is authored at its own size (12em × 3em on a 16px font) and scaled
 * down as a whole, so `size` is the height it occupies and the width follows the
 * 4:1 shape. Colour comes from the filter, not from here.
 */
export function CoilLoader({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <span className="coil-loader" style={{ "--loader-scale": String(size / 48) } as CSSProperties}>
      <span className="coil-loader-ink" />
    </span>
  );
}
