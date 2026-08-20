import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export function Tooltip({
  content,
  children,
}: {
  content?: ReactNode;
  children: ReactElement;
}): React.JSX.Element {
  if (!content) return children;

  return (
    <RadixTooltip.Provider delayDuration={320} skipDelayDuration={120}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="coil-tooltip" side="top" align="start" sideOffset={7} collisionPadding={10}>
            {content}
            <RadixTooltip.Arrow className="coil-tooltip-arrow" width={10} height={5} />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
