import { Plus, X } from "lucide-react";

import type { TabState } from "../../shared/types";

interface TabBarProps {
  activeTabId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  tabs: TabState[];
}

export function TabBar({
  activeTabId,
  onActivate,
  onClose,
  onNew,
  tabs,
}: TabBarProps) {
  return (
    <nav
      aria-label="独立セッションタブ"
      className="tab-bar"
      data-tour-target="tab-bar"
      role="tablist"
    >
      <div className="tab-strip">
        {tabs.map((tab) => (
          <div
            aria-controls={`tab-panel-${tab.id}`}
            aria-label={tab.title}
            aria-selected={tab.id === activeTabId}
            className={`tab-item ${tab.id === activeTabId ? "is-active" : ""}`}
            data-testid={`tab-${tab.id}`}
            id={`tab-${tab.id}`}
            key={tab.id}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivate(tab.id);
              }
            }}
            role="tab"
            tabIndex={tab.id === activeTabId ? 0 : -1}
          >
            <span>{tab.title}</span>
            <button
              aria-label={`${tab.title}を閉じる`}
              className="tab-close"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              type="button"
            >
              <X aria-hidden="true" size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        aria-label="新規タブ"
        className="new-tab-button"
        onClick={onNew}
        title="新規タブ (Ctrl+Shift+T)"
        type="button"
      >
        <Plus aria-hidden="true" size={16} />
      </button>
    </nav>
  );
}
