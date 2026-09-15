/**
 * プラグインの契約（docs/14、`docs/plans/2026-09-15-plugin-architecture.md` Phase 2）。
 *
 * **プラグインは montash のモジュールを import しない。**
 * `bun build --compile` で作った単一バイナリの中のモジュールは外から解決できないため
 * （P2-3 で実測: `import "montash/plugin-api"` は `Cannot find module` になる）、
 * ホストが `register(host)` の引数で API を渡す。AviUtl2 の `RegisterPlugin(HOST_APP_TABLE*)`
 * と同じ形。プラグインは自己完結した JS / TS モジュールとして書けばよい。
 *
 * 型だけは npm の `montash/plugin-api` を devDependency として配れる（型は実行時に不要）。
 */
import type { EffectSpec } from "../registry/effects.ts";
import type { GeneratorSpec } from "../registry/generators.ts";
import type { FeatureRequirements } from "../registry/requirements.ts";
import type { TransitionSpec } from "../registry/transitions.ts";

/** ホストが受け入れるプラグイン API のバージョン。破壊的変更のときだけ上げる */
export const PLUGIN_API_VERSION = 1;
/** 後方 1 つ前までは受け入れる（docs/13 C-10 の互換方針） */
export const MIN_PLUGIN_API_VERSION = 1;

/**
 * プラグインが宣言する能力（docs/14 の Level A/B/C）。
 * 宣言しない限りホストは何も許可しない。導入時に人間へ提示する。
 */
export type PluginCapability = "analyze" | "process";

/** `montash-plugin.json` の中身 */
export interface PluginManifest {
  /** 逆ドメイン形式の一意な ID（例: com.example.glow） */
  id: string;
  /** 表示名 */
  name?: string;
  /** プラグイン自身のバージョン（semver 推奨。ホストは解釈しない） */
  version?: string;
  /** 要求する montash プラグイン API のバージョン */
  apiVersion: number;
  description?: string;
  /** エントリポイント（マニフェストからの相対パス）。既定は index.js */
  main?: string;
  /** 必要な ffmpeg の機能。doctor が検査する */
  requires?: FeatureRequirements;
  /** 要求する能力。宣言が無ければ純関数のみ（Level A/B） */
  capabilities?: PluginCapability[];
  /** Web から実行を許可したいコマンド（Phase 3 で許可リストへ合成） */
  webAllow?: string[];
}

/**
 * `register(host)` に渡る API テーブル。
 * **プラグインが project.json を直接書き換える手段は与えない**（変更は必ず op 経由。N-15）。
 */
export interface PluginHost {
  /** このホストのプラグイン API バージョン */
  readonly apiVersion: number;
  /** 呼び出し元のプラグイン（自分自身）のマニフェスト */
  readonly manifest: Readonly<PluginManifest>;
  /** 宣言した能力（宣言していないものは false） */
  readonly capabilities: Readonly<Record<PluginCapability, boolean>>;
  /** 拡張点への登録。いずれも `source: "plugin"` として入る */
  readonly effects: { define(spec: EffectSpec): void };
  readonly generators: { define(spec: GeneratorSpec): void };
  readonly transitions: { define(spec: TransitionSpec): void };
  /** 追加の ffmpeg 機能要求（マニフェストの `requires` に足す） */
  requireFeatures(requires: FeatureRequirements): void;
  /** 診断ログ（`--verbose` のときだけ出る） */
  log(message: string): void;
}

/** プラグインのデフォルトエクスポート */
export interface PluginModule {
  /** マニフェストと重複する場合はマニフェストが優先（マニフェストが正） */
  id?: string;
  apiVersion?: number;
  /** 登録の入口。ここで host 経由の登録を行う */
  register(host: PluginHost): void | Promise<void>;
}

/** 読み込み済みプラグインの記録 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** マニフェストのあるディレクトリ */
  dir: string;
  /** 実際に読み込んだエントリのパス */
  entry: string;
  /** 登録された拡張の内訳 */
  registered: { effects: string[]; generators: string[]; transitions: string[] };
}
