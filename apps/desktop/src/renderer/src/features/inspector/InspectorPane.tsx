import { PanelRight, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface InspectorTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  closable?: boolean;
}

export function InspectorPane<T extends string>({
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  onClose,
  emptyState,
  children,
}: {
  tabs: InspectorTab<T>[];
  activeTab: T;
  onSelectTab: (tab: T) => void;
  onCloseTab?: (tab: T) => void;
  onClose: () => void;
  emptyState?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
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
          <button className="icon-button" type="button" aria-label="收起右侧栏" onClick={onClose}><PanelRight size={17} /></button>
        </div>
      </header>
      <section className={`inspector-content inspector-content-${activeTab}`}>
        {tabs.length ? children : <div className="inspector-empty-tabs">{emptyState}</div>}
      </section>
    </aside>
  );
}
