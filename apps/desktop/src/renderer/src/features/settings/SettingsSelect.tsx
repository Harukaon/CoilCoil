import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface SettingsSelectOption {
  value: string;
  label: string;
  detail?: string;
  keywords?: string;
  disabled?: boolean;
}

export function SettingsSelect({
  value,
  options,
  onChange,
  placeholder = "请选择",
  ariaLabel,
  searchable = false,
  disabled = false,
  className = "",
}: {
  value?: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) => `${option.label} ${option.detail ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(normalized));
  }, [options, query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={`settings-select ${className}`.trim()} type="button" aria-label={ariaLabel} disabled={disabled}>
          <span className={selected ? "" : "placeholder"}>{selected?.label ?? placeholder}</span>
          <ChevronDown size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="settings-select-popover" side="bottom" align="start" sideOffset={6} collisionPadding={12}>
          {searchable ? <div className="settings-select-search"><Search size={14} /><input autoFocus value={query} placeholder="搜索…" onChange={(event) => setQuery(event.target.value)} /></div> : null}
          <div className="settings-select-options">
            {visible.map((option) => <button className={option.value === value ? "active" : ""} type="button" disabled={option.disabled} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
              <span><strong>{option.label}</strong>{option.detail ? <small>{option.detail}</small> : null}</span>{option.value === value ? <Check size={14} /> : null}
            </button>)}
            {!visible.length ? <p>没有匹配项</p> : null}
          </div>
          <Popover.Arrow className="settings-select-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
