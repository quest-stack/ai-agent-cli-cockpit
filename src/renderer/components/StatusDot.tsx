import { t } from "../../shared/i18n";

import type { SessionStatus } from "../../shared/types";

interface StatusDotProps {
  label?: string;
  status: SessionStatus;
}

const STATUS_LABELS: Readonly<Record<SessionStatus, string>> = {
  busy: t("作業中"),
  error: t("異常終了"),
  exited: t("終了"),
  idle: t("待機（次のタスク）"),
  waiting: t("承認依頼"),
};

export function StatusDot({ label, status }: StatusDotProps) {
  return (
    <span
      aria-label={label ?? STATUS_LABELS[status]}
      className={`status-dot status-${status}`}
      data-status={status}
      role="status"
      title={label ?? STATUS_LABELS[status]}
    />
  );
}
