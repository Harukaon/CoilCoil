import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** How tall a fenced block may be before it is folded, in pixels. */
export const COLLAPSED_CODE_HEIGHT = 320;
/** Below this much excess the fold would save nothing worth a click. */
const FOLD_THRESHOLD = 48;

export function shouldFoldCodeBlock(contentHeight: number): boolean {
  return contentHeight > COLLAPSED_CODE_HEIGHT + FOLD_THRESHOLD;
}

/**
 * A fenced code block that folds itself when it is long.
 *
 * A single pasted file used to push the whole conversation off screen, and the
 * reply underneath it was reached by scrolling past hundreds of lines nobody
 * asked to re-read. Long blocks open to a fixed height with the rest one click
 * away; short ones are untouched, and the fold never hides so little that the
 * button costs more than it saves.
 */
export function CollapsibleCodeBlock({ children, ...props }: {
  children?: ReactNode;
} & Record<string, unknown>): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [foldable, setFoldable] = useState(false);
  const [lines, setLines] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Streaming grows the block after it first renders, so the measurement has
    // to follow the content rather than run once on mount.
    const measure = (): void => {
      setFoldable(shouldFoldCodeBlock(element.scrollHeight));
      setLines(element.textContent ? element.textContent.replace(/\n$/, "").split("\n").length : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const collapsed = foldable && !expanded;
  return (
    <div className={`markdown-code-block ${collapsed ? "collapsed" : ""}`}>
      <pre {...props} ref={ref} style={collapsed ? { maxHeight: COLLAPSED_CODE_HEIGHT } : undefined}>{children}</pre>
      {foldable ? (
        <button className="markdown-code-toggle" type="button" onClick={() => setExpanded((current) => !current)}>
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span>{collapsed ? `展开全部${lines ? ` · ${lines} 行` : ""}` : "收起"}</span>
        </button>
      ) : null}
    </div>
  );
}
