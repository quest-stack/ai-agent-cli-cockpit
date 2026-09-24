import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { terminalRegistry } from "../terminal-registry";

import { t } from "../../shared/i18n";

import type { SessionState } from "../../shared/types";

interface SearchOverlayProps {
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  sessions: SessionState[];
}

export function SearchOverlay({
  onClose,
  onSelectSession,
  sessions,
}: SearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [matchingIds, setMatchingIds] = useState<string[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matchingSessions = useMemo(
    () =>
      matchingIds
        .map((id) => sessions.find((session) => session.id === id))
        .filter((session): session is SessionState => Boolean(session)),
    [matchingIds, sessions],
  );

  const runSearch = (value: string): void => {
    setQuery(value);
    setActiveIndex(0);
    setMatchingIds(
      value ? terminalRegistry.searchAll(value).map((match) => match.sessionId) : [],
    );
  };

  const move = (direction: "next" | "previous"): void => {
    if (matchingSessions.length === 0) {
      return;
    }

    const offset = direction === "next" ? 1 : -1;
    const nextIndex =
      (activeIndex + offset + matchingSessions.length) %
      matchingSessions.length;
    const session = matchingSessions[nextIndex];
    setActiveIndex(nextIndex);
    onSelectSession(session.id);
    terminalRegistry.searchIn(session.id, query, direction);
  };

  return (
    <div
      className="search-overlay"
      data-testid="search-overlay"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
        if (event.key === "Enter") {
          event.preventDefault();
          move(event.shiftKey ? "previous" : "next");
        }
      }}
      role="search"
    >
      <Search aria-hidden="true" size={17} />
      <input
        aria-label={t("全ペインを検索")}
        onChange={(event) => runSearch(event.target.value)}
        placeholder={t("全ペインのスクロールバックを検索")}
        ref={inputRef}
        value={query}
      />
      <span className="search-count">
        {query ? `${matchingSessions.length} panes` : "Ctrl+Shift+F"}
      </span>
      <button
        aria-label={t("前の一致")}
        disabled={matchingSessions.length === 0}
        onClick={() => move("previous")}
        type="button"
      >
        <ChevronUp aria-hidden="true" size={15} />
      </button>
      <button
        aria-label={t("次の一致")}
        disabled={matchingSessions.length === 0}
        onClick={() => move("next")}
        type="button"
      >
        <ChevronDown aria-hidden="true" size={15} />
      </button>
      <button aria-label={t("検索を閉じる")} onClick={onClose} type="button">
        <X aria-hidden="true" size={15} />
      </button>
    </div>
  );
}
