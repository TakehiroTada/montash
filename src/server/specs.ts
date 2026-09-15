/**
 * `GET /api/specs`（docs/06 §3.2、計画 P3-2）。
 *
 * Web の Inspector が **フォームを自動生成する**ための定義をまとめて返す読み取り API。
 * 中身は 2 つで、どちらも CLI が既に持っているものをそのまま出す:
 *
 *   - `commands`: `montash schema --json` と同じ（`getCommands()` → `toSchema()`）。
 *     組み込み + プラグインが登録したコマンドが合成済みなので、Web に別リストを持たなくて済む。
 *   - `effects`: `montash effect presets --json` と同じ形（レジストリのパラメータ定義）。
 *     `EffectParamSpec` 1 つから number / string(choices) / boolean の入力が決まる。
 *
 * **これが `/api/cli-examples` の置き換えでもある**（docs/06 §3.6）。コマンド例をサーバで文字列に
 * 組み立てるのではなく、定義そのものを 1 本の API で渡して UI 側で組ませる。選択状態（クリップ ID・
 * 再生ヘッド）は刻々と変わるのに定義は起動中不変なので、そのほうがリクエストも減る。
 *
 * この API は読み取り専用で、`--read-only` でも返す（何も変更しない）。
 *
 * 依存方向の注記（docs/08 §2）: ここは `registry/`（コマンド・エフェクトの合成リスト）と
 * `cli/define-command.ts`（`toSchema` = schema 出力の 1 実装）を読む。`montash schema` と
 * 1 文字でも食い違うと Web のフォームが CLI と別物になるため、serializer を複製しない。
 */
import { type CommandSchema, toSchema } from "../cli/define-command.ts";
import { getCommands } from "../registry/commands.ts";
import type { EffectParamSpec, EffectTarget } from "../registry/effects.ts";
import { effectRegistry } from "../registry/effects.ts";

/** `effect presets --json` の 1 件（docs/04 §effect） */
export interface EffectSchema {
  name: string;
  target: EffectTarget;
  /** builtin / project / plugin */
  source: string;
  summary: string;
  /** 必要な ffmpeg フィルタ（`doctor` の検査対象） */
  requires: string[];
  params: Record<string, EffectParamSchema>;
}

export interface EffectParamSchema {
  type: EffectParamSpec["type"];
  describe: string;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  choices?: string[];
  required?: boolean;
}

export interface SpecsResponse {
  /** サーバ（= montash）のバージョン。UI が定義の世代を見分けるため */
  version: string;
  commands: CommandSchema[];
  effects: EffectSchema[];
}

/** `EffectParamSpec` を JSON へ（未指定のキーは落とす。`effect presets` と同じ並び） */
function paramSchema(p: EffectParamSpec): EffectParamSchema {
  return {
    type: p.type,
    describe: p.describe,
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.choices ? { choices: [...p.choices] } : {}),
    ...(p.required ? { required: true } : {}),
  };
}

/** 登録済みのエフェクトを video → audio の順に並べる（レジストリ内は名前順） */
export function effectSchemas(): EffectSchema[] {
  const targets: EffectTarget[] = ["video", "audio"];
  return targets.flatMap((target) =>
    effectRegistry(target)
      .entries()
      .map((e) => ({
        name: e.name,
        target,
        source: e.source,
        summary: e.value.summary,
        requires: [...(e.value.requires ?? [])],
        params: Object.fromEntries(Object.entries(e.value.params ?? {}).map(([k, p]) => [k, paramSchema(p)])),
      })),
  );
}

/**
 * `GET /api/specs` の本体。
 * コマンドの合成（`getCommands()`）は組み込み定義を遅延 import するので async。
 */
export async function collectSpecs(version: string): Promise<SpecsResponse> {
  const commands = await getCommands();
  return { version, commands: commands.map(toSchema), effects: effectSchemas() };
}
