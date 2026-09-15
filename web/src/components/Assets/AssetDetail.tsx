/**
 * 選択素材の詳細（docs/06 §2.6）。
 *
 * - 単体プレビュー（動画・音声はプロキシか原本、画像は `<img>`、テキストは本文、字幕は先頭数行）
 * - メタデータ（probe 要約）と使用箇所一覧（クリックで編集タイムラインの該当クリップを選択）
 * - ラベル／タグ／色（`assets set`）、削除（`assets remove`）、再リンク（`assets relink`）、
 *   プロキシ再生成（`proxy build --force`）— すべて `POST /api/cli` 経由
 * - 「タイムラインへ追加」は実行せず CLI 例を出してコピーさせる（docs/06 §1.2）
 */
import { useEffect, useState } from "react";
import { execCli } from "../../cli-client.ts";
import {
  type AssetView,
  assetsSetArgs,
  displayName,
  formatCommand,
  formatDuration,
  formatFps,
  formatProxy,
  formatSize,
  formatSpec,
  previewSource,
  proxyBuildArgs,
  relinkArgs,
  removeArgs,
  timelineExamples,
  typeIcon,
} from "../../lib/assets.ts";
import { useStore } from "../../store.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { AssetDerived } from "./AssetDerived.tsx";
import { TextAssetForm } from "./TextAssetForm.tsx";

interface DetailResponse {
  asset: AssetView;
  text?: string;
  text_truncated?: boolean;
  probe?: unknown;
}

const copy = (value: string): void => void navigator.clipboard?.writeText(value);

/** 字幕は先頭数行だけ見せる */
function headLines(text: string, lines = 8): string {
  return text.split(/\r?\n/).slice(0, lines).join("\n");
}

export function AssetDetail({ asset }: { asset: AssetView }) {
  const playhead = useStore((s) => s.playhead_f);
  const readOnly = useStore((s) => s.status?.server.read_only ?? false);
  const setSelection = useStore((s) => s.setSelection);
  const setTab = useStore((s) => s.setTab);

  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [label, setLabel] = useState(asset.label ?? "");
  const [tags, setTags] = useState(asset.tags.join(","));
  const [color, setColor] = useState(asset.color ?? "");
  const [relinkPath, setRelinkPath] = useState("");
  const [relinkSearch, setRelinkSearch] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editText, setEditText] = useState(false);
  const [busy, setBusy] = useState(false);

  // 選択（や外部からの更新）が来たら編集中の値を選択素材のものに戻す
  // biome-ignore lint/correctness/useExhaustiveDependencies: asset.id の変化＝選択の切り替えを検知する
  useEffect(() => {
    setLabel(asset.label ?? "");
    setTags(asset.tags.join(","));
    setColor(asset.color ?? "");
    setRelinkPath("");
    setRelinkSearch("");
  }, [asset.id, asset.label, asset.tags, asset.color]);

  // 本文・probe はリストに載っていないので詳細だけ別途取得する
  useEffect(() => {
    let alive = true;
    setDetail(null);
    void fetch(`/api/assets/${encodeURIComponent(asset.id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<DetailResponse>) : null))
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        /* 詳細が取れなくても一覧の情報だけで描ける */
      });
    return () => {
      alive = false;
    };
  }, [asset.id]);

  const run = async (args: string[], opts: { confirm?: boolean } = {}) => {
    setBusy(true);
    const res = await execCli(args, opts);
    setBusy(false);
    return res;
  };

  const saveMetadata = () => {
    const args = assetsSetArgs(asset.id, { label, tags, color }, asset);
    if (args) void run(args);
  };

  const preview = previewSource(asset);
  const usage = asset.usage.clips;
  const disabled = readOnly || busy;

  return (
    <div className="asset-detail">
      <h3>
        <span className="icon">{typeIcon(asset.type)}</span> {asset.id}
        {asset.missing ? <span className="badge err">⚠ 欠落</span> : null}
      </h3>

      {/* --- 単体プレビュー --- */}
      <div className="asset-preview">
        {preview.kind === "video" && preview.src ? <video src={preview.src} controls preload="metadata" /> : null}
        {preview.kind === "audio" && preview.src ? <audio src={preview.src} controls preload="metadata" /> : null}
        {preview.kind === "image" && preview.src ? <img src={preview.src} alt={displayName(asset)} /> : null}
        {preview.kind === "text" ? (
          <pre className="text-preview">
            {detail?.text === undefined
              ? (asset.text_preview ?? "（本文を読み込み中）")
              : asset.type === "subtitle"
                ? headLines(detail.text)
                : detail.text}
          </pre>
        ) : null}
        {preview.kind === "none" ? (
          <p className="placeholder-note">ファイルが見つからないためプレビューできません。</p>
        ) : null}
      </div>
      {preview.src && preview.original && (asset.type === "video" || asset.type === "audio") ? (
        <p className="hint-note">プロキシが無いため原本を再生しています。</p>
      ) : null}

      {/* --- メタデータ --- */}
      <dl className="kv">
        <dt>type</dt>
        <dd>{asset.type}</dd>
        <dt>label</dt>
        <dd>{asset.label ?? "—"}</dd>
        <dt>duration</dt>
        <dd>
          {formatDuration(asset.duration_s)}
          {asset.duration_f ? ` / f:${asset.duration_f}` : ""}
        </dd>
        <dt>spec</dt>
        <dd>{formatSpec(asset) || "—"}</dd>
        {asset.video?.codec || asset.audio?.codec ? (
          <>
            <dt>codec</dt>
            <dd>{[asset.video?.codec, asset.audio?.codec].filter(Boolean).join(" / ")}</dd>
          </>
        ) : null}
        {asset.video?.fps ? (
          <>
            <dt>fps</dt>
            <dd>{formatFps(asset.video.fps)}</dd>
          </>
        ) : null}
        <dt>size</dt>
        <dd>{formatSize(asset.size)}</dd>
        <dt>proxy</dt>
        <dd>{formatProxy(asset) || "—"}</dd>
        <dt>path</dt>
        <dd className="path" title={asset.path}>
          {asset.path}
        </dd>
        {asset.imported_at ? (
          <>
            <dt>imported</dt>
            <dd>
              {asset.imported_at.slice(0, 19).replace("T", " ")}
              {asset.imported_by ? ` (${asset.imported_by})` : ""}
            </dd>
          </>
        ) : null}
      </dl>

      {/* --- サムネイルストリップ・波形（docs/06 §2.6） --- */}
      <AssetDerived asset={asset} />

      {/* --- 使用箇所 --- */}
      <h3>使用箇所 ({usage.length})</h3>
      {usage.length === 0 ? (
        <p className="placeholder-note">
          <span className="badge">未使用</span> どのクリップからも参照されていません。
        </p>
      ) : (
        <ul className="list">
          {usage.map((u) => (
            <li key={u.clip_id}>
              <button
                type="button"
                className="link"
                title="編集タイムラインでこのクリップを選択"
                onClick={() => {
                  setSelection({ kind: "clip", id: u.clip_id, trackId: u.track });
                  setTab("inspector");
                }}
              >
                {u.clip_id} ({u.track})
              </button>
              <span className="dim">
                f:{u.start_f}–{u.end_f}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* --- タイムラインへ追加（実行はしない。CLI 例をコピー） --- */}
      <h3>タイムラインへ追加（CLI 例）</h3>
      <p className="hint-note">タイムライン編集は CLI の領分です。コピーして AI に渡してください。</p>
      <ul className="list">
        {timelineExamples(asset, playhead).map((ex) => (
          <li key={ex}>
            <code style={{ flex: 1 }}>{ex}</code>
            <button type="button" onClick={() => copy(ex)}>
              copy
            </button>
          </li>
        ))}
      </ul>

      {/* --- メタデータ編集 --- */}
      <h3>ラベル・タグ・色</h3>
      <label className="field">
        <span>ラベル</span>
        <input type="text" value={label} disabled={disabled} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="field">
        <span>タグ（カンマ区切り）</span>
        <input type="text" value={tags} disabled={disabled} onChange={(e) => setTags(e.target.value)} />
      </label>
      <label className="field">
        <span>色</span>
        <input
          type="text"
          value={color}
          placeholder="#3B82F6"
          disabled={disabled}
          onChange={(e) => setColor(e.target.value)}
        />
      </label>
      <div className="btn-row">
        <button
          type="button"
          className="primary"
          disabled={disabled || assetsSetArgs(asset.id, { label, tags, color }, asset) === null}
          onClick={saveMetadata}
        >
          assets set を実行
        </button>
        {asset.type === "text" && asset.owned ? (
          <button type="button" disabled={disabled} onClick={() => setEditText(true)}>
            本文を編集
          </button>
        ) : null}
      </div>

      {/* --- 再リンク --- */}
      {asset.missing ? (
        <>
          <h3>再リンク</h3>
          <label className="field">
            <span>新しいパス</span>
            <input
              type="text"
              value={relinkPath}
              placeholder="/Volumes/ext/raw/clip_c.mp4"
              disabled={disabled}
              onChange={(e) => setRelinkPath(e.target.value)}
            />
          </label>
          <div className="btn-row">
            <button
              type="button"
              disabled={disabled || relinkPath.trim() === ""}
              onClick={() => void run(relinkArgs(asset.id, { path: relinkPath }))}
            >
              このパスに繋ぎ直す
            </button>
          </div>
          <label className="field">
            <span>フォルダから探す</span>
            <input
              type="text"
              value={relinkSearch}
              placeholder="/Volumes/ext/raw"
              disabled={disabled}
              onChange={(e) => setRelinkSearch(e.target.value)}
            />
          </label>
          <div className="btn-row">
            <button
              type="button"
              disabled={disabled || relinkSearch.trim() === ""}
              onClick={() => void run(relinkArgs(asset.id, { search: relinkSearch }))}
            >
              フォルダを検索して再リンク
            </button>
          </div>
        </>
      ) : null}

      {/* --- 派生物と削除 --- */}
      <h3>操作</h3>
      <div className="btn-row">
        {asset.type === "video" || asset.type === "audio" ? (
          <button
            type="button"
            disabled={disabled || asset.missing}
            title={formatCommand(proxyBuildArgs(asset.id))}
            onClick={() => void run(proxyBuildArgs(asset.id), { confirm: true })}
          >
            プロキシ再生成
          </button>
        ) : null}
        <button type="button" className="danger" disabled={disabled} onClick={() => setConfirmRemove(true)}>
          削除
        </button>
      </div>

      {confirmRemove ? (
        <ConfirmDialog
          title={`素材 ${asset.id} を削除しますか？`}
          message={
            usage.length > 0
              ? `この素材は ${usage.length} 件のクリップから参照されています。\n--force を付けると、参照しているクリップとトランジションも一緒に削除されます。`
              : "この素材はどのクリップからも参照されていません。"
          }
          details={usage.map((u) => `${u.clip_id} (${u.track}) f:${u.start_f}–${u.end_f}`)}
          command={formatCommand(removeArgs(asset.id, usage.length > 0))}
          confirmLabel={usage.length > 0 ? "クリップごと削除" : "削除"}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            void run(removeArgs(asset.id, usage.length > 0), { confirm: true });
          }}
        />
      ) : null}

      {editText ? (
        <TextAssetForm asset={asset} initialText={detail?.text ?? ""} onClose={() => setEditText(false)} />
      ) : null}
    </div>
  );
}
