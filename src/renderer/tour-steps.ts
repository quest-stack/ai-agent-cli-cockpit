

import { t } from "../shared/i18n";export const TOUR_STEPS = [
  {
    body: [
      t("Claude Code / Codex のセッションを1つの画面にまとめて動かせます。"),
      t("セッション内容の送信やテレメトリはありません。設定はこのPC内に保存され、更新の有無だけを確認します。"),
    ],
    id: "welcome",
    target: null,
    title: t("ようこそ"),
  },
  {
    body: [
      t("New Session からフォルダとCLI（claude / codex / powershell）を選んで起動します。"),
      t("フォルダはダイアログでも、パスの直接入力でも指定できます。"),
    ],
    id: "new-session",
    target: "new-session",
    title: t("セッションを作る"),
  },
  {
    body: [
      t("Ctrl+Shift+T で新しいタブ、Ctrl+Shift+D で左右分割します。"),
      t("Ctrl+Shift+E で上下分割、Alt+矢印でペイン間を移動できます。"),
    ],
    id: "tabs-and-panes",
    target: "tab-bar",
    title: t("タブとペインで並べる"),
  },
  {
    body: [
      t("セッション名の横の色で状態が分かります。青=待機、黄=作業中、赤=承認依頼、グレー=終了です。"),
      t("赤（承認依頼）はこちらの操作が必要な状態で、Windows通知でもお知らせします。ベルのアイコンでオン／オフできます。"),
    ],
    id: "status-lights",
    target: "session-list",
    title: t("状態をランプで見る"),
  },
  {
    body: [
      t("画面が真っ黒になったり文字が欠けたりしても、アプリが自動で直します。すぐ直したいときは Ctrl+Shift+R を押してください。CLI には何も送らないので、作業中でも安全です。"),
      t("タイトルバーの「?」ボタン（または F1）で、ショートカット一覧といつでも見返せます。"),
      t("このツアーは設定（歯車）の「使い方ツアーを見る」からいつでも見直せます。"),
    ],
    id: "help",
    target: "settings",
    title: t("困ったときは"),
  },
] as const;

export interface TourProgress {
  completed: boolean;
  stepIndex: number;
}

function getLastStepIndex(totalSteps: number): number {
  return Math.max(0, Math.trunc(totalSteps) - 1);
}

function normalizeStepIndex(stepIndex: number, totalSteps: number): number {
  return Math.max(0, Math.min(Math.trunc(stepIndex), getLastStepIndex(totalSteps)));
}

export function createTourProgress(): TourProgress {
  return {
    completed: false,
    stepIndex: 0,
  };
}

export function isLastTourStep(
  stepIndex: number,
  totalSteps = TOUR_STEPS.length,
): boolean {
  return normalizeStepIndex(stepIndex, totalSteps) === getLastStepIndex(totalSteps);
}

export function advanceTour(
  progress: TourProgress,
  totalSteps = TOUR_STEPS.length,
): TourProgress {
  const stepIndex = normalizeStepIndex(progress.stepIndex, totalSteps);
  if (isLastTourStep(stepIndex, totalSteps)) {
    return {
      completed: true,
      stepIndex,
    };
  }

  return {
    completed: false,
    stepIndex: stepIndex + 1,
  };
}

export function retreatTour(
  progress: TourProgress,
  totalSteps = TOUR_STEPS.length,
): TourProgress {
  return {
    completed: false,
    stepIndex: Math.max(
      0,
      normalizeStepIndex(progress.stepIndex, totalSteps) - 1,
    ),
  };
}

export function skipTour(progress: TourProgress): TourProgress {
  return {
    ...progress,
    completed: true,
  };
}
