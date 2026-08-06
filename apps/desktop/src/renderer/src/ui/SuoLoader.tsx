import type { CSSProperties } from "react";

export function SuoLoader({ size = 14 }: { size?: number }): React.JSX.Element {
  return <span className="suo-loader" style={{ "--loader-size": `${size}px` } as CSSProperties}><i /><i /><i /></span>;
}
