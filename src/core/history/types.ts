/**
 * git ライク履歴モデルの型定義（docs/11 §3）。
 *
 * `project.json` の中身には依存しない。スナップショットは `unknown` な JSON として扱い、
 * 内容ハッシュ（`sha1:...`）で objects/ に保存する。
 */

/** 操作の主体（docs/11 §3.2, §4.6） */
export type Actor = "ai" | "human" | "web" | "system";

/** JSON Patch 風の差分 1 件（docs/11 §3.2 `changes`） */
export interface Change {
  op: "add" | "remove" | "replace";
  /** JSON Pointer（例: `/tracks/0/clips/1/in_f`） */
  path: string;
  /** add / replace 後の値 */
  value?: unknown;
  /** remove / replace 前の値 */
  from?: unknown;
}

/** Web でハイライトするための影響範囲（docs/11 §3.2 `affects`） */
export interface Affects {
  clips: string[];
  /** プロジェクト fps 基準の整数フレーム `[from_f, to_f]`。不明なら null */
  range_f: [number, number] | null;
}

/** 状態を変える CLI コマンド 1 回 = op 1 つ（docs/11 §3.2） */
export interface Op {
  /** `o_0001` 形式 */
  id: string;
  /** 直前の HEAD。根（初期化）は null */
  parent: string | null;
  /** ISO 8601 */
  at: string;
  actor: Actor;
  actor_detail?: string;
  /** 実行した引数（配列、シェル非依存） */
  command: string[];
  /** 1 行要約 */
  summary: string;
  /** objects/ のハッシュ */
  before: string;
  after: string;
  changes: Change[];
  affects: Affects;
  /**
   * 所属コミット。pending なら null。
   * ops.jsonl は追記専用なので、ファイル上は常に null で、読み出し時に commits.jsonl から補完する。
   */
  commit: string | null;
  duration_ms?: number;
}

export interface CommitStats {
  ops: number;
  clips_added: number;
  clips_removed: number;
  clips_modified: number;
}

/** 連続する op の集合にメッセージ・作者を付けたもの（docs/11 §3.3） */
export interface Commit {
  /** `k_0001` 形式 */
  id: string;
  /** 直前のコミット（op DAG 上で祖先にあるもの）。無ければ null */
  parent: string | null;
  at: string;
  author: string;
  author_detail?: string;
  message: string;
  body?: string;
  /** 含まれる op（時系列順）。空コミットなら [] */
  ops: string[];
  /** このコミットの最終状態（op id） */
  head: string;
  tags: string[];
  stats: CommitStats;
}

/** タグ（docs/11 §3.1 tags.json の値） */
export interface Tag {
  /** `o_xxxx` または `k_xxxx` */
  target: string;
  at: string;
  message?: string;
}

export type TagMap = Record<string, Tag>;

export type MoveKind = "checkout" | "undo" | "redo" | "reset";

/** checkout / undo / redo の移動ログ（moves.jsonl）。op は作らない */
export interface Move {
  at: string;
  kind: MoveKind;
  actor: Actor;
  actor_detail?: string;
  /** 移動前の HEAD */
  from: string | null;
  /** 移動後の HEAD */
  to: string;
  /** ユーザーが指定した参照（`HEAD~2`, タグ名 など） */
  ref?: string;
  /**
   * 移動時点で最後に存在していた op の id。
   * ops と moves の前後関係を時計に依存せず決めるために使う（redo の子選択）。
   */
  last_op: string | null;
}

/** `reset --hard` 1 回の記録（docs/11 §4.3） */
export interface ResetEntry {
  at: string;
  actor: Actor;
  actor_detail?: string;
  /** ユーザーが指定した参照 */
  ref: string;
  /** 移動先（reset 後の HEAD） */
  to: string;
  /** このリセットで「無視する」ことにした op */
  ops: string[];
}

/**
 * `.montash/history/reset.json`。`reset --hard` で捨てられた op の集合。
 * 物理削除はしないので `log --all` では見える（docs/11 §4.3）。
 */
export interface ResetState {
  /** 無視する op（`log` の既定表示・tip 探索から外す） */
  ignored: string[];
  entries: ResetEntry[];
}

/** `montash status` / 各コマンドの `head` に載せる状態（docs/04 §1.5） */
export interface HeadState {
  /** 現在の op id。履歴が空なら null */
  head: string | null;
  headOp: Op | null;
  /** HEAD が属するコミット id。pending なら null */
  commit: string | null;
  /** 最後のコミット以降で HEAD の祖先にある op（時系列順） */
  pending: Op[];
  /** HEAD が系列の tip でない */
  detached: boolean;
  /** HEAD の系列の先端 */
  tip: string | null;
  /** project.json の内容が HEAD.after と一致しない（status に project を渡した場合のみ） */
  dirty?: boolean;
}
