/**
 * 確認ダイアログ（docs/06 §2.6「削除・--force・再リンクの一括は確認ダイアログを挟む」）。
 * `window.confirm` と違い、参照クリップ一覧のような明細を見せられる。
 */
import { useEffect, useRef } from "react";

export interface ConfirmDialogProps {
  title: string;
  /** 本文。行ごとに段落として描く */
  message: string;
  /** 明細（削除される参照クリップなど）。空なら描かない */
  details?: string[];
  /** 実行されるコマンド（`montash ...`）。破壊的操作の可視化に使う */
  command?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { title, message, details = [], command, confirmLabel = "実行", danger = true, onConfirm, onCancel } = props;
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h4>{title}</h4>
        {message.split("\n").map((line) => (
          <p key={line}>{line}</p>
        ))}
        {details.length > 0 ? (
          <ul className="detail-list">
            {details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
        {command ? <pre>{command}</pre> : null}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="button" ref={okRef} className={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
