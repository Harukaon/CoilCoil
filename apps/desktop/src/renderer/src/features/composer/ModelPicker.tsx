import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ChevronRight, CircleDot, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelOption, RuntimeConfiguration, SessionSnapshot, ThinkingLevel } from "@suocode/runtime-protocol";

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

function supportsFast(modelId: string | undefined): boolean {
  const leafId = modelId?.split("/").at(-1);
  return Boolean(leafId && /^gpt-/i.test(leafId));
}

export function ModelPicker({
  configuration,
  currentModel,
  currentThinkingLevel,
  currentFast = false,
  open,
  busy,
  side = "top",
  onOpenChange,
  onSelect,
  onConfigureOptions,
  onFastChange,
  onOpenSettings,
}: {
  configuration?: RuntimeConfiguration;
  currentModel?: SessionSnapshot["model"];
  currentThinkingLevel?: ThinkingLevel;
  currentFast?: boolean;
  open: boolean;
  busy: boolean;
  side?: "top" | "bottom";
  onOpenChange: (open: boolean) => void;
  onSelect: (model: ModelOption) => void;
  onConfigureOptions?: (model: ModelOption, thinkingLevel: ThinkingLevel, contextWindow?: number) => Promise<void>;
  onFastChange?: (enabled: boolean) => Promise<void>;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setModelsOpen(false);
    }
  }, [open]);

  const activeModel = configuration?.models.find((model) => (
    model.provider === currentModel?.provider && model.id === currentModel.id
  ));
  const thinkingLevels = activeModel?.supportedThinkingLevels.length
    ? activeModel.supportedThinkingLevels
    : (["off"] as ThinkingLevel[]);
  const selectedThinking = thinkingLevels.includes(currentThinkingLevel ?? "off")
    ? currentThinkingLevel ?? "off"
    : thinkingLevels[0]!;
  const fastAvailable = supportsFast(activeModel?.id ?? currentModel?.id) && Boolean(onFastChange);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const grouped = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of configuration?.models ?? []) {
      if (!model.configured) continue;
      if (query && !`${model.providerName} ${model.provider} ${model.name} ${model.id}`.toLowerCase().includes(query)) continue;
      const group = grouped.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      grouped.set(model.provider, group);
    }
    return [...grouped.entries()];
  }, [configuration, search]);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button className="agent-mode" type="button"><CircleDot size={13} /><span>{currentModel?.name ?? "选择模型"}</span><ChevronDown size={12} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="model-popover model-parameter-popover" side={side} align="start" sideOffset={8} collisionPadding={12} avoidCollisions>
          <section className="model-parameter-section">
            <h3>思考级别</h3>
            <div className="model-parameter-options">
              {thinkingLevels.map((level) => <button
                className={selectedThinking === level ? "active" : ""}
                type="button"
                key={level}
                disabled={busy || !activeModel || !onConfigureOptions}
                onClick={() => activeModel && onConfigureOptions ? void onConfigureOptions(activeModel, level) : undefined}
              >
                <span>{THINKING_LABELS[level]}</span>{selectedThinking === level ? <Check size={13} /> : null}
              </button>)}
            </div>
          </section>
          <section className="model-parameter-section model-parameter-actions">
            {fastAvailable ? <button className="model-parameter-toggle" type="button" aria-pressed={currentFast} disabled={busy} onClick={() => onFastChange ? void onFastChange(!currentFast) : undefined}>
              <span><strong>Fast</strong><small>Priority service</small></span>
              <i className={currentFast ? "active" : ""} aria-hidden="true"><b /></i>
            </button> : null}
            <Popover.Root open={modelsOpen} onOpenChange={setModelsOpen}>
              <Popover.Trigger asChild>
                <button className="model-submenu-trigger" type="button">
                  <span><strong>模型</strong><small>{currentModel?.name ?? "选择模型"}</small></span><ChevronRight size={15} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="model-popover model-submenu" side="left" align="end" sideOffset={7} collisionPadding={12} avoidCollisions>
                  <div className="model-popover-search"><Search size={14} /><input autoFocus value={search} placeholder="搜索模型名称或 ID" onChange={(event) => setSearch(event.target.value)} /></div>
                  <div className="model-popover-list">
                    {groups.map(([provider, group]) => <section className="model-provider-group" key={provider}>
                      <h3>{group.name}</h3>
                      {group.models.map((model) => {
                        const active = currentModel?.provider === model.provider && currentModel.id === model.id;
                        return <button className={`model-option-main ${active ? "active" : ""}`} type="button" key={`${model.provider}/${model.id}`} disabled={busy} onClick={() => { setModelsOpen(false); onSelect(model); }}>
                          <span><strong>{model.name}</strong><small>{model.id}</small></span>{active ? <Check size={14} /> : null}
                        </button>;
                      })}
                    </section>)}
                    {!groups.length ? <div className="model-popover-empty">{configuration?.configuredProviders.length ? "没有匹配的模型" : "尚未配置模型服务商"}</div> : null}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </section>
          <button className="model-settings-link" type="button" onClick={onOpenSettings}><Settings size={14} /><span>模型与服务商设置</span></button>
          <Popover.Arrow className="model-popover-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
