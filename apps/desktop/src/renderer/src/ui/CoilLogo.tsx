import { useId } from "react";

/**
 * The CoilCoil mark: triangles rotating under a blurred mask, thresholded so the
 * shape reads as one drifting ink blob rather than as its parts.
 *
 * This mirrors the design source (`apps/desktop/build/logo.svg`) — same geometry,
 * same rotation timings, same blur. Two things differ on purpose: the rotations
 * are driven from `styles.css` so `prefers-reduced-motion` can stop them, and the
 * mask and filter ids are per-instance, because a screen renders the mark more
 * than once and duplicate ids would collide.
 *
 * The blob effect lives in a real SVG `<filter>`, not in CSS. A CSS `filter` on a
 * `<mask>` element is silently dropped — a mask is never painted itself — which is
 * why the mark used to render as a soft smudge instead of an ink blob, and why it
 * fell apart entirely once the same markup was rendered somewhere else. Filter
 * primitives work in every engine and inside an `<img>`.
 */
export function CoilLogo({ size = 34 }: { size?: number }): React.JSX.Element {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = `coil-logo-gradient-${instance}`;
  const maskId = `coil-logo-mask-${instance}`;
  const filterId = `coil-logo-goo-${instance}`;
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
        {/* 先把相邻的三角形糊到一起，再把 alpha 拉陡，糊开的边缘重新变成一条实边。 */}
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blurred" />
          <feColorMatrix
            in="blurred"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9"
          />
        </filter>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="black" />
          <g className="coil-logo-shapes" filter={`url(#${filterId})`}>
            <polygon points="25,25 75,25 50,75" fill="white" />
            <polygon points="50,25 75,75 25,75" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
            <polygon points="35,35 65,35 50,65" fill="white" />
          </g>
        </mask>
      </defs>
      <rect width="100" height="100" fill={`url(#${gradientId})`} mask={`url(#${maskId})`} />
    </svg>
  );
}
