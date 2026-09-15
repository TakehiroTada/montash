/**
 * 高レベル履歴 API（docs/11 §2–§4, §7）。HistoryStore + dag + diff を組み合わせる。
 *
 * - `project.json` の読み書きは呼び出し側（CLI）が行う。ここではスナップショット（unknown）を受け渡すだけ。
 * - checkout / undo / redo は op を作らず moves.jsonl に記録する。
 * - 警告（W_*）は例外にせず戻り値の `warnings` に含める。
 */

import { MontashError, type Warning, warning } from "../../cli/errors.ts";
import {
  ancestors,
  buildIndex,
  descendants,
  isValidTagName,
  type OpIndex,
  pathToRoot,
  preferredChild,
  type ResolvedRef,
  resolveRef,
  tipOf,
} from "./dag.ts";
import { diffJson, escapeToken, extractAffects, findConflicts, getAt, invertChanges, parsePointer } from "./diff.ts";
import type { HashFn } from "./hash.ts";
import { HistoryStore } from "./store.ts";
import type {
  Actor,
  Affects,
  Change,
  Commit,
  CommitStats,
  HeadState,
  Move,
  MoveKind,
  Op,
  ResetState,
  Tag,
} from "./types.ts";

export interface HistoryOptions {
  hash?: HashFn;
  now?: () => string;
}

export interface RecordOpInput {
  before: unknown;
  after: unknown;
  command: string[];
  actor: Actor;
  actorDetail?: string;
  summary: string;
  affects?: Affects;
  durationMs?: number;
}

export interface RecordOpResult {
  op: Op;
  head: HeadState;
  warnings: Warning[];
}

export interface CommitInput {
  message: string;
  body?: string;
  author: string;
  authorDetail?: string;
  /** 含める op（pending の末尾側の連続部分のみ） */
  ops?: string[];
  /** pending の末尾 n 件 */
  last?: number;
  allowEmpty?: boolean;
  /** 作成したコミットに付けるタグ */
  tags?: string[];
}

export interface MoveResult {
  target: Op;
  /** target.after のスナップショット。project.json への書き込みは呼び出し側 */
  project: unknown;
  warnings: Warning[];
  head: HeadState;
}

export interface LogOptions {
  ops?: boolean;
  all?: boolean;
  limit?: number;
  grep?: string;
  author?: string;
}

export interface LogEntry {
  commit: Commit;
  /** `ops: true` のとき、含まれる op（時系列順） */
  ops?: Op[];
}

export interface LogResult {
  /** 新しい順 */
  entries: LogEntry[];
  /** コミットに属さない op（時系列順）。既定は HEAD 系列上、`all` は全て */
  pending: Op[];
  /** `reset --hard` で既定表示から外されている op（`all` のときだけ中身が入る） */
  reset: string[];
}

export interface ShowResult {
  ref: ResolvedRef;
  op: Op;
  commit: Commit | null;
  before: unknown;
  after: unknown;
  changes: Change[];
}

export interface RevertResult {
  ref: ResolvedRef;
  /** 現在の HEAD に適用する逆差分 */
  changes: Change[];
  /** 適用できないパス（空なら適用可） */
  conflicts: string[];
}

export interface ResetResult extends MoveResult {
  /** このリセットで新たに無視することにした op */
  discarded: string[];
  /** 無視される op の総数（過去のリセットぶんを含む） */
  ignored: string[];
}

export interface BlameHit {
  element: string;
  op: Op;
  commit: Commit | null;
  /** その要素に関係する変更だけ */
  changes: Change[];
}

export interface PruneOptions {
  keepCommits?: number;
  keepDays?: number;
  dryRun?: boolean;
  /** 現在時刻（テスト用） */
  now?: Date;
}

export interface PruneResult {
  dry_run: boolean;
  /** 削除する（した）op */
  ops: string[];
  /** 削除する（した）object ハッシュ */
  objects: string[];
  /** 削除する（した）moves.jsonl の行数 */
  moves: number;
  kept: { ops: number; commits: number; objects: number };
}

export interface ExportResult {
  path: string;
  counts: { ops: number; commits: number; moves: number; tags: number; objects: number };
}

export interface ImportResult extends ExportResult {
  added: { ops: number; commits: number; moves: number; tags: number; objects: number };
  head: string | null;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

export interface TagEntry extends Tag {
  name: string;
  /** target を解決した op id（解決できなければ null） */
  op: string | null;
}

/** 読み出し済みの履歴一式（1 回の操作内で使い回す） */
interface Snapshot {
  ops: Op[];
  commits: Commit[];
  moves: Move[];
  tags: Record<string, Tag>;
  head: string | null;
  index: OpIndex;
  /** op id → commit id */
  commitOf: Map<string, string>;
  /** `reset --hard` で捨てられた op */
  ignored: Set<string>;
  reset: ResetState;
}

export class History {
  readonly store: HistoryStore;

  private constructor(store: HistoryStore) {
    this.store = store;
  }

  static async open(projectDir: string, opts: HistoryOptions = {}): Promise<History> {
    const store = await HistoryStore.open(projectDir, { hash: opts.hash, now: opts.now });
    return new History(store);
  }

  get hash(): HashFn {
    return this.store.hash;
  }

  // ---- 読み出し ----

  private async load(): Promise<Snapshot> {
    const [rawOps, commits, moves, tags, head, reset] = await Promise.all([
      this.store.readOps(),
      this.store.readCommits(),
      this.store.readMoves(),
      this.store.readTags(),
      this.store.getHead(),
      this.store.readReset(),
    ]);
    const commitOf = new Map<string, string>();
    for (const c of commits) for (const id of c.ops) commitOf.set(id, c.id);
    // ops.jsonl 上の commit は常に null なので commits から補完する
    const ops = rawOps.map((op) => ({ ...op, commit: commitOf.get(op.id) ?? null }));
    return {
      ops,
      commits,
      moves,
      tags,
      head,
      index: buildIndex(ops),
      commitOf,
      ignored: new Set(reset.ignored),
      reset,
    };
  }

  /** 所属コミットを補完した op 一覧（ops.jsonl 順） */
  async ops(): Promise<Op[]> {
    return (await this.load()).ops;
  }

  async commits(): Promise<Commit[]> {
    return this.store.readCommits();
  }

  async moves(): Promise<Move[]> {
    return this.store.readMoves();
  }

  /** 参照を op に解決する（CLI の `<ref>` 引数用） */
  async resolve(ref: string): Promise<ResolvedRef> {
    const s = await this.load();
    return resolveRef(ref, s);
  }

  // ---- status ----

  private headState(s: Snapshot, project?: unknown): HeadState {
    if (s.head === null) {
      return { head: null, headOp: null, commit: null, pending: [], detached: false, tip: null };
    }
    const headOp = s.index.byId.get(s.head) ?? null;
    if (!headOp) {
      throw new MontashError("E_HISTORY_CORRUPT", `HEAD points to unknown op ${s.head}`, {
        hint: "Run `montash history verify`, or `montash checkout <op>` to move HEAD to an existing op.",
        detail: { head: s.head },
      });
    }
    const tip = tipOf(s.index, s.head, s.moves, s.ignored);
    const state: HeadState = {
      head: s.head,
      headOp,
      commit: s.commitOf.get(s.head) ?? null,
      pending: pendingOps(s, s.head),
      detached: tip !== s.head,
      tip,
    };
    if (project !== undefined) state.dirty = this.hash(project) !== headOp.after;
    return state;
  }

  /** HEAD の状態。`project` を渡すと dirty 判定（W_DIRTY_WORKTREE 用）も行う */
  async status(opts: { project?: unknown } = {}): Promise<HeadState> {
    const s = await this.load();
    return this.headState(s, opts.project);
  }

  // ---- op の記録 ----

  /**
   * 状態変更を op として記録し、HEAD を進める。
   * before のハッシュが HEAD.after と一致しなければ W_DIRTY_WORKTREE を warnings に含める（例外にはしない）。
   */
  async recordOp(input: RecordOpInput): Promise<RecordOpResult> {
    const warnings: Warning[] = [];
    // before と after が同じ内容でも 1 回しか書かないよう逐次に put する
    const beforeHash = await this.store.putObject(input.before);
    const afterHash = await this.store.putObject(input.after);
    const s = await this.load();
    const headOp = s.head === null ? null : (s.index.byId.get(s.head) ?? null);
    if (headOp && headOp.after !== beforeHash) {
      warnings.push(
        warning(
          "W_DIRTY_WORKTREE",
          `project.json did not match HEAD (${headOp.id}) before this command; it may have been edited by hand`,
          {
            hint: "The op is recorded with the actual before-state. Use `montash commit --from-worktree -m <msg>` to record manual edits explicitly, or `montash checkout HEAD` to discard them.",
            detail: { head: headOp.id, expected: headOp.after, actual: beforeHash },
          },
        ),
      );
    }
    const changes = diffJson(input.before, input.after);
    const op = await this.store.appendOp({
      parent: s.head,
      at: this.store.now(),
      actor: input.actor,
      ...(input.actorDetail !== undefined ? { actor_detail: input.actorDetail } : {}),
      command: input.command,
      summary: input.summary,
      before: beforeHash,
      after: afterHash,
      changes,
      affects: input.affects ?? extractAffects(changes, input.after, input.before),
      commit: null,
      ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
    });
    await this.store.setHead(op.id);
    const head = this.headState(await this.load());
    return { op, head, warnings };
  }

  // ---- commit ----

  async commit(input: CommitInput): Promise<Commit> {
    const s = await this.load();
    if (s.head === null) throw nothingToCommit(input.allowEmpty === true);
    const pending = pendingOps(s, s.head);
    if (pending.length === 0 && input.allowEmpty !== true) throw nothingToCommit(false);
    let selected = pending;
    if (input.ops !== undefined) {
      selected = selectSuffix(pending, input.ops);
    } else if (input.last !== undefined) {
      if (!Number.isInteger(input.last) || input.last < 1) {
        throw new MontashError("E_USAGE", `--last must be a positive integer (got ${input.last})`);
      }
      if (input.last > pending.length) {
        throw new MontashError(
          "E_USAGE",
          `--last ${input.last} exceeds the number of pending ops (${pending.length})`,
          {
            hint: `Omit --last to commit all ${pending.length} pending ops.`,
            detail: { pending: pending.length },
          },
        );
      }
      selected = pending.slice(-input.last);
    }
    if (selected.length === 0 && input.allowEmpty !== true) throw nothingToCommit(false);

    const first = selected[0];
    const headId = selected.length > 0 ? (selected[selected.length - 1] as Op).id : s.head;
    // 親コミット: 先頭 op の親（空コミットなら HEAD 自身）から遡って最初に見つかるコミット
    const parentSearchFrom = first ? first.parent : s.head;
    const parent = parentSearchFrom === null ? null : nearestCommit(s, parentSearchFrom);

    for (const name of input.tags ?? []) await this.assertTagFree(s.tags, name);

    const commit = await this.store.appendCommit({
      parent,
      at: this.store.now(),
      author: input.author,
      ...(input.authorDetail !== undefined ? { author_detail: input.authorDetail } : {}),
      message: input.message,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ops: selected.map((o) => o.id),
      head: headId,
      tags: [...(input.tags ?? [])],
      stats: computeStats(selected),
    });

    if (input.tags && input.tags.length > 0) {
      const tags = await this.store.readTags();
      for (const name of input.tags) tags[name] = { target: commit.id, at: commit.at };
      await this.store.writeTags(tags);
    }
    return commit;
  }

  // ---- 移動 ----

  /** HEAD を ref へ移動し moves.jsonl に記録する。project.json の書き込みは呼び出し側 */
  async checkout(ref: string, actor: Actor, actorDetail?: string): Promise<MoveResult> {
    const s = await this.load();
    const resolved = resolveRef(ref, s);
    return this.moveTo(s, resolved.op, "checkout", actor, actorDetail, ref);
  }

  /** 親へ n 段戻る（`checkout HEAD~n`） */
  async undo(n = 1, actor: Actor = "human", actorDetail?: string): Promise<MoveResult> {
    const s = await this.load();
    if (s.head === null) throw nothingTo("undo", 0, n);
    const chain = pathToRoot(s.index, s.head);
    const available = chain.length - 1;
    if (!Number.isInteger(n) || n < 1)
      throw new MontashError("E_USAGE", `undo count must be a positive integer (got ${n})`);
    if (available < n) throw nothingTo("undo", available, n);
    return this.moveTo(s, chain[n] as string, "undo", actor, actorDetail, `HEAD~${n}`);
  }

  /** 子へ n 段進む。子が複数なら「最後に HEAD だった系列」を選び W_MULTIPLE_CHILDREN を付ける */
  async redo(n = 1, actor: Actor = "human", actorDetail?: string): Promise<MoveResult> {
    const s = await this.load();
    if (s.head === null) throw nothingTo("redo", 0, n);
    if (!Number.isInteger(n) || n < 1)
      throw new MontashError("E_USAGE", `redo count must be a positive integer (got ${n})`);
    const warnings: Warning[] = [];
    let cur = s.head;
    for (let i = 0; i < n; i++) {
      const choice = preferredChild(s.index, cur, s.moves, s.ignored);
      if (choice.chosen === null) throw nothingTo("redo", i, n);
      if (choice.candidates.length > 1) {
        warnings.push(
          warning(
            "W_MULTIPLE_CHILDREN",
            `${cur} has ${choice.candidates.length} children; following the most recently used branch (${choice.chosen})`,
            {
              hint: `To follow another branch use \`montash checkout <op>\` with one of: ${choice.candidates.join(", ")}.`,
              detail: { op: cur, chosen: choice.chosen, candidates: choice.candidates },
            },
          ),
        );
      }
      cur = choice.chosen;
    }
    const result = await this.moveTo(s, cur, "redo", actor, actorDetail, `redo ${n}`);
    return { ...result, warnings: [...warnings, ...result.warnings] };
  }

  private async moveTo(
    s: Snapshot,
    targetId: string,
    kind: MoveKind,
    actor: Actor,
    actorDetail: string | undefined,
    ref: string,
  ): Promise<MoveResult> {
    const target = s.index.byId.get(targetId);
    if (!target) {
      throw new MontashError("E_HISTORY_REF_NOT_FOUND", `unknown op ${targetId}`, { detail: { ref, op: targetId } });
    }
    const warnings: Warning[] = [];
    if (s.head !== null && s.head !== targetId) {
      // 移動後の HEAD の祖先から外れる pending op（op 自体は失われない）を明示する
      const targetChain = new Set(pathToRoot(s.index, targetId));
      const leaving = pendingOps(s, s.head).filter((p) => !targetChain.has(p.id));
      if (leaving.length > 0) {
        warnings.push(
          warning(
            "W_LEAVING_PENDING",
            `leaving ${leaving.length} uncommitted op${leaving.length === 1 ? "" : "s"} (${leaving.map((p) => p.id).join(", ")}) behind at ${s.head}`,
            {
              hint: `The ops are kept in the history. Return with \`montash checkout ${s.head}\`, or commit them first with \`montash commit -m <msg>\`.`,
              detail: { from: s.head, pending: leaving.map((p) => p.id) },
            },
          ),
        );
      }
    }
    const project = await this.store.getObject(target.after);
    await this.store.appendMove({
      at: this.store.now(),
      kind,
      actor,
      ...(actorDetail !== undefined ? { actor_detail: actorDetail } : {}),
      from: s.head,
      to: targetId,
      ref,
      last_op: s.ops.length > 0 ? (s.ops[s.ops.length - 1] as Op).id : null,
    });
    await this.store.setHead(targetId);
    const head = this.headState(await this.load());
    if (head.detached) {
      warnings.push(
        warning("W_DETACHED_HEAD", `HEAD is at ${targetId}, which is not the tip of its branch (${head.tip})`, {
          hint: "New ops will start a new branch from here; the existing ops stay in `montash log --all`. Use `montash checkout tip` to return to the tip.",
          detail: { head: targetId, tip: head.tip },
        }),
      );
    }
    return { target, project, warnings, head };
  }

  // ---- log / show ----

  async log(opts: LogOptions = {}): Promise<LogResult> {
    const s = await this.load();
    let commits: Commit[];
    let uncommitted: Op[];
    if (opts.all || s.head === null) {
      commits = [...s.commits];
      uncommitted = s.ops.filter((o) => o.commit === null);
    } else {
      // 既定は HEAD 系列上、かつ `reset --hard` で捨てられていないもの（docs/11 §4.3）
      const chain = new Set(pathToRoot(s.index, s.head));
      const visible = (id: string): boolean => chain.has(id) && !s.ignored.has(id);
      commits = s.commits.filter((c) => visible(c.head) && !c.ops.some((id) => s.ignored.has(id)));
      uncommitted = s.ops.filter((o) => o.commit === null && visible(o.id));
    }
    if (opts.grep !== undefined) {
      const needle = opts.grep.toLowerCase();
      commits = commits.filter(
        (c) => c.message.toLowerCase().includes(needle) || (c.body ?? "").toLowerCase().includes(needle),
      );
    }
    if (opts.author !== undefined) commits = commits.filter((c) => c.author === opts.author);
    commits.reverse();
    if (opts.limit !== undefined) commits = commits.slice(0, Math.max(0, opts.limit));
    const entries: LogEntry[] = commits.map((commit) =>
      opts.ops
        ? { commit, ops: commit.ops.map((id) => s.index.byId.get(id)).filter((o): o is Op => o !== undefined) }
        : { commit },
    );
    return { entries, pending: uncommitted, reset: opts.all ? [...s.ignored] : [] };
  }

  async show(ref: string): Promise<ShowResult> {
    const s = await this.load();
    const resolved = resolveRef(ref, s);
    const op = s.index.byId.get(resolved.op) as Op;
    // `k_xxxx`（または commit を指すタグ）そのものならコミット全体の差分、それ以外は op の差分
    const commitMode = resolved.commit !== undefined && resolved.back === 0;
    const commitId = commitMode ? resolved.commit : op.commit;
    const commit = commitId ? (s.commits.find((c) => c.id === commitId) ?? null) : null;
    const range = commitMode && commit ? commitRange(s, commit) : { before: op.before, after: op.after };
    const [before, after] = await Promise.all([this.store.getObject(range.before), this.store.getObject(range.after)]);
    const changes = commitMode && commit ? diffJson(before, after) : op.changes;
    return { ref: resolved, op, commit, before, after, changes };
  }

  // ---- tag ----

  async tag(name: string, ref = "HEAD", message?: string): Promise<TagEntry> {
    const s = await this.load();
    await this.assertTagFree(s.tags, name);
    const resolved = resolveRef(ref, s);
    // `k_xxxx` を指定したときはコミットを target にする
    const target = resolved.via === "commit" && resolved.back === 0 && resolved.commit ? resolved.commit : resolved.op;
    const tag: Tag = { target, at: this.store.now(), ...(message !== undefined ? { message } : {}) };
    const tags = await this.store.readTags();
    tags[name] = tag;
    await this.store.writeTags(tags);
    return { name, ...tag, op: resolved.op };
  }

  async deleteTag(name: string): Promise<void> {
    const tags = await this.store.readTags();
    if (!Object.hasOwn(tags, name)) {
      throw new MontashError("E_TAG_NOT_FOUND", `tag '${name}' does not exist`, {
        hint: "See `montash tag list`.",
        detail: { name, tags: Object.keys(tags) },
      });
    }
    delete tags[name];
    await this.store.writeTags(tags);
  }

  async listTags(): Promise<TagEntry[]> {
    const s = await this.load();
    return Object.entries(s.tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tag]) => {
        let op: string | null = null;
        try {
          op = resolveRef(tag.target, { ...s, tags: {} }).op;
        } catch {
          op = null;
        }
        return { name, ...tag, op };
      });
  }

  private async assertTagFree(tags: Record<string, Tag>, name: string): Promise<void> {
    if (!isValidTagName(name)) {
      throw new MontashError("E_USAGE", `'${name}' is not a valid tag name`, {
        hint: "Tag names must not be HEAD/tip, look like an op/commit id (o_0001, k_0001), or contain '~', '/', or whitespace.",
        detail: { name },
      });
    }
    if (Object.hasOwn(tags, name)) {
      throw new MontashError("E_TAG_EXISTS", `tag '${name}' already exists (-> ${tags[name]?.target})`, {
        hint: `Delete it first with \`montash tag delete ${name}\` or choose another name.`,
        detail: { name, target: tags[name]?.target },
      });
    }
  }

  // ---- revert ----

  /**
   * ref（op / commit）の逆差分を、現在の HEAD のスナップショットに適用できるか検査する。
   * 適用と recordOp は呼び出し側。conflicts が空でなければ呼び出し側は E_REVERT_CONFLICT にする。
   */
  async revertChanges(ref: string): Promise<RevertResult> {
    const s = await this.load();
    if (s.head === null) throw new MontashError("E_HISTORY_REF_NOT_FOUND", "HEAD is not set (history is empty)");
    const resolved = resolveRef(ref, s);
    const headOp = s.index.byId.get(s.head);
    if (!headOp) throw new MontashError("E_HISTORY_CORRUPT", `HEAD points to unknown op ${s.head}`);
    let forward: Change[];
    if (resolved.commit !== undefined && resolved.back === 0) {
      const commit = s.commits.find((c) => c.id === resolved.commit) as Commit;
      const range = commitRange(s, commit);
      const [before, after] = await Promise.all([
        this.store.getObject(range.before),
        this.store.getObject(range.after),
      ]);
      forward = diffJson(before, after);
    } else {
      forward = (s.index.byId.get(resolved.op) as Op).changes;
    }
    const changes = invertChanges(forward);
    const current = await this.store.getObject(headOp.after);
    return { ref: resolved, changes, conflicts: findConflicts(current, changes) };
  }

  // ---- reset --hard（docs/11 §4.3） ----

  /**
   * HEAD を ref へ移動し、その先の op を「参照上」無視する（物理削除はしない）。
   * 無視された op は `log` の既定表示・`tip` の解決から外れるが、`log --all` では見える。
   */
  async reset(ref: string, actor: Actor, actorDetail?: string): Promise<ResetResult> {
    const s = await this.load();
    const resolved = resolveRef(ref, s);
    // 対象の子孫（対象自身は含めない）を無視する
    const discarded = [...descendants(s.index, resolved.op)].filter((id) => id !== resolved.op && !s.ignored.has(id));
    const move = await this.moveTo(s, resolved.op, "reset", actor, actorDetail, ref);
    const ignored = [...new Set([...s.reset.ignored, ...discarded])];
    await this.store.writeReset({
      ignored,
      entries: [
        ...s.reset.entries,
        {
          at: this.store.now(),
          actor,
          ...(actorDetail !== undefined ? { actor_detail: actorDetail } : {}),
          ref,
          to: resolved.op,
          ops: discarded,
        },
      ],
    });
    // 無視集合を反映した HEAD 状態で返す（tip が捨てた側を指さないように）。
    // moveTo は無視集合を書く前に判定しているので、detached でなくなった警告は取り除く
    const head = this.headState(await this.load());
    const warnings = head.detached ? move.warnings : move.warnings.filter((w) => w.code !== "W_DETACHED_HEAD");
    return { ...move, warnings, head, discarded, ignored };
  }

  /** `reset --hard` で無視されている op */
  async resetState(): Promise<ResetState> {
    return this.store.readReset();
  }

  // ---- blame（docs/11 §4.1） ----

  /**
   * 要素 ID（クリップ・テキスト・トランジション・アセット等）を最後に変更した op を探す。
   * `op.affects.clips` → changes の path の一部が ID → スナップショット上の `id` の順に判定する。
   *
   * 既定は HEAD 系列の祖先だけを見る（`all` で全系列）。見つからなければ null。
   */
  async blame(element: string, opts: { all?: boolean } = {}): Promise<BlameHit | null> {
    const s = await this.load();
    const chain = s.head === null ? new Set<string>() : new Set(pathToRoot(s.index, s.head));
    const candidates = s.ops.filter((o) => (opts.all ? true : chain.has(o.id)));
    const cache = new Map<string, unknown>();
    const snapshot = async (hash: string): Promise<unknown> => {
      const hit = cache.get(hash);
      if (hit !== undefined) return hit;
      const value = await this.store.getObject(hash).catch(() => null);
      cache.set(hash, value);
      return value;
    };
    for (let i = candidates.length - 1; i >= 0; i--) {
      const op = candidates[i] as Op;
      const changes: Change[] = [];
      const [after, before] = await Promise.all([snapshot(op.after), snapshot(op.before)]);
      for (const c of op.changes) {
        if (changeTouches(c, element, after, before)) changes.push(c);
      }
      if (changes.length === 0 && !op.affects.clips.includes(element)) continue;
      const commitId = op.commit;
      const commit = commitId ? (s.commits.find((x) => x.id === commitId) ?? null) : null;
      return { element, op, commit, changes: changes.length > 0 ? changes : op.changes };
    }
    return null;
  }

  /** 現在のプロジェクト（HEAD の after）に存在する要素 ID（blame の候補提示用） */
  async elementIds(): Promise<string[]> {
    const s = await this.load();
    if (s.head === null) return [];
    const op = s.index.byId.get(s.head);
    if (!op) return [];
    const project = await this.store.getObject(op.after).catch(() => null);
    return collectIds(project);
  }

  // ---- prune（docs/11 §4.5） ----

  /**
   * コミットに属さない古い op と、どこからも参照されない object を削除する。
   *
   * 守るもの: HEAD とその祖先、コミット済み op、コミットの head、タグの解決先、
   * 直近 `keepCommits` 件のコミット以降の op、`keepDays` 日以内の op、
   * および「生き残る子を持つ op」（DAG が切れないように）。
   */
  async prune(opts: PruneOptions = {}): Promise<PruneResult> {
    const keepCommits = opts.keepCommits ?? 100;
    const keepDays = opts.keepDays ?? 30;
    if (!Number.isFinite(keepCommits) || keepCommits < 0)
      throw new MontashError("E_USAGE", `--keep-commits must be >= 0 (got ${keepCommits})`);
    if (!Number.isFinite(keepDays) || keepDays < 0)
      throw new MontashError("E_USAGE", `--keep-days must be >= 0 (got ${keepDays})`);
    const s = await this.load();
    const cutoff = (opts.now ?? new Date()).getTime() - keepDays * 86_400_000;

    const protectedIds = new Set<string>();
    if (s.head !== null) for (const id of pathToRoot(s.index, s.head)) protectedIds.add(id);
    for (const c of s.commits) {
      protectedIds.add(c.head);
      for (const id of c.ops) protectedIds.add(id);
    }
    for (const tag of Object.values(s.tags)) {
      try {
        protectedIds.add(resolveRef(tag.target, { ...s, tags: {} }).op);
      } catch {
        /* 解決できないタグは無視（verify が報告する） */
      }
    }
    // 直近 keepCommits 件のコミット以降にある op は残す
    const recent = s.commits.slice(Math.max(0, s.commits.length - keepCommits));
    const boundary = recent[0];
    if (boundary) for (const id of descendants(s.index, boundary.head)) protectedIds.add(id);

    // 子が全て削除対象でなければ削除しない（親リンクを壊さないため）。末尾から評価する
    const remove = new Set<string>();
    for (let i = s.ops.length - 1; i >= 0; i--) {
      const op = s.ops[i] as Op;
      if (protectedIds.has(op.id)) continue;
      if (Date.parse(op.at) >= cutoff) continue;
      const children = s.index.children.get(op.id) ?? [];
      if (children.some((c) => !remove.has(c))) continue;
      remove.add(op.id);
    }

    const keptOps = s.ops.filter((o) => !remove.has(o.id));
    const referenced = new Set<string>();
    for (const op of keptOps) {
      referenced.add(op.before);
      referenced.add(op.after);
    }
    const allObjects = await this.store.listObjects();
    const orphanObjects = allObjects.filter((h) => !referenced.has(h));
    const keptMoves = s.moves.filter((m) => !remove.has(m.to) && (m.from === null || !remove.has(m.from)));

    const result: PruneResult = {
      dry_run: opts.dryRun === true,
      ops: [...remove],
      objects: orphanObjects,
      moves: s.moves.length - keptMoves.length,
      kept: { ops: keptOps.length, commits: s.commits.length, objects: allObjects.length - orphanObjects.length },
    };
    if (opts.dryRun) return result;
    if (remove.size > 0) {
      // 削除前の最大 ID を覚えておき、採番が巻き戻らないようにする
      const counters = await this.store.readCounters();
      await this.store.writeCounters({
        op: Math.max(counters.op, maxId(s.ops.map((o) => o.id))),
        commit: Math.max(counters.commit, maxId(s.commits.map((c) => c.id))),
      });
      await this.store.writeOps(keptOps.map((o) => ({ ...o, commit: null })));
      await this.store.writeMoves(keptMoves);
    }
    for (const hash of orphanObjects) await this.store.removeObject(hash);
    if (remove.size > 0) {
      const reset = await this.store.readReset();
      await this.store.writeReset({
        ignored: reset.ignored.filter((id) => !remove.has(id)),
        entries: reset.entries.map((e) => ({ ...e, ops: e.ops.filter((id) => !remove.has(id)) })),
      });
    }
    return result;
  }

  // ---- export / import（docs/11 §4.5） ----

  /** 履歴一式を 1 本の JSONL にする（監査・持ち出し用）。1 行 1 レコード、`type` で種別を持つ */
  async exportLines(): Promise<{ lines: string[]; counts: ExportResult["counts"] }> {
    const s = await this.load();
    const hashes = new Set<string>();
    for (const op of s.ops) {
      hashes.add(op.before);
      hashes.add(op.after);
    }
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: "meta", format: "montash-history", version: 1, at: this.store.now() }));
    for (const hash of hashes) {
      const value = await this.store.getObject(hash);
      lines.push(JSON.stringify({ type: "object", hash, value }));
    }
    // ops.jsonl の commit は常に null（読み出し時に commits から補完する）
    for (const op of s.ops) lines.push(JSON.stringify({ type: "op", op: { ...op, commit: null } }));
    for (const c of s.commits) lines.push(JSON.stringify({ type: "commit", commit: c }));
    for (const m of s.moves) lines.push(JSON.stringify({ type: "move", move: m }));
    for (const [name, tag] of Object.entries(s.tags)) lines.push(JSON.stringify({ type: "tag", name, tag }));
    lines.push(JSON.stringify({ type: "reset", reset: s.reset }));
    lines.push(JSON.stringify({ type: "head", op: s.head }));
    return {
      lines,
      counts: {
        ops: s.ops.length,
        commits: s.commits.length,
        moves: s.moves.length,
        tags: Object.keys(s.tags).length,
        objects: hashes.size,
      },
    };
  }

  /**
   * `exportLines()` の JSONL を取り込む。
   * 既存の履歴と ID が衝突したら `E_HISTORY_IMPORT_CONFLICT`（空の履歴なら丸ごと復元する）。
   */
  async importLines(lines: readonly string[]): Promise<Omit<ImportResult, "path">> {
    const s = await this.load();
    const ops: Op[] = [];
    const commits: Commit[] = [];
    const moves: Move[] = [];
    const tags: Record<string, Tag> = {};
    const objects: Array<{ hash: string; value: unknown }> = [];
    let head: string | null = null;
    let reset: ResetState | null = null;
    let sawMeta = false;

    lines.forEach((line, i) => {
      if (line.trim() === "") return;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        throw new MontashError("E_HISTORY_CORRUPT", `line ${i + 1} is not valid JSON`, {
          hint: "The file must be one produced by `montash history export`.",
          detail: { line: i + 1 },
          cause: err,
        });
      }
      switch (rec.type) {
        case "meta":
          sawMeta = true;
          if (rec.format !== "montash-history")
            throw new MontashError("E_HISTORY_CORRUPT", `unsupported export format ${String(rec.format)}`, {
              detail: { line: i + 1 },
            });
          break;
        case "object":
          objects.push({ hash: String(rec.hash), value: rec.value });
          break;
        case "op":
          ops.push(rec.op as Op);
          break;
        case "commit":
          commits.push(rec.commit as Commit);
          break;
        case "move":
          moves.push(rec.move as Move);
          break;
        case "tag":
          tags[String(rec.name)] = rec.tag as Tag;
          break;
        case "reset":
          reset = rec.reset as ResetState;
          break;
        case "head":
          head = typeof rec.op === "string" ? rec.op : null;
          break;
        default:
          throw new MontashError("E_HISTORY_CORRUPT", `line ${i + 1} has unknown record type ${String(rec.type)}`, {
            detail: { line: i + 1 },
          });
      }
    });
    if (!sawMeta)
      throw new MontashError("E_HISTORY_CORRUPT", "the file has no montash-history meta record", {
        hint: "Use a file produced by `montash history export -o <file.jsonl>`.",
      });

    const existingOps = new Set(s.ops.map((o) => o.id));
    const existingCommits = new Set(s.commits.map((c) => c.id));
    const conflicts = [
      ...ops.filter((o) => existingOps.has(o.id)).map((o) => o.id),
      ...commits.filter((c) => existingCommits.has(c.id)).map((c) => c.id),
    ];
    if (conflicts.length > 0)
      throw new MontashError(
        "E_HISTORY_IMPORT_CONFLICT",
        `${conflicts.length} id(s) already exist in this history: ${conflicts.slice(0, 5).join(", ")}`,
        {
          hint: "Import into a project whose .montash/history is empty (audit restore), or export from there first.",
          detail: { conflicts },
        },
      );

    for (const o of objects) {
      const actual = this.hash(o.value);
      if (actual !== o.hash)
        throw new MontashError("E_HISTORY_CORRUPT", `object ${o.hash} in the export hashes to ${actual}`, {
          detail: { hash: o.hash, actual },
        });
      await this.store.putObject(o.value);
    }
    const mergedOps = [...s.ops.map((o) => ({ ...o, commit: null })), ...ops].sort(byIdNumber);
    const mergedCommits = [...s.commits, ...commits].sort(byIdNumber);
    await this.store.writeOps(mergedOps);
    await this.store.writeCommits(mergedCommits);
    await this.store.writeMoves([...s.moves, ...moves]);
    const mergedTags = { ...s.tags, ...tags };
    await this.store.writeTags(mergedTags);
    if (reset !== null) {
      const incoming = reset as ResetState;
      await this.store.writeReset({
        ignored: [...new Set([...s.reset.ignored, ...incoming.ignored])],
        entries: [...s.reset.entries, ...incoming.entries],
      });
    }
    if (s.head === null && head !== null) await this.store.setHead(head);
    const finalHead = await this.store.getHead();
    return {
      counts: {
        ops: mergedOps.length,
        commits: mergedCommits.length,
        moves: s.moves.length + moves.length,
        tags: Object.keys(mergedTags).length,
        objects: objects.length,
      },
      added: {
        ops: ops.length,
        commits: commits.length,
        moves: moves.length,
        tags: Object.keys(tags).length,
        objects: objects.length,
      },
      head: finalHead,
    };
  }

  // ---- verify ----

  /** docs/11 §7 の不変条件 1, 2, 4（＋ HEAD と object 内容ハッシュ）を検証する */
  async verify(): Promise<VerifyResult> {
    const problems: string[] = [];
    let s: Snapshot;
    try {
      s = await this.load();
    } catch (err) {
      const e = err instanceof MontashError ? err : null;
      problems.push(e ? `${e.code}: ${e.message}` : String(err));
      return { ok: false, problems };
    }

    // 1. objects の存在と内容ハッシュ
    const hashes = new Set<string>();
    for (const op of s.ops) {
      hashes.add(op.before);
      hashes.add(op.after);
    }
    for (const hash of hashes) {
      let value: unknown;
      try {
        value = await this.store.getObject(hash);
      } catch (err) {
        problems.push(`object ${hash} is missing or unreadable${err instanceof MontashError ? ` (${err.code})` : ""}`);
        continue;
      }
      const actual = this.hash(value);
      if (actual !== hash) problems.push(`object ${hash} content hashes to ${actual}`);
    }

    // 2. DAG の連続性・ID の重複
    const seen = new Set<string>();
    // `history prune` で行が減ることがあるので「連番」ではなく「重複なく増加する」ことだけを見る
    let lastOpNumber = 0;
    s.ops.forEach((op, i) => {
      const n = idNumber(op.id);
      if (!/^o_\d{4,}$/.test(op.id)) problems.push(`op #${i + 1} has a malformed id ${op.id}`);
      else if (n <= lastOpNumber) problems.push(`op #${i + 1} (${op.id}) does not come after the previous op`);
      lastOpNumber = Math.max(lastOpNumber, n);
      if (seen.has(op.id)) problems.push(`duplicate op id ${op.id}`);
      seen.add(op.id);
      if (op.parent !== null) {
        const parent = s.index.byId.get(op.parent);
        if (!parent) problems.push(`${op.id}.parent ${op.parent} does not exist`);
        else if (parent.after !== op.before)
          problems.push(`${op.id}.before (${op.before}) != ${parent.id}.after (${parent.after})`);
        if (parent && (s.index.order.get(parent.id) ?? 0) >= i)
          problems.push(`${op.id}.parent ${op.parent} appears later in ops.jsonl`);
      }
    });

    // HEAD
    if (s.head !== null && !s.index.byId.has(s.head)) problems.push(`HEAD points to unknown op ${s.head}`);
    if (s.head === null && s.ops.length > 0) problems.push("HEAD is empty but ops exist");

    // 4. コミットの連続性
    const committed = new Map<string, string>();
    let lastCommitNumber = 0;
    s.commits.forEach((c, i) => {
      const n = idNumber(c.id);
      if (!/^k_\d{4,}$/.test(c.id)) problems.push(`commit #${i + 1} has a malformed id ${c.id}`);
      else if (n <= lastCommitNumber) problems.push(`commit #${i + 1} (${c.id}) does not come after the previous one`);
      lastCommitNumber = Math.max(lastCommitNumber, n);
      const parentCommit = c.parent === null ? null : (s.commits.find((p) => p.id === c.parent) ?? null);
      if (c.parent !== null && !parentCommit) problems.push(`${c.id}.parent ${c.parent} does not exist`);
      if (!s.index.byId.has(c.head)) problems.push(`${c.id}.head ${c.head} does not exist`);
      for (const [j, id] of c.ops.entries()) {
        const op = s.index.byId.get(id);
        if (!op) {
          problems.push(`${c.id} includes unknown op ${id}`);
          continue;
        }
        const prev = committed.get(id);
        if (prev !== undefined) problems.push(`op ${id} belongs to both ${prev} and ${c.id}`);
        committed.set(id, c.id);
        if (j === 0) {
          // 先頭 op から遡って最初に見つかるコミット済み op が親コミットに属すること。
          // 途中に未コミット op（`--last` で残したもの）や、親コミット途中からの分岐があってもよい。
          const nearest = ancestors(s.index, id).find((a) => s.commitOf.has(a));
          const nearestCommitId = nearest === undefined ? null : (s.commitOf.get(nearest) ?? null);
          const expected = c.parent;
          if (nearestCommitId !== expected) {
            problems.push(
              `${c.id}: first op ${id} descends from ${nearest === undefined ? "the root" : `${nearest} (${nearestCommitId})`} but ${c.id}.parent is ${expected ?? "null"}`,
            );
          }
        } else {
          const prevOp = c.ops[j - 1] as string;
          if (op.parent !== prevOp) problems.push(`${c.id}: ${id}.parent (${op.parent}) != previous op ${prevOp}`);
        }
      }
      if (c.ops.length > 0 && c.head !== c.ops[c.ops.length - 1])
        problems.push(`${c.id}.head (${c.head}) != last op ${c.ops[c.ops.length - 1]}`);
      if (c.ops.length === 0 && parentCommit) {
        // 空コミットは親コミットの head か、その子孫にいる
        if (c.head !== parentCommit.head && !descendants(s.index, parentCommit.head).has(c.head)) {
          problems.push(`${c.id} (empty) head ${c.head} is not reachable from parent commit ${parentCommit.id}`);
        }
      }
    });

    // tags
    for (const [name, tag] of Object.entries(s.tags)) {
      try {
        resolveRef(tag.target, { ...s, tags: {} });
      } catch {
        problems.push(`tag '${name}' points to unknown target ${tag.target}`);
      }
    }

    // moves
    s.moves.forEach((m, i) => {
      if (!s.index.byId.has(m.to)) problems.push(`moves.jsonl:${i + 1} moves to unknown op ${m.to}`);
    });

    return { ok: problems.length === 0, problems };
  }
}

// ---- ヘルパ ----

/** `o_0042` → 42（数値部分） */
function idNumber(id: string): number {
  const n = Number.parseInt(id.slice(2), 10);
  return Number.isFinite(n) ? n : 0;
}

function maxId(ids: readonly string[]): number {
  return ids.reduce((max, id) => Math.max(max, idNumber(id)), 0);
}

function byIdNumber(a: { id: string }, b: { id: string }): number {
  return idNumber(a.id) - idNumber(b.id);
}

/**
 * 変更 1 件が要素 ID に触れているか。
 * 1) path のいずれかのセグメントが ID そのもの（`/assets/x1/...`）
 * 2) path の接頭辞が指すオブジェクト（after、無ければ before）の `id` が一致（`/tracks/0/clips/2/in_f`）
 * 3) 追加・削除された値そのものの `id` が一致
 */
function changeTouches(change: Change, element: string, after: unknown, before: unknown): boolean {
  const tokens = parsePointer(change.path);
  if (tokens.includes(element)) return true;
  for (let i = tokens.length; i > 0; i--) {
    const prefix = `/${tokens.slice(0, i).map(escapeToken).join("/")}`;
    for (const snapshot of [after, before]) {
      if (snapshot === null || snapshot === undefined) continue;
      const at = getAt(snapshot, prefix);
      if (at.found && idOf(at.value) === element) return true;
    }
  }
  return idOf(change.value) === element || idOf(change.from) === element;
}

function idOf(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/** スナップショットに含まれる `id` と `assets` のキーを集める（blame の候補提示用） */
function collectIds(value: unknown, out: Set<string> = new Set()): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out);
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === "string") out.add(obj.id);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "object" && v !== null) collectIds(v, out);
      else if (k === "id" && typeof v === "string") out.add(v);
    }
    if (typeof obj.assets === "object" && obj.assets !== null && !Array.isArray(obj.assets))
      for (const k of Object.keys(obj.assets)) out.add(k);
  }
  return [...out];
}

/** 最後のコミット以降で headId の祖先（自身を含む）にある op。時系列順 */
function pendingOps(s: Snapshot, headId: string): Op[] {
  const out: Op[] = [];
  for (const id of pathToRoot(s.index, headId)) {
    if (s.commitOf.has(id)) break;
    const op = s.index.byId.get(id);
    if (op) out.push(op);
  }
  return out.reverse();
}

/** opId から遡って最初に見つかるコミット（opId 自身を含む） */
function nearestCommit(s: Snapshot, opId: string): string | null {
  for (const id of pathToRoot(s.index, opId)) {
    const c = s.commitOf.get(id);
    if (c !== undefined) return c;
  }
  return null;
}

/** コミットの before（先頭 op の before）/ after（head の after）。空コミットは差分なし */
function commitRange(s: Snapshot, commit: Commit): { before: string; after: string } {
  const head = s.index.byId.get(commit.head) as Op;
  const first = commit.ops.length > 0 ? s.index.byId.get(commit.ops[0] as string) : undefined;
  return { before: first ? first.before : head.after, after: head.after };
}

/** `--ops` で指定された op が pending の末尾側の連続部分であることを検証して返す */
function selectSuffix(pending: Op[], ids: string[]): Op[] {
  if (ids.length === 0) return [];
  const pendingIds = pending.map((o) => o.id);
  const unknown = ids.filter((id) => !pendingIds.includes(id));
  if (unknown.length > 0) {
    throw new MontashError(
      "E_USAGE",
      `op${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not pending`,
      {
        hint: pendingIds.length > 0 ? `Pending ops: ${pendingIds.join(", ")}.` : "There are no pending ops.",
        detail: { unknown, pending: pendingIds },
      },
    );
  }
  const sorted = [...new Set(ids)].sort((a, b) => pendingIds.indexOf(a) - pendingIds.indexOf(b));
  const start = pendingIds.indexOf(sorted[0] as string);
  const expected = pendingIds.slice(start);
  if (sorted.length !== expected.length || sorted.some((id, i) => id !== expected[i])) {
    throw new MontashError(
      "E_USAGE",
      `--ops must select a contiguous range ending at HEAD (${pendingIds[pendingIds.length - 1]})`,
      {
        hint: `For example --ops ${expected[0]}..${expected[expected.length - 1]}, or --last ${expected.length}.`,
        detail: { selected: sorted, pending: pendingIds },
      },
    );
  }
  return pending.slice(start);
}

const CLIP_ELEMENT = /^\/tracks\/[^/]+\/clips\/[^/]+$/;
const CLIP_FIELD = /^(\/tracks\/[^/]+\/clips\/[^/]+)\//;

/** changes からクリップ数の増減を概算する */
export function computeStats(ops: Op[]): CommitStats {
  let added = 0;
  let removed = 0;
  const modified = new Set<string>();
  for (const op of ops) {
    for (const c of op.changes) {
      if (CLIP_ELEMENT.test(c.path)) {
        if (c.op === "add") added++;
        else if (c.op === "remove") removed++;
        else modified.add(c.path);
      } else {
        const m = CLIP_FIELD.exec(c.path);
        if (m) modified.add(m[1] as string);
      }
    }
  }
  return { ops: ops.length, clips_added: added, clips_removed: removed, clips_modified: modified.size };
}

/**
 * 規則ベースのコミットメッセージ（`--auto-message`。LLM は使わない）。
 * op の summary を連結し、affects.range_f を `f:from–to` で付記する。
 */
export function autoMessage(ops: Op[]): string {
  if (ops.length === 0) return "(empty commit)";
  const summaries = [...new Set(ops.map((o) => o.summary.trim()).filter((s) => s !== ""))];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const op of ops) {
    if (op.affects.range_f) {
      lo = Math.min(lo, op.affects.range_f[0]);
      hi = Math.max(hi, op.affects.range_f[1]);
    }
  }
  const head = summaries.length > 0 ? summaries.join(", ") : `${ops.length} op${ops.length === 1 ? "" : "s"}`;
  return Number.isFinite(lo) && Number.isFinite(hi) ? `${head} — f:${lo}–${hi} に影響` : head;
}

function nothingToCommit(allowEmpty: boolean): MontashError {
  return new MontashError(
    "E_NOTHING_TO_COMMIT",
    allowEmpty ? "history is empty; nothing to commit" : "no pending ops to commit",
    {
      hint: allowEmpty
        ? "Record at least one op first."
        : "Use --allow-empty to create a milestone commit without ops.",
    },
  );
}

function nothingTo(kind: "undo" | "redo", available: number, requested: number): MontashError {
  const code = kind === "undo" ? "E_NOTHING_TO_UNDO" : "E_NOTHING_TO_REDO";
  const message =
    available === 0
      ? `nothing to ${kind}`
      : `cannot ${kind} ${requested} step${requested === 1 ? "" : "s"}: only ${available} available`;
  return new MontashError(code, message, {
    hint:
      available > 0
        ? `Use \`montash ${kind} ${available}\`.`
        : kind === "undo"
          ? "HEAD is at the root of the history."
          : "HEAD is at the tip of its branch. See `montash log --all` for other branches.",
    detail: { available, requested },
  });
}
