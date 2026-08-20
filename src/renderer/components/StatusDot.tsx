import type { SessionStatus } from "../../shared/types";

interface StatusDotProps {
  label?: string;
  status: SessionStatus;
}

const STATUS_LABELS: Readonly<Record<SessionStatus, string>> = {
  busy: "作業中",
  error: "異常終了",
  exited: "終了",
  idle: "待機（次のタスク）",
  waiting: "承認依頼",
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
