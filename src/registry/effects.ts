/**
 * エフェクトレジストリ（docs/13 D-15、`docs/plans/2026-09-15-plugin-architecture.md` P0-3）。
 *
 * montash のエフェクトは **ピクセルを触らない**。`params` から **ffmpeg のフィルタ片を返す純関数**
 * （`build()`）として定義し、レンダー時にクリップのフィルタチェーンへ差し込む（14 章の方針）。
 * これにより:
 *   - `preview` のセグメントキャッシュは `filterComplex` 由来の指紋なので**自動的に正しく無効化**される
 *   - `--dry-run` でそのままフィルタ文字列を確認できる
 *   - `graph/` の純粋性（`node:fs` も `Bun.spawn` も持ち込まない）が保たれる
 *
 * 組み込みのエフェクトも**例外なくこのレジストリを通す**（`color` が最初の実例）。
 * プラグインからの登録経路は Phase 2 で、`register(name, spec, "plugin")` を呼ぶのがローダになる。
 *
 * I/O を要するエフェクト（事前解析が必要なもの）は、ダッキングや loudnorm と同じく
 * 「解析結果を値で `GraphOptions` に注入する」形にする（Phase 2 の Level C）。
 */
import { MontashError } from "../cli/errors.ts";
import type { Fps, Resolution } from "../core/schema.ts";
import { createRegistry, type Registry } from "./index.ts";
import { registerRequirements } from "./requirements.ts";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type EffectTarget = "video" | "audio";

/**
 * パラメータ定義。これ 1 つから CLI オプション・`schema`・`help`・Web のフォームを導出する
 * （AviUtl の「トラックバーを登録すると UI が出る」に相当。Phase 1 で `effect` コマンドが使う）。
 */
export interface EffectParamSpec {
  type: "number" | "string" | "boolean";
  describe: string;
  default?: number | string | boolean;
  /** number のとき */
  min?: number;
  max?: number;
  /** string のとき */
  choices?: readonly string[];
  required?: boolean;
}

/** `build()` に渡る読み取り専用の文脈（I/O は一切渡さない） */
export interface EffectBuildContext {
  fps: Fps;
  resolution: Resolution;
  /** クリップがタイムライン上で占めるフレーム数 */
  frames: number;
  /** 音声のサンプルレート */
  sampleRate: number;
  /**
   * `analyze()` の結果（Level C のエフェクトのみ）。
   * 解析が済んでいない／不要な場合は undefined で、`build()` は既定の挙動に落とす。
   */
  analysis?: unknown;
}

export interface EffectSpec {
  name: string;
  target: EffectTarget;
  summary: string;
  params?: Record<string, EffectParamSpec>;
  /** 必要な ffmpeg フィルタ（`doctor` が検査する） */
  requires?: readonly string[];
  /**
   * パラメータ → フィルタ片の配列（純関数）。
   * 受け取る `params` は既定値の適用と範囲検査が済んでいる。
   *
   * `analyze` を持つエフェクトでは、`ctx.analysis` にレンダー前の測定結果が入る。
   */
  build(params: Readonly<Record<string, unknown>>, ctx: EffectBuildContext): string[];
  /**
   * **Level C**: レンダーの前に 1 度だけ走る測定パス（docs/14 §4）。
   *
   * loudnorm / ducking と同じ「解析は外でやり、結果を値で注入する」形にすることで、
   * `build()` の純粋性と preview のキャッシュ整合を保つ。
   * プラグインが持つ場合は**マニフェストで `capabilities: ["analyze"]` の宣言が要る**。
   * 宣言していないエフェクトの `analyze` はホストが呼ばない。
   */
  analyze?(params: Readonly<Record<string, unknown>>, ctx: EffectAnalyzeContext): Promise<unknown>;
  /**
   * このエフェクトが `params` から参照する**外部ファイル**のパスを申告する（docs/13 D-19）。
   *
   * `preview` のセグメントキャッシュ指紋は `filterComplex` 由来なので、ファイル**パス**が変われば
   * 無効化されるが、同じパスのまま**中身**を差し替えても無効化されない。そこで申告されたファイルの
   * mtime / size を指紋へ混ぜる（`ffmpeg/effect-files.ts` が stat し、`ffmpeg/preview.ts` が混ぜる）。
   *
   * - **純関数であること。** ここで `node:fs` を触ってはいけない（`registry/` に I/O は持ち込まない）。
   *   存在確認もしない — 返すのは「パスとして宣言されている文字列」だけ。
   * - 相対パスはプロジェクトディレクトリ基準として解決される（アセットのパスと同じ規則）。
   * - **申告しないエフェクトの指紋は従来どおり**（何も混ざらない）。
   */
  externalFiles?(params: Readonly<Record<string, unknown>>): readonly string[];
}

/** `analyze()` に渡る文脈。ffmpeg の実行はホストが仲介する（プラグインは直接起動しない） */
export interface EffectAnalyzeContext extends EffectBuildContext {
  /** 解析対象クリップの入力ファイル（絶対パス） */
  readonly source: string;
  /** 素材から切り出す範囲（フレーム） */
  readonly srcIn: number;
  readonly srcOut: number;
  /**
   * ffprobe / ffmpeg のフィルタを 1 度だけ走らせて stderr を受け取る。
   * **ホストが引数を組み立てる**ので、プラグインが任意のコマンドを実行することはできない。
   */
  probe(filter: string): Promise<string>;
}

export function defineEffect(spec: EffectSpec): EffectSpec {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`invalid effect name: "${spec.name}"`);
  return spec;
}

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

function notFound(target: EffectTarget) {
  return (name: string, known: readonly string[]): MontashError =>
    new MontashError("E_PLUGIN_MISSING", `unknown ${target} effect '${name}'`, {
      hint:
        known.length > 0
          ? `No registered plugin provides it. Known ${target} effects: ${known.join(", ")}.`
          : "No registered plugin provides it.",
      detail: { effect: name, target, known: [...known] },
    });
}

// ---------------------------------------------------------------------------
// 組み込みエフェクト
//
// **組み込みも外部プラグインとまったく同じ契約で書く**（`defineEffect` + 純関数の `build()`）。
// こうしておくと契約が常に実コードで検証され、「組み込みだけができること」が生まれない。
// ---------------------------------------------------------------------------

/**
 * 色補正。`clip.video.color` の実体でもある（従来 `graph/video.ts` の `colorFilter()` にあったもの）。
 * 出力は従来と 1 文字も変えない: 指定されたキーだけを固定順に並べた `eq=`。
 */
export const colorEffect: EffectSpec = defineEffect({
  name: "color",
  target: "video",
  summary: "adjust brightness / contrast / saturation / gamma (eq)",
  requires: ["eq"],
  params: {
    brightness: { type: "number", describe: "-1.0 .. 1.0", min: -1, max: 1 },
    contrast: { type: "number", describe: "-1000 .. 1000 (1.0 = unchanged)", min: -1000, max: 1000 },
    saturation: { type: "number", describe: "0.0 .. 3.0 (1.0 = unchanged)", min: 0, max: 3 },
    gamma: { type: "number", describe: "0.1 .. 10.0 (1.0 = unchanged)", min: 0.1, max: 10 },
  },
  build(params) {
    const parts = (["brightness", "contrast", "saturation", "gamma"] as const)
      .filter((k) => typeof params[k] === "number")
      .map((k) => `${k}=${params[k] as number}`);
    return parts.length > 0 ? [`eq=${parts.join(":")}`] : [];
  },
});

/**
 * ガウスぼかし（F-FX-7）。`gblur` は FFmpeg 3.2 以降にあり、MIN_FFMPEG（4.4）を下回らない。
 *
 * `sigma=0` は「ぼかさない」なので、`color` が空のときにフィルタを足さないのと同じく**何も出さない**
 * （無駄な 1 段を入れないことでフィルタグラフが読みやすく、`--dry-run` の差分も分かりやすい）。
 */
export const blurEffect: EffectSpec = defineEffect({
  name: "blur",
  target: "video",
  summary: "gaussian blur (gblur)",
  requires: ["gblur"],
  params: {
    sigma: { type: "number", describe: "0.0 .. 128.0 (0 = no blur)", default: 4, min: 0, max: 128 },
    steps: {
      type: "number",
      describe: "1 .. 6 (repeat count; higher = closer to a true gaussian)",
      default: 1,
      min: 1,
      max: 6,
    },
  },
  build(params) {
    const sigma = params.sigma as number;
    if (sigma === 0) return [];
    const steps = params.steps as number;
    return [`gblur=sigma=${sigma}${steps === 1 ? "" : `:steps=${steps}`}`];
  },
});

/**
 * モザイク（F-FX-7）。**`pixelize` を使い、`scale` の縮小→拡大では代替しない。**
 *
 * 判断の根拠:
 *   1. **エフェクトはフレームの大きさを変えてはいけない。** 挿入位置は `scale`/`pad` の**後ろ**（§3a）なので、
 *      ここで大きさが変わるとトラック連結（`concat`）・`xfade`・overlay がすべて壊れる。
 *      `scale=iw/n:ih/n` → `scale=iw*n:ih*n` の往復は、幅・高さが n で割り切れないときに
 *      **元の大きさへ戻らない**（例: 640/7=91 → 91*7=637）。丸めを吸収するには元の大きさを知る必要があるが、
 *      `build()` は純関数で、`fit` クリップ（= タイムライン解像度）か `native` クリップ（= 素材の大きさ）かを
 *      区別できないため、戻す先を決められない。`pixelize` は大きさを変えないのでこの問題が原理的に起きない。
 *   2. `pixelize` はブロック平均（`mode=avg`）で、`scale` の最近傍間引きより見た目が素直（間引きは
 *      細い線が消えたり残ったりしてちらつく）。
 *   3. 代償は **FFmpeg 5.1 以降が必要**なこと（MIN_FFMPEG は 4.4）。これは `requires` の宣言で
 *      `doctor` が「`pixelize` が無い」と名指しで報告する — 黙って劣化するより、不足を正しく伝える方が良い。
 */
export const mosaicEffect: EffectSpec = defineEffect({
  name: "mosaic",
  target: "video",
  summary: "pixelate in square blocks (pixelize; needs ffmpeg >= 5.1)",
  requires: ["pixelize"],
  params: {
    size: { type: "number", describe: "block size in px, 2 .. 256", default: 16, min: 2, max: 256 },
    mode: { type: "string", describe: "how each block is reduced", choices: ["avg", "min", "max"], default: "avg" },
  },
  build(params) {
    const size = Math.round(params.size as number);
    return [`pixelize=w=${size}:h=${size}:mode=${params.mode as string}`];
  },
});

/**
 * filtergraph の値に入れるパスのエスケープ（`'` で括る前提）。
 * `ffmpeg/ass.ts` の `escapeFilterValue()` と同じ規則だが、**`registry/` は `ffmpeg/` を import しない**
 * （依存方向。docs/08 §2）ので、ここに持つ。
 */
function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

/**
 * 3D LUT の適用（F-FX-4）。`lut3d` は FFmpeg 2.4 以降。
 *
 * **注意: 外部ファイルを参照する唯一の組み込みエフェクト。**
 * `preview` のセグメントキャッシュ指紋は `filterComplex` 由来（docs/07 §11）なので、LUT ファイルの
 * パスが変われば無効化されるが、**同じパスのまま中身を差し替えたときは指紋に出ない**。
 * そのため `externalFiles()` で LUT ファイルを申告し、その mtime / size を指紋へ混ぜてもらう（docs/13 D-19）。
 *
 * `build()` も `externalFiles()` も純関数なので**ファイルの存在確認はしない**（`registry/` に I/O は持ち込まない）。
 * 存在しない LUT はレンダー時に ffmpeg 側のエラーになる。
 */
export const lut3dEffect: EffectSpec = defineEffect({
  name: "lut3d",
  target: "video",
  summary: "apply a 3D LUT file (.cube / .3dl / .dat / .m3d / .csp)",
  requires: ["lut3d"],
  params: {
    file: { type: "string", describe: "path to the LUT file (.cube / .3dl / .dat / .m3d / .csp)", required: true },
    interp: {
      type: "string",
      describe: "interpolation mode",
      choices: ["nearest", "trilinear", "tetrahedral", "pyramid", "prism"],
    },
  },
  build(params) {
    const file = (params.file as string).trim();
    if (file === "")
      throw new MontashError("E_USAGE", "effect 'lut3d': file must not be empty", {
        detail: { effect: "lut3d", param: "file" },
      });
    const parts = [`file='${escapeFilterPath(file)}'`];
    if (typeof params.interp === "string") parts.push(`interp=${params.interp}`);
    return [`lut3d=${parts.join(":")}`];
  },
  externalFiles(params) {
    const file = typeof params.file === "string" ? params.file.trim() : "";
    return file === "" ? [] : [file];
  },
});

/** 反転（F-FX-3）。`hflip` / `vflip` は大きさを変えないので挿入位置の制約が無い */
export const flipEffect: EffectSpec = defineEffect({
  name: "flip",
  target: "video",
  summary: "flip horizontally / vertically (hflip, vflip)",
  requires: ["hflip", "vflip"],
  params: {
    direction: {
      type: "string",
      describe: "which axis to flip on",
      choices: ["horizontal", "vertical", "both"],
      default: "horizontal",
    },
  },
  build(params) {
    switch (params.direction as string) {
      case "vertical":
        return ["vflip"];
      case "both":
        return ["hflip", "vflip"];
      default:
        return ["hflip"];
    }
  },
});

/**
 * 90 度単位の回転（F-FX-3）。
 *
 * **90 / 270 は幅と高さが入れ替わる。** 挿入位置が `scale`/`pad` の**後ろ**（§3a）なので、そのまま
 * `transpose` だけを流すと 640x360 のクリップが 360x640 になり、`concat`（全入力が同じ大きさである必要がある）
 * や `xfade` が ffmpeg 側の分かりにくいエラーで落ちる。そこで既定（`fit: true`）では回転のあとに
 * **タイムライン解像度へ letterbox して戻す**（`normalizeVideoClip` の `fit` と同じ `scale`+`pad`）。
 *
 * overlay の `native` クリップ（素材の大きさのまま合成するもの）では戻す先がタイムライン解像度ではないので、
 * `fit: false` を指定して回転だけを掛ける（overlay は任意の大きさを受け付ける）。
 *
 * 180 は大きさが変わらないので `fit` は効かない。`transpose` を 2 回通すより `hflip,vflip` の方が安い。
 * 余白の色は `pad` の既定（黒）。`settings.background` を変えている場合だけ色が食い違う（docs/07 §3a）。
 */
export const rotateEffect: EffectSpec = defineEffect({
  name: "rotate",
  target: "video",
  summary: "rotate by 90 / 180 / 270 degrees (transpose)",
  requires: ["transpose", "hflip", "vflip"],
  params: {
    angle: { type: "string", describe: "clockwise rotation in degrees", choices: ["90", "180", "270"], required: true },
    fit: {
      type: "boolean",
      describe: "letterbox back to the timeline resolution after a 90/270 turn (off for native overlay clips)",
      default: true,
    },
  },
  build(params, ctx) {
    const angle = params.angle as string;
    if (angle === "180") return ["hflip", "vflip"];
    // transpose=1: 時計回り 90 度 / transpose=2: 反時計回り 90 度（= 時計回り 270 度）
    const out = [angle === "90" ? "transpose=1" : "transpose=2"];
    if (params.fit === true) {
      const { width, height } = ctx.resolution;
      out.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        // `force_original_aspect_ratio` は DAR を保つために **SAR を動かす**（実測: 640x360 で 405:406）。
        // `concat` は大きさだけでなく SAR も一致を要求するので、`setsar=1` で戻さないと繋がらない。
        "setsar=1",
      );
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// 組み込みエフェクト（音声）
//
// 挿入位置は `normalizeAudioClip` の `volume=…dB` のあと・`afade` の前（docs/07 §8a）。
// 映像側と同じ契約で書く（`defineEffect` + 純関数の `build()`）。
// ---------------------------------------------------------------------------

/** 小数を ffmpeg に渡す文字列にする（指数表記を避け、末尾の 0 を落とす）。`ffmpeg/graph/audio.ts` の `num()` と同じ規則だが、**`registry/` は `ffmpeg/` を import しない**（依存方向。docs/08 §2）ので、ここに持つ */
function numValue(v: number): string {
  return String(Number(v.toFixed(6)));
}

/** dB → 線形振幅（`10^(dB/20)`）。`acompressor` の threshold / makeup はこの単位（docs/07 §8.3 の `sidechaincompress` と同じ） */
function dbToAmplitude(db: number): number {
  return 10 ** (db / 20);
}

/**
 * ノイズ除去（マイクの環境ノイズ）。`afftdn`（FFT スペクトル減算）+ 任意の `highpass`。
 *
 * **`arnndn` を既定にしない判断**: `arnndn` は RNN の**学習済みモデルファイル（`.rnnn`）が必須**で、
 * ffmpeg にも montash にも同梱されない（別配布）。既定値を決められない必須パラメータを持つ組み込みは
 * 「追加した瞬間に動く」という組み込みの前提を壊すので採らない。`anlmdn` はモデル不要だが
 * 桁違いに重く、`s`（強さ）/ `p` / `r` は物理単位が無くて実用的な既定を決めにくい。
 * `afftdn` は **nr / nf が dB という測れる単位**で、既定のまま効き、実測でも効果が確認できる:
 * 無音部のノイズフロアが **-64.9dB → -74.3dB（9.4dB 低減）**（amount 10 / floor -50 / highpass 80）。
 *
 * `highpass` を同居させているのは、マイク収録のノイズ低減が実務上「低域のゴロつき（空調・机の振動）を
 * 切る」までを含む 1 手順だから。`0` で無効（`eq` エフェクトでも同じ `highpass` は掛けられる）。
 *
 * `nt=w`（白色雑音）は固定。`vinyl` / `shellac` はレコード修復用で、`custom` は `band_noise` の
 * 帯域テーブルが別途要る — どれもマイクの環境ノイズには当たらない。
 */
export const denoiseEffect: EffectSpec = defineEffect({
  name: "denoise",
  target: "audio",
  summary: "reduce microphone / room noise (afftdn, optional highpass)",
  requires: ["afftdn", "highpass"],
  params: {
    amount: {
      type: "number",
      describe: "noise reduction in dB (afftdn nr), 0.01 .. 97",
      default: 12,
      min: 0.01,
      max: 97,
    },
    floor: {
      type: "number",
      describe: "noise floor in dB (afftdn nf), -80 .. -20",
      default: -50,
      min: -80,
      max: -20,
    },
    highpass: { type: "number", describe: "cut rumble below this Hz (0 = off)", default: 80, min: 0, max: 300 },
  },
  build(params) {
    const highpass = params.highpass as number;
    return [
      ...(highpass > 0 ? [`highpass=f=${numValue(highpass)}`] : []),
      `afftdn=nr=${numValue(params.amount as number)}:nf=${numValue(params.floor as number)}:nt=w`,
    ];
  },
});

/**
 * トーン調整（ナレーションの明瞭度）。`highpass` / `lowpass` / `equalizer` の 3 段。
 *
 * **`color` と同じ「指定されたものだけを出す」規則**にしてある（既定値を持たず、何も指定が無ければ
 * フィルタを 1 つも足さない）。音の素通しを既定にするのは、トーン調整に「万人向けの既定カーブ」が
 * 無いから — 素材によって切るべき帯域が違う。
 *
 * `equalizer`（ピーキング EQ）は **`frequency` と `gain` が対**で意味を持つので、片方だけの指定は
 * 黙って無視せず `E_USAGE` にする（`--gain 3` だけ書いて何も変わらない、が一番デバッグしづらい）。
 * 幅は Q 値（`t=q`）で、既定 1 はおよそ 1.4 オクターブ。ナレーションなら 200Hz 付近を -3dB で
 * 濁りを取り、3kHz 付近を +3dB で子音を立てる、といった使い方になる。
 *
 * `lowpass` の上限は 20000Hz だが、**サンプルレートによってはナイキスト周波数を超える**。
 * 超えた指定は ffmpeg 側でクリップされるだけで害は無いので、ここでは弾かない（`build()` は純関数で、
 * `ctx.sampleRate` は見えるが、弾くと「48k では通るが 44.1k では落ちる」プロジェクトができてしまう）。
 */
export const audioEqEffect: EffectSpec = defineEffect({
  name: "eq",
  target: "audio",
  summary: "tone shaping: highpass / lowpass / one peaking band (highpass, lowpass, equalizer)",
  requires: ["highpass", "lowpass", "equalizer"],
  params: {
    highpass: { type: "number", describe: "cut below this Hz (0 = off)", min: 0, max: 2000 },
    lowpass: { type: "number", describe: "cut above this Hz (0 = off)", min: 1000, max: 20000 },
    frequency: { type: "number", describe: "centre of the peaking band in Hz (needs gain)", min: 20, max: 20000 },
    gain: { type: "number", describe: "gain of the peaking band in dB (needs frequency)", min: -30, max: 30 },
    width: { type: "number", describe: "Q of the peaking band (higher = narrower)", default: 1, min: 0.1, max: 10 },
  },
  build(params) {
    const out: string[] = [];
    const highpass = params.highpass as number | undefined;
    const lowpass = params.lowpass as number | undefined;
    const frequency = params.frequency as number | undefined;
    const gain = params.gain as number | undefined;
    if (typeof highpass === "number" && highpass > 0) out.push(`highpass=f=${numValue(highpass)}`);
    if (typeof lowpass === "number" && lowpass > 0) out.push(`lowpass=f=${numValue(lowpass)}`);
    if (typeof frequency === "number" || typeof gain === "number") {
      if (typeof frequency !== "number")
        throw new MontashError("E_USAGE", "effect 'eq': frequency is required when gain is set", {
          detail: { effect: "eq", param: "frequency" },
        });
      if (typeof gain !== "number")
        throw new MontashError("E_USAGE", "effect 'eq': gain is required when frequency is set", {
          detail: { effect: "eq", param: "gain" },
        });
      out.push(`equalizer=f=${numValue(frequency)}:t=q:w=${numValue(params.width as number)}:g=${numValue(gain)}`);
    }
    return out;
  },
});

/**
 * ダイナミクス圧縮（声の大小のばらつきを抑える）。`acompressor`。
 *
 * **`threshold` と `makeup` は dB で受け、線形振幅（`10^(dB/20)`）に直して渡す。**
 * ffmpeg の `acompressor` はこの 2 つを線形で取る（docs/07 §8.3 の `sidechaincompress` と同じ事情）が、
 * montash の音量はどこでも dB（`volume`、`gain_db`、ダッキングの `threshold_db`）なので単位を揃える。
 * パラメータの範囲は **そのまま ffmpeg の受け付ける範囲に収まる**ように決めてある
 * （-60dB → 0.001 ≧ 0.000976563、0dB → 1、makeup 36dB → 63.1 ≦ 64）ので、丸めは要らない。
 *
 * 既定（threshold -18dB / ratio 3 / attack 20ms / release 250ms / makeup 0dB）は「喋りを少し均す」程度。
 * `detection` は既定の rms（声には peak より素直）、`knee` も既定のまま — 増やすほど良くなる類の
 * つまみではないので出さない。
 */
export const compressEffect: EffectSpec = defineEffect({
  name: "compress",
  target: "audio",
  summary: "even out loud and quiet parts (acompressor)",
  requires: ["acompressor"],
  params: {
    threshold: { type: "number", describe: "compress above this level in dB", default: -18, min: -60, max: 0 },
    ratio: { type: "number", describe: "compression ratio, 1 .. 20 (1 = off)", default: 3, min: 1, max: 20 },
    attack: { type: "number", describe: "attack in ms", default: 20, min: 0.01, max: 2000 },
    release: { type: "number", describe: "release in ms", default: 250, min: 0.01, max: 9000 },
    makeup: { type: "number", describe: "make-up gain in dB, 0 .. 36", default: 0, min: 0, max: 36 },
  },
  build(params) {
    const threshold = dbToAmplitude(params.threshold as number);
    const makeup = dbToAmplitude(params.makeup as number);
    return [
      `acompressor=threshold=${numValue(threshold)}:ratio=${numValue(params.ratio as number)}` +
        `:attack=${numValue(params.attack as number)}:release=${numValue(params.release as number)}` +
        `:makeup=${numValue(makeup)}`,
    ];
  },
});

const BUILTIN_VIDEO_EFFECTS: Readonly<Record<string, EffectSpec>> = {
  [colorEffect.name]: colorEffect,
  [blurEffect.name]: blurEffect,
  [mosaicEffect.name]: mosaicEffect,
  [lut3dEffect.name]: lut3dEffect,
  [flipEffect.name]: flipEffect,
  [rotateEffect.name]: rotateEffect,
};
const BUILTIN_AUDIO_EFFECTS: Readonly<Record<string, EffectSpec>> = {
  [denoiseEffect.name]: denoiseEffect,
  [audioEqEffect.name]: audioEqEffect,
  [compressEffect.name]: compressEffect,
};

export const videoEffects: Registry<EffectSpec> = createRegistry<EffectSpec>({
  label: "video effect",
  sorted: true,
  builtin: BUILTIN_VIDEO_EFFECTS,
  notFound: notFound("video"),
});

export const audioEffects: Registry<EffectSpec> = createRegistry<EffectSpec>({
  label: "audio effect",
  sorted: true,
  builtin: BUILTIN_AUDIO_EFFECTS,
  notFound: notFound("audio"),
});

// 組み込みが必要とする ffmpeg フィルタを `doctor` の検査対象に載せる
for (const spec of [...Object.values(BUILTIN_VIDEO_EFFECTS), ...Object.values(BUILTIN_AUDIO_EFFECTS)])
  if (spec.requires?.length)
    registerRequirements(`effect:${spec.target}:${spec.name}`, { filters: spec.requires }, "builtin");

export function effectRegistry(target: EffectTarget): Registry<EffectSpec> {
  return target === "video" ? videoEffects : audioEffects;
}

/** 組み込み・プラグインを登録する。`requires` は `doctor` の検査対象に合成される */
export function registerEffect(spec: EffectSpec, source: "builtin" | "plugin" = "builtin"): void {
  effectRegistry(spec.target).register(spec.name, spec, source);
  if (spec.requires && spec.requires.length > 0)
    registerRequirements(`effect:${spec.target}:${spec.name}`, { filters: spec.requires }, source);
}

// ---------------------------------------------------------------------------
// パラメータの解決
// ---------------------------------------------------------------------------

/**
 * 既定値を当て、型と範囲を検査した `params` を返す（純関数）。
 * 未知のキーは**落とさずそのまま通す**（プラグインが後から意味を足せるように）。
 */
export function resolveEffectParams(
  spec: EffectSpec,
  raw: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [key, p] of Object.entries(spec.params ?? {})) {
    const value = raw[key];
    if (value === undefined) {
      if (p.required) throw paramError(spec, key, "is required");
      if (p.default !== undefined) out[key] = p.default;
      continue;
    }
    if (p.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw paramError(spec, key, "must be a number");
      if (p.min !== undefined && value < p.min) throw paramError(spec, key, `must be >= ${p.min}`);
      if (p.max !== undefined && value > p.max) throw paramError(spec, key, `must be <= ${p.max}`);
    } else if (p.type === "boolean") {
      if (typeof value !== "boolean") throw paramError(spec, key, "must be a boolean");
    } else {
      if (typeof value !== "string") throw paramError(spec, key, "must be a string");
      if (p.choices && !p.choices.includes(value))
        throw paramError(spec, key, `must be one of: ${p.choices.join(", ")}`);
    }
  }
  return out;
}

function paramError(spec: EffectSpec, key: string, what: string): MontashError {
  return new MontashError("E_USAGE", `effect '${spec.name}': ${key} ${what}`, {
    detail: { effect: spec.name, param: key },
  });
}

// ---------------------------------------------------------------------------
// 展開
// ---------------------------------------------------------------------------

/** project.json の `effects[]` の 1 要素（`core/schema.ts` の EffectSchema と同じ形） */
export interface EffectRef {
  type: string;
  params?: Record<string, unknown>;
  keyframes?: unknown[];
}

/**
 * クリップの `effects[]` を **配列順に** フィルタ片へ展開する（純関数）。
 * 未登録の種別は `E_PLUGIN_MISSING`、キーフレームは Phase 2 以降なので `E_NOT_IMPLEMENTED`。
 */
export function buildEffectFilters(
  target: EffectTarget,
  effects: readonly EffectRef[] | undefined,
  ctx: EffectBuildContext,
  /** クリップ単位の解析結果（`analysisKey()` の値 → `analyze()` の戻り値） */
  analyses?: Readonly<Record<string, unknown>>,
): string[] {
  if (!effects || effects.length === 0) return [];
  const registry = effectRegistry(target);
  const out: string[] = [];
  for (const ref of effects) {
    if (ref.keyframes && ref.keyframes.length > 0)
      throw new MontashError("E_NOT_IMPLEMENTED", `effect '${ref.type}': keyframes are not implemented yet`, {
        hint: "See docs/09-roadmap.md (F-FX-8).",
      });
    const spec = registry.require(ref.type);
    const analysis = analyses?.[analysisKey(target, ref.type)];
    out.push(
      ...spec.build(resolveEffectParams(spec, ref.params ?? {}), analysis === undefined ? ctx : { ...ctx, analysis }),
    );
  }
  return out;
}

/** 解析結果を引くためのキー（クリップ内で同じ効果を 2 度掛けたら同じ解析を共有する） */
export function analysisKey(target: EffectTarget, effectName: string): string {
  return `${target}:${effectName}`;
}

/**
 * `effects[]` が申告した外部ファイルのパスを重複なく集める（純関数。docs/13 D-19）。
 *
 * - 申告していない（`externalFiles` を持たない）エフェクトは何も出さない → 指紋は従来どおり
 * - 未登録の種別・壊れた `params` では**投げずに黙って飛ばす**。ここは指紋の材料を集めるだけで、
 *   値の検査は `buildEffectFilters()`（レンダー経路）の仕事だから
 */
export function collectExternalFiles(
  target: EffectTarget,
  effects: readonly EffectRef[] | undefined,
): readonly string[] {
  if (!effects || effects.length === 0) return [];
  const registry = effectRegistry(target);
  const out: string[] = [];
  for (const ref of effects) {
    const spec = registry.get(ref.type);
    if (!spec?.externalFiles) continue;
    const raw = ref.params ?? {};
    let params: Readonly<Record<string, unknown>> = raw;
    try {
      params = resolveEffectParams(spec, raw);
    } catch {
      /* 既定値・範囲の検査で落ちる値でも、宣言されたパスは指紋に載せたい */
    }
    let files: readonly string[];
    try {
      files = spec.externalFiles(params);
    } catch {
      continue;
    }
    for (const file of files) if (typeof file === "string" && file !== "" && !out.includes(file)) out.push(file);
  }
  return out;
}

/** そのクリップに、解析が要るエフェクトが含まれているか */
export function effectsNeedingAnalysis(target: EffectTarget, effects: readonly EffectRef[] | undefined): EffectSpec[] {
  if (!effects || effects.length === 0) return [];
  const registry = effectRegistry(target);
  const seen = new Set<string>();
  const out: EffectSpec[] = [];
  for (const ref of effects) {
    const spec = registry.get(ref.type);
    if (!spec?.analyze || seen.has(spec.name)) continue;
    seen.add(spec.name);
    out.push(spec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI オプションの導出
//
// AviUtl の「トラックバーを登録すると UI が出る」に相当する部分。パラメータ定義 1 つから
// CLI オプション・`schema`・`help`・（Phase 3 で）Web のフォームを導出する。
// ---------------------------------------------------------------------------

/** パラメータ名 → どのエフェクトが宣言しているか */
export interface ParamOrigin {
  name: string;
  spec: EffectParamSpec;
  /** このパラメータを持つエフェクト名（複数あり得る） */
  effects: string[];
  /** 型が食い違うエフェクトが混在している（その場合は string で受けて実行時に解釈する） */
  conflicting: boolean;
}

/**
 * 登録済みエフェクトのパラメータを名前で束ねる。
 *
 * `effect add <clip> <name> --sigma 12` のように「効果ごとに違う引数」を yargs（静的定義）で
 * 受けるため、**全エフェクトのパラメータの和集合**をオプションとして宣言する。
 * 同名で型が食い違う場合は string に寄せ、値の解釈は `resolveEffectParams()` に任せる。
 */
export function collectParamOrigins(target: EffectTarget): ParamOrigin[] {
  const byName = new Map<string, ParamOrigin>();
  for (const entry of effectRegistry(target).entries()) {
    for (const [name, spec] of Object.entries(entry.value.params ?? {})) {
      const found = byName.get(name);
      if (!found) {
        byName.set(name, { name, spec, effects: [entry.name], conflicting: false });
        continue;
      }
      found.effects.push(entry.name);
      if (found.spec.type !== spec.type) found.conflicting = true;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 文字列で来た値を、パラメータ定義の型に合わせて解釈する（CLI からの入力用） */
export function coerceParamValue(spec: EffectParamSpec, raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (spec.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (spec.type === "boolean") {
    if (raw === "true" || raw === "") return true;
    if (raw === "false") return false;
  }
  return raw;
}

/** そのエフェクトが受け取るパラメータだけを、CLI の argv から抜き出して型変換する */
export function paramsFromArgs(spec: EffectSpec, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(spec.params ?? {})) {
    const value = args[name];
    if (value === undefined) continue;
    out[name] = coerceParamValue(p, value);
  }
  return out;
}
