/**
 * 拡張点レジストリの共通基盤（docs/13 D-16、`docs/plans/2026-09-15-plugin-architecture.md` P0-4）。
 *
 * montash の拡張点は「**組み込みの Record** + **外部由来の Record をマージ** + **出自ラベル**」という
 * 同じ形を繰り返し使う（`text_presets` / `render_presets` / 位置プリセット …）。その形を 1 か所に
 * 括り出したのがこのファイルで、**組み込み機能も同じレジストリを通す**（14 章の方針）。
 *
 * - 供給元は `builtin` / `project` / `plugin` の 3 種。`plugin` は型だけ用意してあり、
 *   実際の登録経路は Phase 2（`register()` を呼ぶのはプラグインローダになる）。
 * - マージは **後勝ち**。外部由来が同名の組み込みを置き換えたエントリは `overridden: true` になる。
 * - `merge()` に渡る `ctx.resolve()` で解決中の表を引けるので、`render_presets` の `base` 継承のような
 *   相互参照が書ける。循環は `loop()` のエラーになる。
 * - メッセージの文面は利用側ごとに違う（既存の出力を変えないため）ので、エラー生成は差し替え可能にしてある。
 *
 * 依存方向: このモジュールは `core/` の型と `cli/errors.ts` にしか依存しない（`ffmpeg/` を import しない）。
 * `ffmpeg/graph/` からも import されるため、I/O（`node:fs` / `Bun.spawn`）は絶対に持ち込まないこと。
 */
import { MontashError } from "../cli/errors.ts";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** 供給元。`plugin` は Phase 2 で使う（現状は型だけ） */
export type RegistrySource = "builtin" | "project" | "plugin";

export interface RegistryEntry<T> {
  name: string;
  value: T;
  source: RegistrySource;
  /** 同名の登録済みエントリを外部由来が置き換えたか（`text presets` の `overridden` 表示に使う） */
  overridden: boolean;
}

export interface MergeContext<T> {
  /** いま解決しているエントリ名 */
  name: string;
  /** 解決中の表から名前で引く（`base` 継承などの相互参照用。循環は `loop()` のエラー） */
  resolve(name: string): T;
}

/**
 * 外部由来の生値をエントリの値に変換する。
 * `base` は同名の登録済みエントリ（無ければ `undefined`）。既定は浅いマージ（後勝ち）。
 */
export type MergeFn<T> = (base: T | undefined, raw: unknown, ctx: MergeContext<T>) => T;

export interface RegistryOptions<T> {
  /** エラーメッセージに出す単数形の呼び名（例: `"render preset"`） */
  label: string;
  /** 組み込みエントリ */
  builtin?: Readonly<Record<string, T>>;
  /** 外部由来の生値 → 値。既定は `{ ...base, ...raw }` */
  merge?: MergeFn<T>;
  /** 外部由来で受け取れるキー（docs/05 §9 の許可キー制限）。省略時は無制限 */
  allowedKeys?: readonly string[];
  /** 一覧を名前順に並べる（既定は登録順 → 外部由来の追加順） */
  sorted?: boolean;
  /** 未知名のエラー */
  notFound?: (name: string, known: readonly string[]) => MontashError;
  /** 相互参照が循環したときのエラー */
  loop?: (name: string) => MontashError;
  /** 許可キー以外が含まれていたときのエラー */
  unknownKeys?: (name: string, keys: readonly string[], allowed: readonly string[]) => MontashError;
}

/** 外部由来をマージし終えた表（読み取り専用） */
export interface ResolvedRegistry<T> {
  entries(): RegistryEntry<T>[];
  /** 名前 → 値の Record（登録順。`sorted` なら名前順） */
  record(): Record<string, T>;
  names(): string[];
  has(name: string): boolean;
  get(name: string): T | undefined;
  /** 無ければ `notFound()` を投げる */
  require(name: string): T;
  entry(name: string): RegistryEntry<T> | undefined;
}

export interface Registry<T> extends ResolvedRegistry<T> {
  readonly label: string;
  /** 組み込み（および Phase 2 のプラグイン）を登録する。同名は後勝ち */
  register(name: string, value: T, source?: RegistrySource): void;
  /** 外部由来の Record をマージした表を返す（レジストリ自体は変更しない） */
  resolve(external?: Readonly<Record<string, unknown>> | null): ResolvedRegistry<T>;
}

// ---------------------------------------------------------------------------
// 実装
// ---------------------------------------------------------------------------

function shallowMerge<T>(base: T | undefined, raw: unknown): T {
  if (base === undefined) return { ...(raw as object) } as T;
  return { ...(base as object), ...(raw as object) } as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createRegistry<T>(options: RegistryOptions<T>): Registry<T> {
  const label = options.label;
  const merge: MergeFn<T> = options.merge ?? ((base, raw) => shallowMerge(base, raw));

  const notFound = (name: string, known: readonly string[]): MontashError => {
    const unique = [...new Set(known)];
    if (options.notFound) return options.notFound(name, unique);
    return new MontashError("E_PRESET_NOT_FOUND", `unknown ${label} '${name}'`, {
      hint: `Known ${label}s: ${unique.join(", ")}.`,
      detail: { name, known: unique },
    });
  };
  const loop = (name: string): MontashError =>
    options.loop?.(name) ??
    new MontashError("E_USAGE", `${label} '${name}' inherits from itself (base loop)`, {
      detail: { name },
    });
  const unknownKeys = (name: string, keys: readonly string[], allowed: readonly string[]): MontashError =>
    options.unknownKeys?.(name, keys, allowed) ??
    new MontashError("E_USAGE", `${label} '${name}' has unknown key(s): ${keys.join(", ")}`, {
      hint: `Supported keys: ${allowed.join(", ")}.`,
      detail: { name, unknown: [...keys] },
    });

  /** 登録済み（外部マージ前）。Map は挿入順を保つ */
  const registered = new Map<string, RegistryEntry<T>>();
  for (const [name, value] of Object.entries(options.builtin ?? {}))
    registered.set(name, { name, value, source: "builtin", overridden: false });

  const order = (entries: RegistryEntry<T>[]): RegistryEntry<T>[] =>
    options.sorted ? [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : entries;

  const view = (map: Map<string, RegistryEntry<T>>): ResolvedRegistry<T> => ({
    entries: () => order([...map.values()]),
    record: () => {
      const out: Record<string, T> = {};
      for (const e of order([...map.values()])) out[e.name] = e.value;
      return out;
    },
    names: () => order([...map.values()]).map((e) => e.name),
    has: (name) => map.has(name),
    get: (name) => map.get(name)?.value,
    entry: (name) => map.get(name),
    require: (name) => {
      const hit = map.get(name);
      if (!hit)
        throw notFound(
          name,
          order([...map.values()]).map((e) => e.name),
        );
      return hit.value;
    },
  });

  const resolve = (external?: Readonly<Record<string, unknown>> | null): ResolvedRegistry<T> => {
    const user = external ?? {};
    const map = new Map(registered);
    const resolving = new Set<string>();
    /**
     * この解決パスで外部由来をすでにマージし終えた名前（docs/13 D-20）。
     *
     * 以前はここを `existing.source !== "builtin"` で判定していた。そのため
     * **`register()` で入った `plugin` 由来のエントリが外部由来のマージ対象から丸ごと外れ**、
     * 同名の `render_presets` を書いても差し替わらなかった（D-20 の (2)）。
     * 「解決済みか」は供給元ではなく、このパスの進行状況で決める。
     */
    const resolved = new Set<string>();

    const resolveOne = (name: string): RegistryEntry<T> => {
      const existing = map.get(name);
      // 外部由来に同名が無ければ登録済みのまま／すでにこのパスで解決済みならそれを返す
      if (existing && (!Object.hasOwn(user, name) || resolved.has(name))) return existing;
      const raw = user[name];
      if (raw === undefined) {
        if (existing) return existing;
        throw notFound(name, [...map.keys(), ...Object.keys(user)]);
      }
      if (resolving.has(name)) throw loop(name);
      if (options.allowedKeys && isPlainRecord(raw)) {
        const allowed = options.allowedKeys;
        const bad = Object.keys(raw).filter((k) => !allowed.includes(k));
        if (bad.length > 0) throw unknownKeys(name, bad, allowed);
      }
      resolving.add(name);
      let value: T;
      try {
        value = merge(existing?.value, raw, { name, resolve: (n) => resolveOne(n).value });
      } finally {
        resolving.delete(name);
      }
      const entry: RegistryEntry<T> = { name, value, source: "project", overridden: existing !== undefined };
      map.set(name, entry);
      resolved.add(name);
      return entry;
    };

    for (const name of Object.keys(user)) resolveOne(name);
    return view(map);
  };

  const base = view(registered);
  return {
    label,
    register(name, value, source = "builtin") {
      registered.set(name, { name, value, source, overridden: false });
    },
    resolve,
    entries: base.entries,
    record: base.record,
    names: base.names,
    has: base.has,
    get: base.get,
    entry: base.entry,
    require: base.require,
  };
}
