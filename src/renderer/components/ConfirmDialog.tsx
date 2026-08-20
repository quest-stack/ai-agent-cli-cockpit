import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
}

export function ConfirmDialog({
  description,
  onCancel,
  onConfirm,
  title,
}: ConfirmDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-describedby="confirm-description"
        aria-labelledby="confirm-title"
        aria-modal="true"
        className="confirm-dialog"
        role="dialog"
      >
        <div className="dialog-icon">
          <AlertTriangle aria-hidden="true" size={19} />
        </div>
        <div>
          <h2 id="confirm-title">{title}</h2>
          <p id="confirm-description">{description}</p>
        </div>
        <div className="dialog-actions">
          <button className="button-muted" onClick={onCancel} type="button">
            キャンセル
          </button>
          <button className="button-danger" onClick={onConfirm} type="button">
            終了する
          </button>
        </div>
      </div>
    </div>
  );
}
