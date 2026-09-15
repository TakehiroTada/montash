/**
 * ffmpeg 機能要求の合成（docs/08 §2, docs/13 D-18 / 計画 P0-6）。
 *
 * `ffmpeg/locate.ts` の `REQUIRED_FILTERS` / `RECOMMENDED_FILTERS` は組み込みが必要とする最小集合で、
 * 拡張（将来のプラグインや宣言エフェクト）は「自分が必要とする ffmpeg のフィルタ／エンコーダ」を
 * ここに登録する。`doctor` はその合成結果を検査するので、拡張を入れた環境では不足が検出される。
 *
 * **このモジュールは何も import しない。** `locate.ts` から読まれるため、
 * cli / core / ffmpeg のどれに依存しても循環 import の種になる（docs/13 D-18）。
 */

/** 拡張が宣言する ffmpeg 機能要求 */
export interface FeatureRequirements {
  /** 無いと動かないフィルタ */
  filters?: readonly string[];
  /** 無いと動かないエンコーダ */
  encoders?: readonly string[];
  /** 無くても動くが機能が制限されるフィルタ */
  recommendedFilters?: readonly string[];
}

/**
 * 登録は id で上書き・取り消しできる（同じ拡張の二重登録を避ける）。
 *
 * 枠を 2 つに分けている:
 *   - `builtinRegistered`: 組み込み機能（組み込みエフェクトなど）が宣言したもの。**常に有効**
 *   - `registered`: 拡張（プラグイン・宣言エフェクト）が宣言したもの。テストの `clear` で捨てられる
 *
 * 組み込みの要求がテストの後片付けで消えると `doctor` の検査が静かに弱くなるため、別枠にしてある。
 */
const builtinRegistered = new Map<string, FeatureRequirements>();
const registered = new Map<string, FeatureRequirements>();

export function registerRequirements(
  id: string,
  requires: FeatureRequirements,
  source: "builtin" | "plugin" = "plugin",
): void {
  (source === "builtin" ? builtinRegistered : registered).set(id, requires);
}

export function unregisterRequirements(id: string): void {
  registered.delete(id);
}

/** テスト用。**拡張由来**の要求をすべて捨てる（組み込みは残る） */
export function clearRegisteredRequirements(): void {
  registered.clear();
}

export function registeredRequirements(): ReadonlyMap<string, FeatureRequirements> {
  return new Map([...builtinRegistered, ...registered]);
}

/**
 * 組み込みの集合を先頭に置いたまま、登録済みの宣言を後ろに足す（重複は落とす）。
 * 登録が空なら `builtin` と完全に同じ並びになる（= 従来の挙動）。
 */
function compose(
  builtin: readonly string[],
  pick: (r: FeatureRequirements) => readonly string[] | undefined,
): string[] {
  const out = [...builtin];
  const seen = new Set(out);
  for (const requires of [...builtinRegistered.values(), ...registered.values()]) {
    for (const name of pick(requires) ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** 必須フィルタ = 組み込み + 登録済みの `filters` */
export function requiredFilters(builtin: readonly string[]): string[] {
  return compose(builtin, (r) => r.filters);
}

/** 必須エンコーダ = 組み込み + 登録済みの `encoders` */
export function requiredEncoders(builtin: readonly string[]): string[] {
  return compose(builtin, (r) => r.encoders);
}

/**
 * 推奨フィルタ = 組み込み + 登録済みの `recommendedFilters`。
 * 必須側に含まれるものは推奨から落とす（`doctor` が同じ名前を二重に報告しないため）。
 */
export function recommendedFilters(builtin: readonly string[], required: readonly string[] = []): string[] {
  const req = new Set(required);
  return compose(builtin, (r) => r.recommendedFilters).filter((n) => !req.has(n));
}
