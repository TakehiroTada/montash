/**
 * 右ペインのタブ内容（docs/06 §2.5, §2.7）。Inspector = 選択クリップのプロパティ・効果フォーム・
 * CLI 例・生 JSON、History = op の一覧。Assets タブは components/Assets/AssetsPanel.tsx が担当する。
 *
 * Inspector は **spec 駆動**（計画 P3-2）。クリップ種別ごとの固定フィールドも、固定の CLI 例も持たない:
 *   - プロパティ: クリップが実際に持つキーをそのまま並べる（プラグイン由来のフィールドも消えない）
 *   - 効果: `GET /api/specs` のパラメータ定義から入力欄を組み、変更は `effect set` の発行で反映する
 *   - CLI 例: 同じ `/api/specs` のコマンド定義から組む（旧 `/api/cli-examples` の置き換え。docs/06 §3.6）
 *
 * 未知種別のクリップ（`kind: "opaque"`）と、定義の無い効果には「プラグイン不足」バッジを出す。
 */
import { Fragment } from "react";
import { checkout } from "../cli-client.ts";
import { clipCliExamples, clipPropertyRows, commandDisabledReason, effectTargetOfTrack } from "../lib/specs.ts";
import { type ClipLike, clipKindOf, clipSpan, computedIndex, useStore } from "../store.ts";
import { EffectsPanel } from "./EffectsPanel.tsx";

function findClip(id: string | null): { clip: ClipLike; trackId: string; trackKind?: string } | null {
  if (!id) return null;
  const p = useStore.getState().project;
  for (const t of p?.tracks ?? [])
    for (const c of t.clips ?? []) if (c.id === id) return { clip: c, trackId: t.id, trackKind: t.kind };
  return null;
}

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project); // 再取得時に再描画するために購読
  const specs = useStore((s) => s.specs);
  const allowlist = useStore((s) => s.allowlist);
  const readOnly = useStore((s) => s.status?.server.read_only ?? false);
  const playheadF = useStore((s) => s.playhead_f);
  const hit = project ? findClip(selection?.id ?? null) : null;

  if (!hit) {
    return (
      <div>
        <h3>Inspector</h3>
        <p className="placeholder-note">
          タイムラインのクリップをクリックすると、プロパティと CLI コマンド例をここに表示します。
        </p>
      </div>
    );
  }

  const { clip, trackId, trackKind } = hit;
  // 区間はサーバの computed が正（字幕はクリップ単体からは長さが分からない。docs/13 D-1）
  const span = clipSpan(clip, computedIndex(project));
  const kind = clipKindOf(clip);
  const examples = clipCliExamples(specs, clip.id, playheadF);
  // `effect set` を Web から打てるか。既定の許可リストには無いので、通常は理由を出して入力を無効化する
  // （開けるのは `serve --allow`。docs/06 §3.3、計画 P3-3）
  const effectDisabled = commandDisabledReason("effect set", { allowlist, readOnly });

  return (
    <div className="inspector">
      <h3 className="inspector-title">
        <span>Clip {clip.id}</span>
        <span className="badge">{kind}</span>
        {kind === "opaque" ? (
          <span className="badge err" title={`type "${String(clip.type)}" を解釈できる定義がありません`}>
            プラグイン不足
          </span>
        ) : null}
      </h3>
      {kind === "opaque" ? (
        <p className="hint-note">
          未知の種別なので中身は解釈できませんが、値はそのまま保持されます（保存しても消えません）。 レンダーすると{" "}
          <code>E_PLUGIN_MISSING</code> になります。<code>montash plugin doctor</code> で不足を確認してください。
        </p>
      ) : null}

      <dl className="kv">
        {clipPropertyRows(clip, trackId, span).map((row) => (
          <Fragment key={row.key}>
            <dt>{row.key}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
      </dl>

      <EffectsPanel clip={clip} target={effectTargetOfTrack(trackKind)} disabledReason={effectDisabled} />

      <h3 style={{ marginTop: 12 }}>CLI examples</h3>
      {examples.length === 0 ? (
        <p className="placeholder-note">
          {specs === null ? "コマンド定義を取得中です（GET /api/specs）。" : "このクリップに対する例はありません。"}
        </p>
      ) : null}
      <ul className="list">
        {examples.map((ex) => (
          <li key={ex}>
            <code style={{ flex: 1 }}>{ex}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(ex)}>
              copy
            </button>
          </li>
        ))}
      </ul>

      <h3 style={{ marginTop: 12 }}>raw</h3>
      <pre>{JSON.stringify(clip, null, 2)}</pre>
    </div>
  );
}

export function HistoryTab() {
  const history = useStore((s) => s.history);
  const readOnly = useStore((s) => s.status?.server.read_only ?? false);
  const ops = history?.ops ?? [];
  return (
    <div>
      <h3>
        History ({ops.length} ops · {history?.commits.length ?? 0} commits)
      </h3>
      {ops.length === 0 ? <p className="placeholder-note">まだ op がありません。</p> : null}
      <ul className="list">
        {[...ops]
          .reverse()
          .slice(0, 200)
          .map((op) => (
            <li key={op.id} aria-current={history?.head === op.id ? "step" : undefined}>
              <span className="id">
                {op.id}
                {history?.head === op.id ? " (HEAD)" : ""}
              </span>
              <span className="dim">{op.actor ?? ""}</span>
              <span style={{ flex: 1 }}>
                {op.summary ?? op.command?.join(" ") ?? ""}
                {op.commit ? (
                  <small style={{ display: "block" }}>
                    {op.commit}: {history?.commits.find((c) => c.id === op.commit)?.message}
                  </small>
                ) : null}
                {Object.entries(history?.tags ?? {})
                  .filter(
                    ([, tag]) =>
                      tag.target === op.id || history?.commits.some((c) => c.id === tag.target && c.head === op.id),
                  )
                  .map(([name]) => (
                    <span key={name} className="badge">
                      {name}
                    </span>
                  ))}
              </span>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => void checkout(op.id)}
                title={`montash checkout ${op.id}`}
              >
                go
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
