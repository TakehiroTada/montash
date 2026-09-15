#!/usr/bin/env bun
/**
 * CLI リファレンス生成スクリプト。
 *
 *   bun run gen:cli
 *
 * リポジトリ直下の CLI (`bun ../src/cli/index.ts schema --json`) を実行し、その出力から
 * `src/content/docs/ja/reference/cli.md` と `src/content/docs/en/reference/cli.md` を生成する。
 * 手書きでコマンド一覧を書かないこと。CLI を変更したらこのスクリプトを再実行して差分をコミットする。
 *
 * 生成物は決定的（同じ schema からは必ず同じ Markdown）になるようにしてある。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const websiteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(websiteDir, "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

// ---------------------------------------------------------------- schema 型
type Positional = {
  name: string;
  describe?: string;
  required?: boolean;
  variadic?: boolean;
  type?: string;
};

type Option = {
  type?: string;
  describe?: string;
  choices?: (string | number)[];
  default?: unknown;
  required?: boolean;
  alias?: string;
  time?: boolean;
};

type CommandSchema = {
  path: string;
  summary: string;
  description?: string;
  workflows?: string[];
  mutates?: boolean;
  positionals?: Positional[];
  options?: Record<string, Option>;
  examples?: { cmd: string; note?: string }[];
};

// ---------------------------------------------------------------- schema 取得
function loadSchema(): CommandSchema[] {
  const proc = spawnSync("bun", [cliEntry, "schema", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(`montash schema --json failed (exit ${proc.status}):\n${proc.stderr}`);
  }
  const parsed = JSON.parse(proc.stdout) as { ok: boolean; result: CommandSchema[] };
  if (!parsed.ok || !Array.isArray(parsed.result)) {
    throw new Error("unexpected schema output");
  }
  return parsed.result;
}

// ---------------------------------------------------------------- 整形ヘルパ
/** Markdown の表セル内で意味を持つ文字をエスケープする */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** `montash clip trim <id> [--in <t>] ...` のような使用例を組み立てる */
function usage(cmd: CommandSchema): string {
  const parts = ["montash", ...cmd.path.split(" ")];
  for (const p of cmd.positionals ?? []) {
    const name = p.variadic ? `${p.name}...` : p.name;
    parts.push(p.required ? `<${name}>` : `[${name}]`);
  }
  const required = Object.entries(cmd.options ?? {}).filter(([, o]) => o.required);
  for (const [name, o] of required) {
    parts.push(o.type === "boolean" ? `--${name}` : `--${name} <${o.type ?? "value"}>`);
  }
  if (Object.keys(cmd.options ?? {}).length > required.length) parts.push("[options]");
  return parts.join(" ");
}

function optionType(o: Option): string {
  if (o.choices && o.choices.length > 0) return o.choices.map((c) => `\`${c}\``).join(" \\| ");
  if (o.time) return "time";
  return o.type ?? "string";
}

function formatDefault(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return `\`${value}\``;
  return `\`${JSON.stringify(value)}\``;
}

// ---------------------------------------------------------------- 文言（日英）
type Lang = "ja" | "en";

const t = {
  ja: {
    title: "CLI リファレンス",
    description: "montash の全コマンドと引数の一覧（montash schema --json から自動生成）",
    intro: [
      "このページは `montash schema --json` の出力から自動生成しています。",
      "手で編集せず、`cd website && bun run gen:cli` で再生成してください。",
      "",
      "各コマンドは `montash <command> --help` でも同じ内容を確認できます。",
      "AI から使う場合は `montash schema --format anthropic-tools` でツール定義をそのまま取り出せます。",
      "",
      ":::note",
      "**状態を変更するコマンド**（表の「変更」が ✅）は履歴に op として記録されます。",
      "記録された op は `montash log` で確認でき、`montash undo` / `montash checkout` で戻せます。",
      ":::",
    ].join("\n"),
    globalHeading: "共通オプション",
    globalIntro: "以下のオプションはすべてのコマンドで使えます。",
    listHeading: "コマンド一覧",
    colCommand: "コマンド",
    colMutates: "変更",
    colSummary: "説明",
    subOptions: "オプション",
    subPositionals: "引数",
    subExamples: "例",
    colName: "名前",
    colType: "型",
    colDefault: "既定値",
    colRequired: "必須",
    colDesc: "説明",
    required: "必須",
    variadic: "複数可",
    timeNote:
      "`time` 型は秒（`1.5`）・タイムコード（`00:00:12.500`）・フレーム（`f:45`）で指定できます。相対指定は `+0.5` / `-1` の形です。負の値は `--in=-10` のように `=` で渡してください。",
  },
  en: {
    title: "CLI reference",
    description: "Every montash command and flag, generated from montash schema --json",
    intro: [
      "This page is generated from the output of `montash schema --json`.",
      "Do not edit it by hand — run `cd website && bun run gen:cli` to regenerate it.",
      "",
      "The same information is available from `montash <command> --help`.",
      "When driving montash from an AI, `montash schema --format anthropic-tools` emits ready-made tool definitions.",
      "",
      ":::note",
      "Commands marked ✅ in the **Mutates** column change project state and are recorded in the history as an op.",
      "Recorded ops show up in `montash log` and can be reverted with `montash undo` / `montash checkout`.",
      ":::",
    ].join("\n"),
    globalHeading: "Global options",
    globalIntro: "These options are accepted by every command.",
    listHeading: "Command index",
    colCommand: "Command",
    colMutates: "Mutates",
    colSummary: "Summary",
    subOptions: "Options",
    subPositionals: "Arguments",
    subExamples: "Examples",
    colName: "Name",
    colType: "Type",
    colDefault: "Default",
    colRequired: "Required",
    colDesc: "Description",
    required: "required",
    variadic: "repeatable",
    timeNote:
      "`time` values accept seconds (`1.5`), timecode (`00:00:12.500`) or frames (`f:45`). Relative values are written `+0.5` / `-1`. Pass negative values with `=`, e.g. `--in=-10`.",
  },
} satisfies Record<Lang, Record<string, string>>;

/** 共通オプションは CLI の `--help` と同じ内容を手で持つ（schema には含まれないため） */
const globalOptions: [string, string, string][] = [
  ["-C, --project <dir>", "string", "プロジェクトディレクトリ（既定: 上位ディレクトリを探索）"],
  ["--json", "boolean", "機械可読な JSON 出力（`MONTASH_JSON=1` でも可）"],
  ["-q, --quiet", "boolean", "人間向けの出力を抑制する"],
  ["-v, --verbose", "boolean", "実行した ffmpeg コマンドと詳細を表示する"],
  ["--dry-run", "boolean", "書き込まずに何が変わるかだけ表示する"],
  ["-y, --yes", "boolean", "確認プロンプトにすべて yes と答える"],
  ["--ffmpeg-path <path>", "string", "ffmpeg のパス（`MONTASH_FFMPEG` でも可）"],
  ["--ffprobe-path <path>", "string", "ffprobe のパス（`MONTASH_FFPROBE` でも可）"],
  ["-m, --message <msg>", "string", "この操作をその場でコミットする"],
  ["--body <text>", "string", "コミット本文（`-m` と併用）"],
  ["--no-color", "boolean", "色付き出力を無効にする"],
  ["--time-format <fmt>", "`frames` \\| `seconds` \\| `tc`", "人間向けの時間表記（既定 `seconds`）"],
];

const globalOptionsEn: [string, string, string][] = [
  ["-C, --project <dir>", "string", "Project directory (default: search upward for project.json)"],
  ["--json", "boolean", "Machine-readable JSON output (also `MONTASH_JSON=1`)"],
  ["-q, --quiet", "boolean", "Suppress human-readable output"],
  ["-v, --verbose", "boolean", "Print the ffmpeg commands that were executed"],
  ["--dry-run", "boolean", "Show what would change without writing"],
  ["-y, --yes", "boolean", "Answer yes to every confirmation"],
  ["--ffmpeg-path <path>", "string", "Path to the ffmpeg binary (also `MONTASH_FFMPEG`)"],
  ["--ffprobe-path <path>", "string", "Path to the ffprobe binary (also `MONTASH_FFPROBE`)"],
  ["-m, --message <msg>", "string", "Commit this operation immediately with the given message"],
  ["--body <text>", "string", "Commit body (used with `-m`)"],
  ["--no-color", "boolean", "Disable colorized output"],
  ["--time-format <fmt>", "`frames` \\| `seconds` \\| `tc`", "Human-readable time format (default `seconds`)"],
];

/**
 * コマンド要約（schema の `summary`）の日本語訳。
 * キーは英語原文そのもの。未登録のものは英語のまま出力するので、CLI 側の文言が変わっても
 * 生成は壊れず、訳が古いまま残ることもない（英語にフォールバックする）。
 */
const summaryJa: Record<string, string> = {
  "check ffmpeg / Bun / platform and report missing features with hints":
    "ffmpeg / Bun / プラットフォームを点検し、足りない機能とその直し方を表示する",
  "print machine-readable command definitions (for AI tool use)":
    "機械可読なコマンド定義を出力する（AI のツール定義用）",
  "create a new project directory with project.json and .montash/":
    "project.json と .montash/ を持つ新しいプロジェクトディレクトリを作る",
  "show project settings, asset/track counts and timeline duration":
    "プロジェクト設定・素材／トラック数・タイムライン尺を表示する",
  "change a project setting (name, default_font, text_engine, background)":
    "プロジェクト設定を変更する（name, default_font, text_engine, background）",
  "check project.json invariants (references, ranges, overlaps, handles, gaps)":
    "project.json の不変条件を検査する（参照・範囲・重なり・のりしろ・ギャップ）",
  "import media, subtitle or text files and optionally build proxies":
    "映像・音声・字幕・テキストファイルを取り込む（同時にプロキシ生成も可能）",
  "list imported assets with metadata, usage and proxy state":
    "取り込み済み素材をメタデータ・使用箇所・プロキシ状態つきで一覧する",
  "show asset metadata, usage and optionally raw ffprobe data":
    "素材のメタデータと使用箇所を表示する（ffprobe の生データも可）",
  "set display metadata (label, tags, color, note); the ID cannot be changed":
    "表示用メタデータ（ラベル・タグ・色・メモ）を設定する。ID は変更できない",
  "create assets/text/<id>.txt and register it as a reusable text asset":
    "assets/text/<id>.txt を作り、再利用できるテキスト素材として登録する",
  "rewrite the body of a project-owned text asset": "プロジェクト所有のテキスト素材の本文を書き換える",
  "remove an asset (with --force, also the clips that reference it)":
    "素材を削除する（--force を付けると参照しているクリップも削除）",
  "point missing assets at their new location by path or directory search":
    "行方不明の素材を、パス指定またはディレクトリ探索で新しい場所に再リンクする",
  "build H.264/AAC proxies and optional thumbnails and waveforms":
    "H.264/AAC のプロキシを生成する（サムネイル・波形も任意で生成）",
  "report ready, missing or stale proxies, thumbnails and waveforms":
    "プロキシ・サムネイル・波形が最新か、未生成か、古いかを報告する",
  "list system font families, styles and files (CJK flagged)":
    "システムのフォントファミリ・スタイル・ファイルを一覧する（CJK には印が付く）",
  "add a video, audio or text track": "映像・音声・テキストのトラックを追加する",
  "list tracks in compositing order": "トラックを合成順に一覧する",
  "remove a track (--force if it still holds clips)":
    "トラックを削除する（クリップが残っている場合は --force）",
  "mute a track (video: hidden, audio: silent)":
    "トラックをミュートする（映像は非表示、音声は無音）",
  "lock a track against edits and ripples": "トラックをロックして編集とリップルの対象外にする",
  "reorder a track in the compositing order": "トラックの合成順を入れ替える",
  "place a trimmed asset, linking video and audio clips":
    "素材の一部を切り出してタイムラインに置く（映像と音声はリンクされる）",
  "list clips in track and timeline order": "クリップをトラック順・時間順に一覧する",
  "move a clip (and its linked audio) in time or to another track":
    "クリップ（とリンクされた音声）を時間方向または別トラックへ移動する",
  "trim a clip's source in/out points, optionally rippling the rest of the timeline":
    "クリップのソース in/out を詰める（--ripple で後続も一緒に詰める）",
  "split a clip in two at a timeline position (the first half keeps the original ID)":
    "タイムライン上の位置でクリップを 2 つに分割する（前半が元の ID を保持）",
  "delete clips, optionally closing the intervals they leave behind":
    "クリップを削除する（--ripple で空いた区間を詰める）",
  "set simple clip properties (speed, label, volume, opacity)":
    "クリップの単純なプロパティを設定する（速度・ラベル・音量・不透明度）",
  "show tracks, clips and timeline duration": "トラック・クリップ・タイムライン尺を表示する",
  "list intervals with no video, and optionally fill or close them":
    "映像が無い区間（ギャップ）を一覧し、任意で埋める／詰める",
  "add an xfade transition between two adjacent clips":
    "隣り合う 2 クリップの間に xfade トランジションを入れる",
  "change a transition's type, length, mode or audio handling":
    "トランジションの種類・長さ・方式・音声の扱いを変更する",
  "remove a transition (overlap mode restores the original spacing)":
    "トランジションを削除する（overlap 方式なら元の間隔に戻す）",
  "list the transitions on the timeline": "タイムライン上のトランジションを一覧する",
  "fade a track or a clip in at the head and out at the tail":
    "トラックまたはクリップの頭をフェードイン、尻をフェードアウトする",
  "add a text clip (telop) on a text track, creating T1 if needed":
    "テキストトラックにテロップを追加する（無ければ T1 を作る）",
  "change the body, timing or style of a text clip":
    "テロップの本文・タイミング・スタイルを変更する",
  "remove a text clip": "テロップを削除する",
  "list text clips in timeline order": "テロップを時間順に一覧する",
  "list the built-in and project text style presets":
    "組み込みおよびプロジェクト固有のテキストスタイルプリセットを一覧する",
  "place an image or video on an upper video track as an overlay":
    "画像または映像を上位の映像トラックにオーバーレイとして置く",
  "change the position, size, opacity or fades of an overlay":
    "オーバーレイの位置・サイズ・不透明度・フェードを変更する",
  "remove an overlay clip": "オーバーレイクリップを削除する",
  "list overlays (video clips that carry a transform)":
    "オーバーレイ（変形情報を持つ映像クリップ）を一覧する",
  "attach a subtitle file to the timeline (burned in or muxed as a soft track)":
    "字幕ファイルをタイムラインに付ける（焼き込み、または選択可能なトラックとして多重化）",
  "change the mode, style, language or offset of a subtitle clip":
    "字幕クリップの方式・スタイル・言語・オフセットを変更する",
  "remove a subtitle clip": "字幕クリップを削除する",
  "list subtitle clips": "字幕クリップを一覧する",
  "set the gain of a clip, a track or the master bus in dB":
    "クリップ・トラック・マスターの音量を dB で設定する",
  "set a clip's audio fade in/out": "クリップの音声フェードイン／アウトを設定する",
  "duck a track while another one plays (sidechaincompress)":
    "別のトラックが鳴っている間、対象トラックを下げる（ダッキング / sidechaincompress）",
  "remove a ducking setting by ID": "ダッキング設定を ID 指定で削除する",
  "configure loudness normalization applied at render time (two-pass loudnorm)":
    "書き出し時に適用するラウドネス正規化を設定する（2 パス loudnorm）",
  "shift a clip's audio by whole samples (sub-frame sync correction)":
    "クリップの音声をサンプル単位でずらす（フレーム未満の同期補正）",
  "measure integrated loudness, peaks and silence of a track, a clip or an asset":
    "トラック・クリップ・素材の統合ラウドネス、ピーク、無音区間を測定する",
  "list gains, fades, ducking and normalization settings":
    "音量・フェード・ダッキング・正規化の設定を一覧する",
  "start the local web preview server (Ctrl-C to stop)":
    "ローカルの Web プレビューサーバを起動する（Ctrl-C で停止）",
  "build the timeline preview MP4 (cached video segments + one audio pass)":
    "タイムラインのプレビュー MP4 を生成する（映像はセグメントキャッシュ、音声は 1 パス）",
  "show timeline preview freshness and active build progress":
    "プレビューが最新かどうかと、生成中の進捗を表示する",
  "render plain media clips to MP4 and verify exact frame count":
    "タイムラインを MP4 に書き出し、フレーム数が一致するか検証する",
  "verify frame count, FPS, audio duration and stream configuration":
    "フレーム数・FPS・音声長・ストリーム構成を検証する",
  "list implemented encoding presets": "実装済みのエンコードプリセットを一覧する",
  "show HEAD, pending (uncommitted) ops, the last commit and tags":
    "HEAD、未コミットの op、直前のコミット、タグを表示する",
  "list commits (newest first); --ops expands the ops of each commit":
    "コミットを新しい順に一覧する（--ops で各コミットの op も展開）",
  "show an op, commit or tag in detail (--patch includes the full JSON Patch)":
    "op / コミット / タグの詳細を表示する（--patch で JSON Patch 全体も表示）",
  "diff two points of the history (default: last commit → HEAD, i.e. the pending ops)":
    "履歴の 2 点間の差分を表示する（既定は直前のコミット → HEAD、つまり未コミット分）",
  "group the pending ops into a commit with a human-readable message (-m)":
    "未コミットの op をまとめ、人が読めるメッセージ（-m）を付けてコミットする",
  "move HEAD to an op / commit / tag and expand that state into project.json":
    "HEAD を op / コミット / タグへ移し、その状態を project.json に展開する",
  "move HEAD back n ops (default 1) and expand that state into project.json":
    "HEAD を n 個（既定 1）前の op に戻し、その状態を project.json に展開する",
  "move HEAD forward n ops (default 1) along the most recently used branch":
    "直近に使った系列に沿って HEAD を n 個（既定 1）先に進める",
  "name the current HEAD (or a given op / commit) so it can be checked out later":
    "現在の HEAD（または指定した op / コミット）に名前を付け、あとで checkout できるようにする",
  "list tags": "タグを一覧する",
  "delete a tag (the history it points to is kept)":
    "タグを削除する（指している履歴自体は残る）",
  "verify history integrity (object hashes, op DAG continuity, commits, tags, moves)":
    "履歴の整合性を検証する（オブジェクトのハッシュ、op DAG の連続性、コミット、タグ、移動ログ）",
  "delete old uncommitted ops and unreferenced objects (not implemented yet)":
    "古い未コミット op と参照されていないオブジェクトを削除する（未実装）",
  "export the history as one JSONL file (not implemented yet)":
    "履歴を 1 つの JSONL ファイルに書き出す（未実装）",
  "import a history exported with `history export` (not implemented yet)":
    "`history export` で書き出した履歴を読み込む（未実装）",
  "rebuild .montash/ids.json counters from project.json and every history object":
    "project.json と全履歴オブジェクトから .montash/ids.json の採番カウンタを作り直す",
};

/** 日本語ページ用の要約。訳が無ければ英語のまま返す。 */
function summaryFor(lang: Lang, text: string): string {
  return lang === "ja" ? (summaryJa[text] ?? text) : text;
}

// ---------------------------------------------------------------- 生成
function anchor(path: string): string {
  return path.replace(/\s+/g, "-");
}

function render(lang: Lang, commands: CommandSchema[]): string {
  const w = t[lang];
  const out: string[] = [];

  out.push("---");
  out.push(`title: ${w.title}`);
  out.push(`description: ${w.description}`);
  out.push("---");
  out.push("");
  out.push(
    lang === "ja"
      ? "<!-- このファイルは website/scripts/gen-cli-reference.ts が生成します。手で編集しないでください。 -->"
      : "<!-- Generated by website/scripts/gen-cli-reference.ts - do not edit by hand. -->",
  );
  out.push("");
  out.push(w.intro);
  out.push("");

  // 共通オプション
  out.push(`## ${w.globalHeading}`);
  out.push("");
  out.push(w.globalIntro);
  out.push("");
  out.push(`| ${w.colName} | ${w.colType} | ${w.colDesc} |`);
  out.push("| --- | --- | --- |");
  for (const [name, type, desc] of lang === "ja" ? globalOptions : globalOptionsEn) {
    out.push(`| \`${name}\` | ${type} | ${desc} |`);
  }
  out.push("");
  out.push(w.timeNote);
  out.push("");

  // 一覧
  out.push(`## ${w.listHeading}`);
  out.push("");
  out.push(`| ${w.colCommand} | ${w.colMutates} | ${w.colSummary} |`);
  out.push("| --- | :-: | --- |");
  for (const c of commands) {
    out.push(`| [\`montash ${c.path}\`](#${anchor(c.path)}) | ${c.mutates ? "✅" : ""} | ${cell(summaryFor(lang, c.summary))} |`);
  }
  out.push("");

  // 各コマンド
  for (const c of commands) {
    out.push(`## \`montash ${c.path}\``);
    out.push("");
    out.push(cell(summaryFor(lang, c.summary)));
    out.push("");
    out.push("```bash");
    out.push(usage(c));
    out.push("```");
    out.push("");
    if (c.description) {
      out.push(c.description);
      out.push("");
    }

    const positionals = c.positionals ?? [];
    if (positionals.length > 0) {
      out.push(`### ${w.subPositionals}`);
      out.push("");
      out.push(`| ${w.colName} | ${w.colType} | ${w.colRequired} | ${w.colDesc} |`);
      out.push("| --- | --- | :-: | --- |");
      for (const p of positionals) {
        const name = p.variadic ? `${p.name}...` : p.name;
        out.push(
          `| \`${name}\` | ${p.type ?? "string"} | ${p.required ? "✅" : ""} | ${cell(p.describe ?? "")} |`,
        );
      }
      out.push("");
    }

    const options = Object.entries(c.options ?? {});
    if (options.length > 0) {
      out.push(`### ${w.subOptions}`);
      out.push("");
      out.push(`| ${w.colName} | ${w.colType} | ${w.colDefault} | ${w.colDesc} |`);
      out.push("| --- | --- | --- | --- |");
      for (const [name, o] of options) {
        const label = o.alias ? `-${o.alias}, --${name}` : `--${name}`;
        const desc = [cell(o.describe ?? ""), o.required ? `（${w.required}）` : ""].join("");
        out.push(`| \`${label}\` | ${optionType(o)} | ${formatDefault(o.default)} | ${desc} |`);
      }
      out.push("");
    }

    const examples = c.examples ?? [];
    if (examples.length > 0) {
      out.push(`### ${w.subExamples}`);
      out.push("");
      out.push("```bash");
      for (const e of examples) {
        if (e.note) out.push(`# ${e.note}`);
        out.push(e.cmd);
      }
      out.push("```");
      out.push("");
    }
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------- main
const commands = loadSchema();
for (const lang of ["ja", "en"] as const) {
  const path = join(websiteDir, "src", "content", "docs", lang, "reference", "cli.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, render(lang, commands), "utf8");
  console.log(`generated ${path} (${commands.length} commands)`);
}
