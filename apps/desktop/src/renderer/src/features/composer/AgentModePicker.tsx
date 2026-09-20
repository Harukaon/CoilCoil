import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import type { AgentMode } from "@coilcoil/runtime-protocol";

const MODE_LABELS: Record<AgentMode, string> = {
  standard: "普通模式",
  unrestricted: "Unrestricted 模式",
};

export function AgentModePicker({
  mode,
  locked = false,
  side = "top",
  onChange,
}: {
  mode: AgentMode;
  locked?: boolean;
  side?: "top" | "bottom";
  onChange?: (mode: AgentMode) => void;
}): React.JSX.Element {
  const trigger = (
    <button className="workspace-path agent-mode-selector" type="button">
      <span>{MODE_LABELS[mode]}</span>
      <ChevronDown size={12} />
    </button>
  );

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="model-popover mode-popover" side={side} align="start" sideOffset={8} collisionPadding={12} avoidCollisions>
          <section className="model-parameter-section" title={locked ? "当前对话的模式已固定；新建对话后可以切换" : undefined}>
            <h3>模式</h3>
            <div className="model-parameter-options">
              {(["standard", "unrestricted"] as const).map((candidate) => (
                <button
                  className={mode === candidate ? "active" : ""}
                  type="button"
                  key={candidate}
                  disabled={locked || !onChange}
                  onClick={() => onChange?.(candidate)}
                >
                  <span>{MODE_LABELS[candidate]}</span>
                  {mode === candidate ? <Check size={12} /> : null}
                </button>
              ))}
            </div>
          </section>
          <Popover.Arrow className="model-popover-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
