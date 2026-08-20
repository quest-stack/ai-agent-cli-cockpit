import type { PersistedWorkspace } from "./types";

interface SessionLabelInput {
  command: string;
  projectName: string;
  title: string;
}

interface RenamableSession {
  id: string;
  title: string;
}

/**
 * ピン留めした項目が先に並ぶよう、候補リストを並べ替える。
 *
 * ピン留めは source を書き換えるだけでは足りない。並びが動かないため、
 * 留めた場所が一覧の途中に居座り、先頭には別のフォルダが残る。
 * ランチャーの初期値が先頭を見ていた頃は、これが「何回ピン留めしても
 * 効かない」という形で現れていた。
 *
 * ピン留め同士の順番は保つ。留めるたびに並びが変わると、どれが先頭か
 * 予測できなくなる。
 */
export function sortPinnedFirst<T extends { source: string }>(
  projects: readonly T[],
): T[] {
  return [
    ...projects.filter((project) => project.source === "pinned"),
    ...projects.filter((project) => project.source !== "pinned"),
  ];
}

/**
 * ランチャーの作業フォルダ欄に最初から入れておくパスを決める。
 *
 * 以前はピン留めの先頭（projects[0]）を無条件に入れていた。そのため
 * 「いつも使うフォルダ」と違う場所が毎回入り、利用者が毎回打ち直す
 * ことになっていた。しかも打ち直した内容はどこにも残らないので、
 * 次の起動でまた同じ場所に戻る。
 *
 * 最後に起動したフォルダを既定にする。それが利用者の意図に一番近く、
 * 「直したら次から固定される」という当たり前の挙動になる。
 * 履歴が無い初回だけ、従来どおり候補の先頭にする。
 */
export function resolveInitialLauncherCwd(
  recent: readonly { cwd: string }[],
  projects: readonly { path: string }[],
): string {
  return recent[0]?.cwd ?? projects[0]?.path ?? "";
}

/**
 * パスの末尾からプロジェクト名を作る。
 *
 * ランチャーからの起動と、受付フォルダ経由の起動で同じ名前になるよう
 * ここに置いている。
 */
export function getProjectNameFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").at(-1) || "Session";
}

export function getDefaultSessionTitle(command: string): string {
  if (command === "claude") {
    return "Claude";
  }
  if (command === "codex") {
    return "Codex";
  }
  if (command === "powershell") {
    return "PowerShell";
  }
  return "Terminal";
}

export function normalizeLegacySessionTitle<T extends SessionLabelInput>(
  session: T,
): T {
  const prefix = `${session.projectName} #`;
  const suffix = session.title.startsWith(prefix)
    ? session.title.slice(prefix.length)
    : "";

  if (!/^[1-9]\d*$/u.test(suffix)) {
    return session;
  }

  return {
    ...session,
    title: getDefaultSessionTitle(session.command),
  };
}

export function renameSessionTitle<T extends RenamableSession>(
  sessions: T[],
  sessionId: string,
  requestedTitle: string,
): T[] {
  const title = requestedTitle.trim();
  if (!title) {
    return sessions;
  }

  let changed = false;
  const renamed = sessions.map((session) => {
    if (session.id !== sessionId || session.title === title) {
      return session;
    }

    changed = true;
    return {
      ...session,
      title,
    };
  });

  return changed ? renamed : sessions;
}

export function normalizeWorkspaceSessionTitles(
  workspace: PersistedWorkspace,
): PersistedWorkspace {
  return {
    ...workspace,
    recent: workspace.recent.map(normalizeLegacySessionTitle),
    sessions: workspace.sessions.map(normalizeLegacySessionTitle),
  };
}
