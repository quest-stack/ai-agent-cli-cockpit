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
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  getDefaultSessionTitle,
  getProjectNameFromPath,
  resolveInitialLauncherCwd,
} from "../../shared/session-labels";

import { cockpitApi } from "../bridge";
import { normalizeShellCommand } from "../../shared/platform";

import { t } from "../../shared/i18n";
import { createCliLaunchCommand, getCliKind } from "../../shared/cli-launch";
import { enrichRecentConversations, getRecentConversationCommand, getRecordedResumeTargets, sameConversationDirectory } from "../../shared/recent-conversations";
import type { CliLaunchMode } from "../../shared/cli-launch";
import type { ProviderConversation } from "../../shared/provider-conversation";

import type {
  AppSettings,
  CliCommand,
  ProjectCandidate,
  RecentSession,
  SessionState,
} from "../../shared/types";

export interface LaunchInput {
  command: string;
  conversation?: ProviderConversation;
  cwd: string;
  projectName: string;
  title: string;
}

interface LauncherProps {
  error?: string;
  onRescan: () => Promise<void>;
  onSelectCommand: (command: CliCommand) => void;
  onStart: (input: LaunchInput) => Promise<void>;
  onTogglePin: (path: string) => void;
  projects: ProjectCandidate[];
  recent: RecentSession[];
  sessions: SessionState[];
  settings: AppSettings;
}

export function Launcher({
  error,
  onRescan,
  onSelectCommand,
  onStart,
  onTogglePin,
  projects,
  recent,
  sessions,
  settings,
}: LauncherProps) {
  const command = normalizeShellCommand(settings.defaultCommand, cockpitApi.platform);
  const commandGroupId = useId();
  const launchModeGroupId = useId();
  const [launchMode, setLaunchMode] = useState<CliLaunchMode>("new");
  const commands: { value: CliCommand; label: string }[] = [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    cockpitApi.platform === "darwin"
      ? { value: "shell", label: "Shell" }
      : { value: "powershell", label: "PowerShell" },
  ];
  const [browseError, setBrowseError] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
  const [cwd, setCwd] = useState(() =>
    resolveInitialLauncherCwd(recent, projects),
  );
  const cwdEditedByUser = useRef(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [starting, setStarting] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState("");
  const rememberedRecent = useMemo(() => enrichRecentConversations(recent, sessions), [recent, sessions]);
  const resumeTargets = useMemo(() => getRecordedResumeTargets(recent, sessions)
    .filter(item => getCliKind(item.command) === command && sameConversationDirectory(item.cwd, cwd.trim())), [recent, sessions, command, cwd]);
  const resumeTarget = resumeTargets.find(item => item.conversation?.id.toLowerCase() === selectedConversation) ?? resumeTargets[0];
  useEffect(() => {
    if (launchMode === "resume" && resumeTarget && !resumeTargets.some(item => item.conversation?.id.toLowerCase() === selectedConversation)) {
      setSelectedConversation(resumeTarget.conversation!.id.toLowerCase());
    }
  }, [launchMode, resumeTarget, resumeTargets, selectedConversation]);

  useEffect(() => {
    if (cwd || cwdEditedByUser.current) {
      return;
    }
    // 起動直後は projects / recent がまだ空のことがある。空欄のままに
    // ならないよう、届いた時点で同じ規則で埋め直す。
    // 利用者が編集した後の空欄は維持し、履歴を再入力しない。
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
    if (!input && launchMode === "resume" && (command === "claude" || command === "codex") && !resumeTarget) return;

    setStarting(true);
    try {
      const recentCommand = commands.find((item) => item.value === getCliKind(input?.command));
      if (recentCommand) onSelectCommand(recentCommand.value);
      await onStart(
        input ?? {
          command: launchMode === "resume" && resumeTarget ? getRecentConversationCommand(resumeTarget)! : createCliLaunchCommand(command, launchMode),
          ...(launchMode === "resume" && resumeTarget?.conversation ? { conversation: resumeTarget.conversation } : {}),
          cwd: selectedCwd,
          projectName: exactProject?.name ?? getProjectNameFromPath(selectedCwd),
          title: sessionName.trim() || (launchMode === "resume" ? resumeTarget?.title ?? "" : ""),
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
        cwdEditedByUser.current = true;
        setCwd(selectedPath);
        setDropdownOpen(false);
      }
    } catch {
      setBrowseError(t("フォルダ選択ダイアログを開けませんでした。"));
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
            <h1>{t("作業コンソールを起動")}</h1>
            <p>{t("案件フォルダとCLIごとに独立して起動します。判断や承認には介入しません。")}</p>
          </div>
          <button
            aria-label={t("プロジェクト候補を再スキャン")}
            className="icon-button"
            onClick={() => void onRescan()}
            title={t("再スキャン")}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={16} />
          </button>
        </div>

        <label className="field-label" htmlFor="project-path">{t("プロジェクト")}</label>
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
                cwdEditedByUser.current = true;
                setCwd(event.target.value);
                setDropdownOpen(true);
              }}
              onFocus={() => setDropdownOpen(true)}
              placeholder={t("案件名で検索、または C:/... を直接入力")}
              role="combobox"
              spellCheck={false}
              value={cwd}
            />
            <button
              aria-label={pinned ? t("ピン留めを解除") : t("ピン留め")}
              className={`pin-button ${pinned ? "is-pinned" : ""}`}
              disabled={!cwd.trim()}
              onClick={() => onTogglePin(cwd.trim())}
              title={pinned ? t("ピン留めを解除") : t("最上部にピン留め")}
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
                      ? t("{value0}件の候補", { value0: filteredProjects.length })
                      : t("候補外のパスを直接使用")}
                  </span>
                </div>
                {filteredProjects.map((project) => (
                  <button
                    aria-selected={project.path === cwd}
                    className="project-option"
                    key={project.path}
                    onClick={() => {
                      cwdEditedByUser.current = true;
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
            aria-label={t("プロジェクトフォルダを参照")}
            className="browse-button"
            disabled={browsing}
            onClick={() => void browse()}
            type="button"
          >
            <FolderOpen aria-hidden="true" size={15} />
            {browsing ? "Opening…" : "Browse…"}
          </button>
        </div>

        <fieldset className="cli-picker">
          <legend className="field-label">CLI</legend>
          <div className="cli-options">
            {commands.map((item) => (
              <label className="cli-option" key={item.value}>
                <input
                  checked={command === item.value}
                  data-testid={`cli-option-${item.value}`}
                  name={commandGroupId}
                  onChange={() => onSelectCommand(item.value)}
                  type="radio"
                  value={item.value}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
          <p className="cli-picker-note">{t("前回の選択を次回も使います")}</p>
        </fieldset>
        {(command === "claude" || command === "codex") && <fieldset className="cli-picker" data-testid="launch-mode-picker">
          <legend className="field-label">{t("セッションの開始方法")}</legend>
          <div className="cli-options launch-mode-options">
            {([
              { value: "new", label: t("新規セッションを開始"), description: t("選択したフォルダで、新しくCLIを起動します") },
              { value: "resume", label: t("会話を再開（resume）"), description: t("選んだ会話に、起動ボタンで直接戻ります") },
              { value: "continue", label: t("直近のセッションを再開"), description: t("選択したフォルダの直近の履歴を、そのまま再開します") },
            ] as const).map((item) => <label className="cli-option launch-mode-option" key={item.value}>
              <input aria-describedby={`${launchModeGroupId}-${item.value}`} aria-label={item.label}
                checked={launchMode === item.value} data-testid={`launch-mode-${item.value}`} name={launchModeGroupId}
                onChange={() => setLaunchMode(item.value)} type="radio" value={item.value} />
              <span><strong>{item.label}</strong><small id={`${launchModeGroupId}-${item.value}`}>{item.description}</small></span>
            </label>)}
          </div>
          {launchMode === "resume" && <div className="resume-target-field">
            {resumeTargets.length > 0 ? <label>
              <span className="field-label">{t("再開する会話")}</span>
              <select aria-label={t("再開する会話")} data-testid="resume-conversation" value={resumeTarget?.conversation?.id.toLowerCase() ?? ""}
                onChange={event => setSelectedConversation(event.target.value)}>
                {resumeTargets.map(item => <option key={item.conversation!.id.toLowerCase()} value={item.conversation!.id.toLowerCase()}>{item.title} · {item.projectName}</option>)}
              </select>
            </label> : <p className="cli-picker-note">{t("記録済みの会話がありません。履歴一覧から一度選ぶと、次回から直接再開できます。")}</p>}
          </div>}
          <button className="browse-button" data-testid="launch-history-picker" disabled={starting || !cwd.trim()} type="button"
            onClick={() => void start({ command: createCliLaunchCommand(command, "resume"), cwd: cwd.trim(), projectName: exactProject?.name ?? getProjectNameFromPath(cwd.trim()), title: sessionName.trim() })}>
            {t("CLIの履歴一覧を開く")}
          </button>
        </fieldset>}
        <div className="launcher-fields-row">
          <label>
            <span className="field-label">{t("セッション名")}</span>
            <input
              aria-label={t("セッション名")}
              maxLength={160}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder={t("未入力ならCLI名")}
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
          disabled={!cwd.trim() || starting || (launchMode === "resume" && (command === "claude" || command === "codex") && !resumeTarget)}
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
              <span>{t("最近のセッション")}</span>
            </div>
            <p className="cli-picker-note">{t("同じフォルダで新規起動するか、元の会話へ直接戻れます")}</p>
            <div className="recent-list">
              {rememberedRecent.slice(0, 4).map((item, index) => {
                const cli = getCliKind(item.command);
                const newCommand = cli ?? item.command;
                const canResume = cli === "claude" || cli === "codex";
                const resumeCommand = getRecentConversationCommand(item);
                return <div className="recent-entry" key={item.sessionId ?? `${item.cwd}-${item.command}-${item.title}-${item.lastUsedAt}`}>
                <button
                  className="recent-item"
                  onClick={() =>
                    void start({
                      command: newCommand,
                      cwd: item.cwd,
                      projectName: item.projectName,
                      title: item.title,
                    })
                  }
                  title={`${item.cwd} · ${newCommand}`}
                  type="button"
                >
                  <span>{item.title.trim() || getDefaultSessionTitle(item.command)}</span>
                  <small>{item.projectName}</small>
                  <Play aria-hidden="true" size={13} />
                  <em>{cli ? t("同じフォルダで新規起動") : t("同じ設定で起動")}</em>
                </button>
                {canResume && <button className="recent-resume" data-testid={`recent-resume-${index}`}
                  aria-label={t("{value0}の会話を再開", { value0: item.title.trim() || item.projectName })}
                  title={resumeCommand ? t("元の会話を直接再開します") : t("この会話の記録がありません。CLIの履歴一覧から選んでください。")}
                  disabled={starting || !resumeCommand} onClick={() => { if (resumeCommand && item.conversation) void start({ command: resumeCommand, conversation: item.conversation, cwd: item.cwd,
                    projectName: item.projectName, title: item.title }); }} type="button">{t("会話を再開（resume）")}</button>}
                </div>;
              })}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
