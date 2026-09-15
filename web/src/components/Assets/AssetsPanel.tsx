/**
 * Assets タブ本体（docs/06 §2.6, W-17）。
 * 一覧（グリッド／リスト）・種別フィルタ・検索・並び替えと、取り込み／テキスト素材作成の入口。
 * 行を選ぶと下に AssetDetail を出す。
 */
import { useState } from "react";
import {
  ASSET_TYPES,
  type AssetView,
  filterAssets,
  formatDuration,
  formatProxy,
  formatSpec,
  formatUsage,
  sortAssets,
  TYPE_LABELS,
  typeIcon,
} from "../../lib/assets.ts";
import { useStore } from "../../store.ts";
import { AssetDetail } from "./AssetDetail.tsx";
import { ImportDialog } from "./ImportDialog.tsx";
import { TextAssetForm } from "./TextAssetForm.tsx";

const SORTS: Array<{ id: "name" | "duration" | "imported"; label: string }> = [
  { id: "name", label: "名前" },
  { id: "duration", label: "尺" },
  { id: "imported", label: "取込日" },
];

function AssetRow({ asset, selected, onSelect }: { asset: AssetView; selected: boolean; onSelect(): void }) {
  const usage = formatUsage(asset.usage.clips);
  const proxy = formatProxy(asset);
  return (
    <li className={`asset-row${selected ? " selected" : ""}${asset.missing ? " missing" : ""}`}>
      <button type="button" className="asset-hit" aria-pressed={selected} onClick={onSelect}>
        <span className="icon" style={asset.color ? { color: asset.color } : undefined}>
          {asset.missing ? "⚠" : typeIcon(asset.type)}
        </span>
        <span className="main">
          <span className="line1">
            <span className="id">{asset.id}</span>
            {asset.label ? <span className="label">{asset.label}</span> : null}
            <span className="dim">{asset.type}</span>
            <span className="dim">{formatDuration(asset.duration_s)}</span>
            <span className="dim">{formatSpec(asset)}</span>
          </span>
          <span className="line2">
            {asset.missing ? <span className="err">ファイルが見つかりません</span> : null}
            {proxy ? <span className="dim">{proxy}</span> : null}
            {usage ? <span className="dim">使用: {usage}</span> : <span className="badge">未使用</span>}
            {asset.tags.length > 0 ? <span className="dim">タグ: {asset.tags.join(", ")}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export function AssetsPanel() {
  const assets = useStore((s) => s.assets);
  const ui = useStore((s) => s.assetsUi);
  const patch = useStore((s) => s.patchAssetsUi);
  const selectedId = useStore((s) => s.selectedAssetId);
  const select = useStore((s) => s.selectAsset);
  const readOnly = useStore((s) => s.status?.server.read_only ?? false);
  // セレクタは毎回新しい配列を返してはいけない（zustand が無限ループする）
  const allJobs = useStore((s) => s.jobs);

  const [showImport, setShowImport] = useState(false);
  const [showNewText, setShowNewText] = useState(false);

  const all = assets ?? [];
  const shown = sortAssets(filterAssets(all, { type: ui.type, query: ui.query }), ui.sort);
  const selected = all.find((a) => a.id === selectedId) ?? null;
  const missingCount = all.filter((a) => a.missing).length;
  const jobs = allJobs.filter((j) => !j.done);

  return (
    <div className="assets-panel">
      <div className="assets-toolbar">
        <button type="button" disabled={readOnly} onClick={() => setShowImport(true)}>
          + 取り込み
        </button>
        <button type="button" disabled={readOnly} onClick={() => setShowNewText(true)}>
          + テキスト素材
        </button>
        <input
          type="search"
          className="search"
          value={ui.query}
          placeholder="🔍 ID・ラベル・タグ・ファイル名"
          onChange={(e) => patch({ query: e.target.value })}
        />
      </div>

      <div className="assets-filters">
        <div className="chips">
          <span className="dim">種別:</span>
          {ASSET_TYPES.map((t) => (
            <button
              type="button"
              key={t}
              className={ui.type === t ? "chip active" : "chip"}
              aria-pressed={ui.type === t}
              onClick={() => patch({ type: t })}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="chips">
          <span className="dim">表示:</span>
          <button
            type="button"
            className={ui.view === "grid" ? "chip active" : "chip"}
            aria-pressed={ui.view === "grid"}
            onClick={() => patch({ view: "grid" })}
          >
            グリッド
          </button>
          <button
            type="button"
            className={ui.view === "list" ? "chip active" : "chip"}
            aria-pressed={ui.view === "list"}
            onClick={() => patch({ view: "list" })}
          >
            リスト
          </button>
          <span className="dim">並び:</span>
          {SORTS.map((s) => (
            <button
              type="button"
              key={s.id}
              className={ui.sort === s.id ? "chip active" : "chip"}
              aria-pressed={ui.sort === s.id}
              onClick={() => patch({ sort: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {jobs.map((j) => (
        <div key={j.id} className="progress">
          <div className="bar" style={{ width: `${Math.max(3, Math.min(100, j.percent))}%` }} />
          <span>
            {j.kind} {Math.round(j.percent)}% {j.message ?? ""}
          </span>
        </div>
      ))}

      <div className="assets-summary dim">
        {shown.length} / {all.length} 件
        {missingCount > 0 ? <span className="err"> · ⚠ 欠落 {missingCount} 件</span> : null}
      </div>

      {assets === null ? <p className="placeholder-note">素材を読み込み中…</p> : null}
      {assets !== null && all.length === 0 ? (
        <p className="placeholder-note">
          素材はまだありません。「+ 取り込み」から <code>montash import &lt;path&gt; --proxy</code> を発行します。
        </p>
      ) : null}
      {all.length > 0 && shown.length === 0 ? <p className="placeholder-note">条件に合う素材がありません。</p> : null}

      <ul className={ui.view === "grid" ? "asset-list grid" : "asset-list"}>
        {shown.map((a) => (
          <AssetRow
            key={a.id}
            asset={a}
            selected={a.id === selectedId}
            onSelect={() => select(a.id === selectedId ? null : a.id)}
          />
        ))}
      </ul>

      {selected ? <AssetDetail asset={selected} /> : null}

      {showImport ? <ImportDialog onClose={() => setShowImport(false)} /> : null}
      {showNewText ? <TextAssetForm onClose={() => setShowNewText(false)} /> : null}
    </div>
  );
}
