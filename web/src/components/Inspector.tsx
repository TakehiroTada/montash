/**
 * 右ペインのタブ内容（docs/06 §2.5〜2.7）。この段階は Inspector = 選択クリップの生 JSON、
 * Assets / History はプレースホルダ一覧。
 */
import { checkout } from "../cli-client.ts";
import { type ClipLike, clipEnd, useStore } from "../store.ts";

function findClip(id: string | null): { clip: ClipLike; trackId: string } | null {
  if (!id) return null;
  const p = useStore.getState().project;
  for (const t of p?.tracks ?? []) for (const c of t.clips ?? []) if (c.id === id) return { clip: c, trackId: t.id };
  return null;
}

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project); // 再取得時に再描画するために購読
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
  const { clip, trackId } = hit;
  const examples = [
    `clip split ${clip.id} --at f:${useStore.getState().playhead_f}`,
    `clip trim ${clip.id} --in +f:15 --ripple`,
    `clip move ${clip.id} --by +f:15`,
    `clip delete ${clip.id} --ripple`,
  ];
  return (
    <div>
      <h3>Clip {clip.id}</h3>
      <dl className="kv">
        <dt>track</dt>
        <dd>{trackId}</dd>
        <dt>asset</dt>
        <dd>{clip.asset ?? "—"}</dd>
        <dt>start_f</dt>
        <dd>{clip.start_f}</dd>
        <dt>end_f</dt>
        <dd>{clipEnd(clip)}</dd>
        <dt>in_f / out_f</dt>
        <dd>
          {clip.in_f ?? "—"} / {clip.out_f ?? "—"}
        </dd>
      </dl>
      <h3 style={{ marginTop: 12 }}>CLI examples</h3>
      <ul className="list">
        {examples.map((ex) => (
          <li key={ex}>
            <code style={{ flex: 1 }}>montash {ex}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(`montash ${ex}`)}>
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

export function AssetsTab() {
  const assets = useStore((s) => s.project?.assets ?? null);
  const ids = assets ? Object.keys(assets) : [];
  return (
    <div>
      <h3>Assets ({ids.length})</h3>
      {ids.length === 0 ? (
        <p className="placeholder-note">素材はまだありません。`montash import {"<path>"}` で取り込みます。</p>
      ) : null}
      <ul className="list">
        {ids.map((id) => {
          const a = (assets?.[id] ?? {}) as { type?: string; label?: string; path?: string };
          return (
            <li key={id}>
              <span className="id">{id}</span>
              <span className="dim">{a.type ?? "?"}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.label ?? a.path ?? ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="placeholder-note" style={{ marginTop: 10 }}>
        取り込み・ラベル・再リンクなどの操作は後続で追加（すべて `POST /api/cli` 経由）。
      </p>
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
            <li key={op.id}>
              <span className="id">{op.id}</span>
              <span className="dim">{op.actor ?? ""}</span>
              <span style={{ flex: 1 }}>{op.summary ?? op.command?.join(" ") ?? ""}</span>
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
