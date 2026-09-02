import { useId } from "react";

/**
 * The CoilCoil mark: overlapping triangles under a blurred mask, so the shape
 * reads as one ink blob rather than as its parts.
 *
 * This is the design source (`apps/desktop/build/logo.svg`) copied as-is — the
 * geometry and the blur are unchanged, and they live in `styles.css` next to the
 * rest of the app's visual detail. Two things had to move: the CSS hooks are
 * classes instead of ids, and the ids the mask and gradient are referenced by are
 * per-instance, because a screen renders the mark more than once and duplicate
 * ids would collide.
 *
 * The mark no longer animates. The design source spins six of the triangles under
 * a pulsing contrast filter; that filter chain has to be recomputed every frame
 * and measurably drained the battery (the numbers are in `ui/idle-motion.ts`), so
 * the user asked for a static mark instead. The rotations left in `styles.css` are
 * the ones the animation held at its first frame, so the shape is the same one the
 * app has always shown — it just stopped moving.
 *
 * The effect is CSS, so it only exists where CSS runs: Chromium renders it, and
 * a static rasterizer (macOS Quick Look, an exported PNG) shows the unblurred
 * triangles instead.
 */
export function CoilLogo({ size = 34 }: { size?: number }): React.JSX.Element {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = `coil-logo-gradient-${instance}`;
  const maskId = `coil-logo-mask-${instance}`;
  return (
    <svg
      className="coil-logo"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label="CoilCoil"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop className="coil-logo-ink-1" offset="20%" stopColor="#000000" />
          <stop className="coil-logo-ink-2" offset="50%" stopColor="#2a2a2a" />
          <stop className="coil-logo-ink-3" offset="80%" stopColor="#1a1a1a" />
        </linearGradient>
        <mask id={maskId} className="coil-logo-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <polygon points="0,0 100,0 100,100 0,100" fill="black" />
          <polygon points="25,25 75,25 50,75" fill="white" />
          <polygon points="50,25 75,75 25,75" fill="white" />
          <polygon points="35,35 65,35 50,65" fill="white" />
          <polygon points="35,35 65,35 50,65" fill="white" />
          <polygon points="35,35 65,35 50,65" fill="white" />
          <polygon points="35,35 65,35 50,65" fill="white" />
        </mask>
      </defs>
      <rect width="100" height="100" fill={`url(#${gradientId})`} mask={`url(#${maskId})`} />
    </svg>
  );
}
