import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, CircleDot, Search, Settings, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelOption, RuntimeConfiguration, SessionSnapshot, ThinkingLevel } from "@suocode/runtime-protocol";

export function ModelPicker({ configuration, currentModel, currentThinkingLevel, open, busy, side = "top", onOpenChange, onSelect, onConfigureOptions, onOpenSettings }: {
  configuration?: RuntimeConfiguration;
  currentModel?: SessionSnapshot["model"];
  currentThinkingLevel?: ThinkingLevel;
  open: boolean;
  busy: boolean;
  side?: "top" | "bottom";
  onOpenChange: (open: boolean) => void;
  onSelect: (model: ModelOption) => void;
  onConfigureOptions?: (model: ModelOption, thinkingLevel: ThinkingLevel, contextWindow: number) => Promise<void>;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [editingKey, setEditingKey] = useState<string>();
  const [quickThinking, setQuickThinking] = useState<ThinkingLevel>(currentThinkingLevel ?? configuration?.thinkingLevel ?? "off");
  const [quickContext, setQuickContext] = useState("");

  useEffect(() => {
    if (!open) {
      setSearch("");
      setEditingKey(undefined);
    }
  }, [open]);

  const beginEditing = (model: ModelOption): void => {
    const supported: ThinkingLevel[] = model.supportedThinkingLevels.length ? model.supportedThinkingLevels : ["off"];
    const currentThinking = currentThinkingLevel ?? configuration?.thinkingLevel ?? "off";
    setQuickThinking(supported.includes(currentThinking) ? currentThinking : supported[0]!);
    setQuickContext(model.contextWindow === undefined ? "" : String(model.contextWindow));
    setEditingKey(`${model.provider}/${model.id}`);
  };

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
        <Popover.Content className="model-popover" side={side} align="start" sideOffset={8} collisionPadding={12} avoidCollisions>
          <div className="model-popover-search"><Search size={14} /><input autoFocus value={search} placeholder="搜索模型" onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="model-popover-list">
            {groups.map(([provider, group]) => <section className="model-provider-group" key={provider}>
              <h3>{group.name}</h3>
              {group.models.map((model) => {
                const active = currentModel?.provider === model.provider && currentModel.id === model.id;
                const key = `${model.provider}/${model.id}`;
                const editing = editingKey === key;
                return <div className={`model-option ${active ? "active" : ""}`} key={key}>
                  <div className="model-option-row">
                    <button className="model-option-main" type="button" disabled={busy} onClick={() => onSelect(model)}><span><strong>{model.name}</strong><small>{model.id}</small></span>{active ? <Check size={14} /> : null}</button>
                    {active && onConfigureOptions ? <button className={`model-option-edit ${editing ? "active" : ""}`} type="button" aria-label="快捷调整模型参数" aria-expanded={editing} disabled={busy} onClick={() => editing ? setEditingKey(undefined) : beginEditing(model)}><SlidersHorizontal size={14} /></button> : null}
                  </div>
                  {editing && onConfigureOptions ? <div className="model-quick-options">
                    <label><span>Thinking</span><div className="thinking-levels">{(model.supportedThinkingLevels.length ? model.supportedThinkingLevels : (["off"] as ThinkingLevel[])).map((level) => <button className={quickThinking === level ? "active" : ""} type="button" key={level} onClick={() => setQuickThinking(level)}>{level}</button>)}</div></label>
                    <label><span>上下文窗口</span><input type="number" min="1024" step="1024" value={quickContext} placeholder="模型目录未提供" onChange={(event) => setQuickContext(event.target.value)} /></label>
                    <button className="model-quick-save" type="button" disabled={busy || Number(quickContext) < 1024} onClick={() => void onConfigureOptions(model, quickThinking, Number(quickContext))}>{busy ? "正在应用…" : "应用到当前模型"}</button>
                  </div> : null}
                </div>;
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
