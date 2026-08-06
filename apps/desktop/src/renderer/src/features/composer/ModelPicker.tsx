import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, CircleDot, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelOption, RuntimeConfiguration, SessionSnapshot } from "@suocode/runtime-protocol";

export function ModelPicker({ configuration, currentModel, open, busy, onOpenChange, onSelect, onOpenSettings }: {
  configuration?: RuntimeConfiguration;
  currentModel?: SessionSnapshot["model"];
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (model: ModelOption) => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

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
        <Popover.Content className="model-popover" side="top" align="start" sideOffset={8} collisionPadding={12} avoidCollisions>
          <div className="model-popover-search"><Search size={14} /><input autoFocus value={search} placeholder="搜索模型" onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="model-popover-list">
            {groups.map(([provider, group]) => <section className="model-provider-group" key={provider}>
              <h3>{group.name}</h3>
              {group.models.map((model) => {
                const active = currentModel?.provider === model.provider && currentModel.id === model.id;
                return <button className={active ? "active" : ""} type="button" disabled={busy} key={`${model.provider}/${model.id}`} onClick={() => onSelect(model)}><span><strong>{model.name}</strong><small>{model.id}</small></span>{active ? <Check size={14} /> : null}</button>;
              })}
            </section>)}
            {!groups.length ? <div className="model-popover-empty">{configuration?.configuredProviders.length ? "没有匹配的模型" : "尚未配置模型服务商"}</div> : null}
          </div>
          <button className="model-settings-link" type="button" onClick={onOpenSettings}><Settings size={14} /><span>模型与服务商设置</span></button>
          <Popover.Arrow className="model-popover-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
