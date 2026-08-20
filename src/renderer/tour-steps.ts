export const TOUR_STEPS = [
  {
    body: [
      "Claude Code / Codex のセッションを1つの画面にまとめて動かせます。",
      "通信・テレメトリは一切なく、設定はこのPC内だけに保存されます。",
    ],
    id: "welcome",
    target: null,
    title: "ようこそ",
  },
  {
    body: [
      "New Session からフォルダとCLI（claude / codex / powershell）を選んで起動します。",
      "フォルダはダイアログでも、パスの直接入力でも指定できます。",
    ],
    id: "new-session",
    target: "new-session",
    title: "セッションを作る",
  },
  {
    body: [
      "Ctrl+Shift+T で新しいタブ、Ctrl+Shift+D で左右分割します。",
      "Ctrl+Shift+E で上下分割、Alt+矢印でペイン間を移動できます。",
    ],
    id: "tabs-and-panes",
    target: "tab-bar",
    title: "タブとペインで並べる",
  },
  {
    body: [
      "セッション名の横の色で状態が分かります。青=待機、黄=作業中、赤=承認依頼、グレー=終了です。",
      "赤（承認依頼）はこちらの操作が必要な状態で、Windows通知でもお知らせします。ベルのアイコンでオン／オフできます。",
    ],
    id: "status-lights",
    target: "session-list",
    title: "状態をランプで見る",
  },
  {
    body: [
      "画面が真っ黒になったり文字が欠けたりしても、アプリが自動で直します。すぐ直したいときは Ctrl+Shift+R を押してください。CLI には何も送らないので、作業中でも安全です。",
      "タイトルバーの「?」ボタン（または F1）で、ショートカット一覧といつでも見返せます。",
      "このツアーは設定（歯車）の「使い方ツアーを見る」からいつでも見直せます。",
    ],
    id: "help",
    target: "settings",
    title: "困ったときは",
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
