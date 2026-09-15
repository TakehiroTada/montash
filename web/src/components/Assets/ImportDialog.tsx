/**
 * 「+ 取り込み」ダイアログ（docs/06 §2.6, W-17 手順 2）。
 *
 * - パス入力（glob 可）→ `import <path> --proxy`
 * - ファイルをドロップ／選択 → `POST /api/upload`（保存後サーバが import を発行する）
 *
 * どちらも状態変更は CLI コマンドの発行として行われる（docs/06 §1.1）。
 */
import { type DragEvent, useEffect, useRef, useState } from "react";
import { execCli, uploadAsset } from "../../cli-client.ts";
import { formatCommand, formatSize, importArgs } from "../../lib/assets.ts";
import { useStore } from "../../store.ts";

/** docs/13 A-5: これを超えるファイルはパス指定取り込みを案内する */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export interface ImportDialogProps {
  onClose(): void;
}

export function ImportDialog({ onClose }: ImportDialogProps) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [queued, setQueued] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const jobs = useStore((s) => s.jobs);
  useEffect(() => pathRef.current?.focus(), []);
  const toast = useStore((s) => s.toast);

  const runPathImport = async () => {
    if (path.trim() === "" || busy) return;
    setBusy(true);
    const res = await execCli(importArgs(path));
    setBusy(false);
    if (res.ok) onClose();
  };

  const runUpload = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
    for (const f of tooBig)
      toast(
        "error",
        `${f.name} は ${formatSize(f.size)} で上限 2GB を超えています。\nパスを入力して montash import で取り込んでください。`,
      );
    const sendable = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (sendable.length === 0) return;
    setBusy(true);
    setQueued(sendable);
    let allOk = true;
    // 直列で送る（サーバ側の CLI 実行も直列。docs/06 §3.3）
    for (const file of sendable) {
      const res = await uploadAsset(file);
      allOk &&= res.ok;
      setQueued((q) => q.filter((f) => f !== file));
    }
    setBusy(false);
    if (allOk) onClose();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void runUpload([...e.dataTransfer.files]);
  };

  const activeJobs = jobs.filter((j) => !j.done);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label="素材を取り込む"
        onClick={(e) => e.stopPropagation()}
      >
        <h4>+ 取り込み</h4>

        <label className="field">
          <span>パス（glob 可）</span>
          <input
            type="text"
            ref={pathRef}
            value={path}
            placeholder="/Volumes/SD/DCIM/*.MP4"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runPathImport();
            }}
          />
        </label>
        <p className="hint-note">
          ローカルサーバなのでパス指定が基本です。大きなファイル（2GB 超）は必ずこちらを使ってください。
        </p>
        {path.trim() !== "" ? <pre>{formatCommand(importArgs(path))}</pre> : null}
        <div className="modal-actions">
          <button type="button" disabled={busy || path.trim() === ""} onClick={() => void runPathImport()}>
            このパスを取り込む
          </button>
        </div>

        <hr />

        <div
          className={`dropzone${dragging ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
        >
          ここにファイルをドロップ、またはクリックして選択
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void runUpload([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>
        <p className="hint-note">
          アップロードは <code>assets/incoming/&lt;日付&gt;/</code> に保存してから{" "}
          <code>montash import &lt;保存パス&gt; --proxy</code> を発行します。
        </p>

        {queued.length > 0 ? (
          <ul className="detail-list">
            {queued.map((f) => (
              <li key={f.name}>
                {f.name} <span className="dim">{formatSize(f.size)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {activeJobs.map((j) => (
          <div key={j.id} className="progress" title={j.message ?? j.kind}>
            <div className="bar" style={{ width: `${Math.max(3, Math.min(100, j.percent))}%` }} />
            <span>
              {j.kind} {Math.round(j.percent)}% {j.message ?? ""}
            </span>
          </div>
        ))}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
