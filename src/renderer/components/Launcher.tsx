import {
  Clock3,
  Folder,
  FolderOpen,
  Pin,
  PinOff,
  Play,
  RotateCcw,
  Search,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getProjectNameFromPath,
  resolveInitialLauncherCwd,
} from "../../shared/session-labels";

import { cockpitApi } from "../bridge";

import type {
  AppSettings,
  CliCommand,
  ProjectCandidate,
  RecentSession,
} from "../../shared/types";

export interface LaunchInput {
  command: string;
  cwd: string;
  projectName: string;
  title: string;
}

interface LauncherProps {
  error?: string;
  onRescan: () => Promise<void>;
  onStart: (input: LaunchInput) => Promise<void>;
  onTogglePin: (path: string) => void;
  projects: ProjectCandidate[];
  recent: RecentSession[];
  settings: AppSettings;
}

export function Launcher({
  error,
  onRescan,
  onStart,
  onTogglePin,
  projects,
  recent,
  settings,
}: LauncherProps) {
  const [command, setCommand] = useState(settings.defaultCommand);
  const [browseError, setBrowseError] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
  const [cwd, setCwd] = useState(() =>
    resolveInitialLauncherCwd(recent, projects),
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (cwd) {
      return;
    }
    // 起動直後は projects / recent がまだ空のことがある。空欄のままに
    // ならないよう、届いた時点で同じ規則で埋め直す。
    const initial = resolveInitialLauncherCwd(recent, projects);
    if (initial) {
      setCwd(initial);
    }
  }, [cwd, projects, recent]);

  const filteredProjects = useMemo(() => {
    const query = cwd.trim().toLocaleLowerCase("ja");
    if (!query) {
      return projects.slice(0, 12);
    }

    return projects
      .filter(
        (project) =>
          project.name.toLocaleLowerCase("ja").includes(query) ||
          project.path.toLocaleLowerCase("ja").includes(query),
      )
      .slice(0, 12);
  }, [cwd, projects]);

  const exactProject = projects.find(
    (project) =>
      project.path.toLocaleLowerCase("en-US") ===
      cwd.trim().toLocaleLowerCase("en-US"),
  );
  const pinned = settings.pinned.some(
    (path) =>
      path.toLocaleLowerCase("en-US") ===
      cwd.trim().toLocaleLowerCase("en-US"),
  );

  const start = async (input?: LaunchInput): Promise<void> => {
    const selectedCwd = input?.cwd ?? cwd.trim();
    if (!selectedCwd || starting) {
      return;
    }

    setStarting(true);
    try {
      await onStart(
        input ?? {
          command,
          cwd: selectedCwd,
          projectName: exactProject?.name ?? getProjectNameFromPath(selectedCwd),
          title: sessionName.trim(),
        },
      );
    } finally {
      setStarting(false);
    }
  };

  const browse = async (): Promise<void> => {
    if (browsing) {
      return;
    }

    setBrowseError(undefined);
    setBrowsing(true);
    try {
      const selectedPath = await cockpitApi.pickProjectDirectory();
      if (selectedPath) {
        setCwd(selectedPath);
        setDropdownOpen(false);
      }
    } catch {
      setBrowseError("フォルダ選択ダイアログを開けませんでした。");
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="launcher-shell" data-testid="launcher">
      <form
        className="launcher-card"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="launcher-kicker">
          <TerminalSquare aria-hidden="true" size={16} />
          <span>NEW SESSION</span>
        </div>
        <div className="launcher-heading">
          <div>
            <h1>作業コンソールを起動</h1>
            <p>
              案件フォルダとCLIごとに独立して起動します。判断や承認には介入しません。
            </p>
          </div>
          <button
            aria-label="プロジェクト候補を再スキャン"
            className="icon-button"
            onClick={() => void onRescan()}
            title="再スキャン"
            type="button"
          >
            <RotateCcw aria-hidden="true" size={16} />
          </button>
        </div>

        <label className="field-label" htmlFor="project-path">
          プロジェクト
        </label>
        <div className="project-field-row">
          <div className="project-combobox">
            <Folder aria-hidden="true" className="field-icon" size={16} />
            <input
              aria-autocomplete="list"
              aria-controls="project-options"
              aria-expanded={dropdownOpen}
              autoComplete="off"
              id="project-path"
              onBlur={() => {
                window.setTimeout(() => setDropdownOpen(false), 120);
              }}
              onChange={(event) => {
                setCwd(event.target.value);
                setDropdownOpen(true);
              }}
              onFocus={() => setDropdownOpen(true)}
              placeholder="案件名で検索、または C:/... を直接入力"
              role="combobox"
              spellCheck={false}
              value={cwd}
            />
            <button
              aria-label={pinned ? "ピン留めを解除" : "ピン留め"}
              className={`pin-button ${pinned ? "is-pinned" : ""}`}
              disabled={!cwd.trim()}
              onClick={() => onTogglePin(cwd.trim())}
              title={pinned ? "ピン留めを解除" : "最上部にピン留め"}
              type="button"
            >
              {pinned ? (
                <PinOff aria-hidden="true" size={15} />
              ) : (
                <Pin aria-hidden="true" size={15} />
              )}
            </button>

            {dropdownOpen && (
              <div
                className="project-options"
                id="project-options"
                role="listbox"
              >
                <div className="project-options-header">
                  <Search aria-hidden="true" size={13} />
                  <span>
                    {filteredProjects.length > 0
                      ? `${filteredProjects.length}件の候補`
                      : "候補外のパスを直接使用"}
                  </span>
                </div>
                {filteredProjects.map((project) => (
                  <button
                    aria-selected={project.path === cwd}
                    className="project-option"
                    key={project.path}
                    onClick={() => {
                      setCwd(project.path);
                      setDropdownOpen(false);
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="project-option-main">
                      <span>{project.name}</span>
                      <small>{project.path}</small>
                    </span>
                    <span className={`source-tag source-${project.source}`}>
                      {project.source === "pinned"
                        ? "PIN"
                        : project.source === "recent"
                          ? "RECENT"
                          : project.hasGit || project.hasPackageJson
                            ? "PROJECT"
                            : "FOLDER"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            aria-label="プロジェクトフォルダを参照"
            className="browse-button"
            disabled={browsing}
            onClick={() => void browse()}
            type="button"
          >
            <FolderOpen aria-hidden="true" size={15} />
            {browsing ? "Opening…" : "Browse…"}
          </button>
        </div>

        <div className="launcher-fields-row">
          <label>
            <span className="field-label">CLI</span>
            <select
              aria-label="CLI"
              onChange={(event) =>
                setCommand(event.target.value as CliCommand)
              }
              value={command}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="powershell">PowerShell（空端末）</option>
            </select>
          </label>
          <label>
            <span className="field-label">セッション名</span>
            <input
              aria-label="セッション名"
              maxLength={160}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder="未入力ならCLI名"
              value={sessionName}
            />
          </label>
        </div>

        {(error || browseError) && (
          <p className="launcher-error" role="alert">
            {error || browseError}
          </p>
        )}

        <button
          className="start-button"
          disabled={!cwd.trim() || starting}
          type="submit"
        >
          <Play aria-hidden="true" fill="currentColor" size={16} />
          {starting ? "Starting…" : "Start Session"}
          <kbd>Enter</kbd>
        </button>

        {recent.length > 0 && (
          <div className="recent-launches">
            <div className="recent-heading">
              <Clock3 aria-hidden="true" size={14} />
              <span>最近使った独立セッション</span>
            </div>
            <div className="recent-list">
              {recent.slice(0, 4).map((item) => (
                <button
                  className="recent-item"
                  key={`${item.cwd}-${item.command}-${item.title}`}
                  onClick={() =>
                    void start({
                      command: item.command,
                      cwd: item.cwd,
                      projectName: item.projectName,
                      title: item.title,
                    })
                  }
                  title={`${item.cwd} · ${item.command}`}
                  type="button"
                >
                  <span>{item.projectName}</span>
                  <small>{item.title}</small>
                  <Play aria-hidden="true" size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
