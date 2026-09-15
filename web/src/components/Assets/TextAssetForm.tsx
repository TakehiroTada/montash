/**
 * テキスト素材の作成・編集（docs/06 §2.6, W-17 手順 3）。
 * 新規は `assets new-text <id> --text ... [--label]`、既存本文の編集は `assets set-text <id> --text ...`。
 */
import { useEffect, useRef, useState } from "react";
import { execCli } from "../../cli-client.ts";
import { type AssetView, formatCommand, isValidAssetId, newTextArgs, setTextArgs } from "../../lib/assets.ts";

export interface TextAssetFormProps {
  /** 指定があれば本文の編集（`assets set-text`）、無ければ新規作成（`assets new-text`） */
  asset?: AssetView;
  /** 編集時の初期本文（`GET /api/assets/:id` の text） */
  initialText?: string;
  onClose(): void;
}

export function TextAssetForm({ asset, initialText = "", onClose }: TextAssetFormProps) {
  const editing = asset !== undefined;
  const [id, setId] = useState(asset?.id ?? "");
  const [label, setLabel] = useState(asset?.label ?? "");
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => (editing ? textRef.current : firstRef.current)?.focus(), [editing]);

  const idError = editing || id === "" ? null : isValidAssetId(id) ? null : "ID は英数字・_ ・- のみ（1〜64 文字）";
  const args = editing ? setTextArgs(asset.id, text) : newTextArgs(id, text, label);
  const ready = !busy && text !== "" && (editing || (id !== "" && idError === null));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const res = await execCli(args);
    setBusy(false);
    if (res.ok) onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "テキスト素材を編集" : "テキスト素材を作成"}
        onClick={(e) => e.stopPropagation()}
      >
        <h4>{editing ? `テキスト素材 ${asset.id} の本文` : "+ テキスト素材"}</h4>

        {editing ? null : (
          <>
            <label className="field">
              <span>ID</span>
              <input
                type="text"
                ref={firstRef}
                value={id}
                placeholder="title_main"
                onChange={(e) => setId(e.target.value)}
              />
            </label>
            {idError ? <p className="err-note">{idError}</p> : null}
            <label className="field">
              <span>ラベル（任意）</span>
              <input type="text" value={label} placeholder="オープニング" onChange={(e) => setLabel(e.target.value)} />
            </label>
          </>
        )}

        <label className="field">
          <span>本文</span>
          <textarea
            rows={6}
            ref={textRef}
            value={text}
            placeholder="Summer Trip 2026"
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        {text !== "" ? <pre>{formatCommand(args)}</pre> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button type="button" className="primary" disabled={!ready} onClick={() => void submit()}>
            {editing ? "本文を更新" : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}
