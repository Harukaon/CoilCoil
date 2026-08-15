import * as Popover from "@radix-ui/react-popover";
import { PanelRight, Plus, X } from "lucide-react";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface InspectorTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  closable?: boolean;
  disabled?: boolean;
}

export function InspectorPane<T extends string>({
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  onClose,
  addOptions,
  onAddTab,
  emptyState,
  children,
}: {
  tabs: InspectorTab<T>[];
  activeTab: T;
  onSelectTab: (tab: T) => void;
  onCloseTab?: (tab: T) => void;
  onClose: () => void;
  addOptions?: InspectorTab<T>[];
  onAddTab?: (tab: T) => void;
  emptyState?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  return (
    <aside className="inspector-pane">
      <header className="inspector-header">
        <nav className="inspector-nav no-drag" aria-label="右侧面板">
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <div className={`inspector-tab ${item.id === activeTab ? "active" : ""}`} key={item.id}>
                <button
                  className="inspector-tab-select"
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  aria-pressed={item.id === activeTab}
                  onClick={() => onSelectTab(item.id)}
                >
                  <Icon size={15} strokeWidth={1.7} />
                  <span>{item.label}</span>
                </button>
                {item.closable && onCloseTab ? (
                  <button className="inspector-tab-close" type="button" aria-label={`关闭 ${item.label}`} onClick={() => onCloseTab(item.id)}>
                    <X size={11} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </nav>
        <div className="inspector-drag-surface" aria-hidden="true" />
        <div className="inspector-actions no-drag">
          {addOptions?.length && onAddTab ? (
            <Popover.Root open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <Popover.Trigger asChild>
                <button className="icon-button inspector-add-tab" type="button" aria-label="打开面板" title="打开面板"><Plus size={15} /></button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="inspector-add-popover" role="menu" side="bottom" align="end" sideOffset={5} collisionPadding={8}>
                  {addOptions.map((item) => {
                    const Icon = item.icon;
                    return <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onAddTab(item.id); setAddMenuOpen(false); }}><Icon size={13} /><span>{item.label}</span></button>;
                  })}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
          <button className="icon-button" type="button" aria-label="收起右侧栏" onClick={onClose}><PanelRight size={17} /></button>
        </div>
      </header>
      <section className={`inspector-content inspector-content-${activeTab}`}>
        {tabs.length ? children : <div className="inspector-empty-tabs">{emptyState}</div>}
      </section>
    </aside>
  );
}
