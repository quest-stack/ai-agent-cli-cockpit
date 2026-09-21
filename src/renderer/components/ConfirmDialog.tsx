import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    // native modalで背面をinertにし、入力やクリックがCLIへ流れないようにする。
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  return (
    <dialog
      aria-describedby="confirm-description"
      aria-labelledby="confirm-title"
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      ref={dialogRef}
    >
      <div className="dialog-icon">
        <AlertTriangle aria-hidden="true" size={19} />
      </div>
      <div>
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-description">{description}</p>
      </div>
      <div className="dialog-actions">
        <button
          className="button-muted"
          onClick={onCancel}
          ref={cancelRef}
          type="button"
        >
          キャンセル
        </button>
        <button className="button-danger" onClick={onConfirm} type="button">
          終了する
        </button>
      </div>
    </dialog>
  );
}
