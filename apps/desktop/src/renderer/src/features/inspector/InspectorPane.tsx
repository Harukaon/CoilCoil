import { PanelRight, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface InspectorTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

export function InspectorPane<T extends string>({
  tabs,
  activeTab,
  onSelectTab,
  onRefresh,
  refreshDisabled,
  onClose,
  children,
}: {
  tabs: InspectorTab<T>[];
  activeTab: T;
  onSelectTab: (tab: T) => void;
  onRefresh: () => void;
  refreshDisabled?: boolean;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <aside className="inspector-pane">
      <header className="inspector-header">
        <nav className="inspector-nav no-drag" aria-label="右侧面板">
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.id === activeTab ? "active" : ""}
                type="button"
                key={item.id}
                title={item.label}
                aria-label={item.label}
                aria-pressed={item.id === activeTab}
                onClick={() => onSelectTab(item.id)}
              >
                <Icon size={15} strokeWidth={1.7} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="inspector-drag-surface" aria-hidden="true" />
        <div className="inspector-actions no-drag">
          <button className="icon-button" type="button" aria-label="刷新当前面板" disabled={refreshDisabled} onClick={onRefresh}><RefreshCw size={15} /></button>
          <button className="icon-button" type="button" aria-label="收起右侧栏" onClick={onClose}><PanelRight size={17} /></button>
        </div>
      </header>
      <section className={`inspector-content inspector-content-${activeTab}`}>{children}</section>
    </aside>
  );
}
