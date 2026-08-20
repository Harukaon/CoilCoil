import { useId } from "react";

/**
 * The SuoCode mark: triangles rotating under a blurred mask, so the shape reads
 * as one drifting ink blob rather than as its parts.
 *
 * This is the design source (`apps/desktop/build/logo.svg`) copied as-is — the
 * geometry, the blur, the contrast pulse and every rotation timing are unchanged,
 * and they live in `styles.css` next to the rest of the app's animation. Two
 * things had to move: the CSS hooks are classes instead of ids, and the ids the
 * mask and gradient are referenced by are per-instance, because a screen renders
 * the mark more than once and duplicate ids would collide.
 *
 * The effect is CSS, so it only exists where CSS runs: Chromium renders it, and
 * a static rasterizer (macOS Quick Look, an exported PNG) shows the unblurred
 * triangles instead.
 */
export function SuoLogo({ size = 34 }: { size?: number }): React.JSX.Element {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = `suo-logo-gradient-${instance}`;
  const maskId = `suo-logo-mask-${instance}`;
  return (
    <svg
      className="suo-logo"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label="SuoCode"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop className="suo-logo-ink-1" offset="20%" stopColor="#000000" />
          <stop className="suo-logo-ink-2" offset="50%" stopColor="#2a2a2a" />
          <stop className="suo-logo-ink-3" offset="80%" stopColor="#1a1a1a" />
        </linearGradient>
        <mask id={maskId} className="suo-logo-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
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
