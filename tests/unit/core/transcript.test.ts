/**
 * 書き起こしトークンの保存と語の置換（`src/core/transcript.ts`）。純関数なので固定しておく。
 * 肝は「置換したトークンの時刻をどう決めるか」と「置換の後に整形をやり直しても折り返しが破綻しないか」。
 */
import { expect, test } from "bun:test";
import { breakScore, formatTranscript, type TranscriptToken } from "../../../src/core/subtitle-format.ts";
import {
  applyReplacements,
  parseReplaceFile,
  parseReplaceRule,
  parseTranscript,
  serializeTranscript,
  TRANSCRIPT_VERSION,
  transcriptText,
} from "../../../src/core/transcript.ts";

const tok = (text: string, startMs: number, endMs: number): TranscriptToken => ({ text, startMs, endMs });

// ---------------------------------------------------------------------------
// 規則の読み取り
// ---------------------------------------------------------------------------

test("置換規則は最初の = で割る（置換後に = が入ってもよい）", () => {
  expect(parseReplaceRule("フロント演動=フロントエンド運用")).toEqual({
    from: "フロント演動",
    to: "フロントエンド運用",
  });
  expect(parseReplaceRule("a=b=c")).toEqual({ from: "a", to: "b=c" });
  expect(parseReplaceRule("  山傘 = 山笠 ")).toEqual({ from: "山傘", to: "山笠" });
});

test("置換先は空でよい（語を落とす）が、置換元が空の規則は受け取らない", () => {
  expect(parseReplaceRule("えーと=")).toEqual({ from: "えーと", to: "" });
  expect(parseReplaceRule("=なにか")).toBeNull();
  expect(parseReplaceRule("イコールが無い")).toBeNull();
});

test("規則ファイルはコメントと空行を飛ばし、壊れた行を行番号つきで返す", () => {
  const { rules, invalid } = parseReplaceFile(
    [
      "# 朝ミの用語",
      "フロント演動=フロントエンド運用",
      "",
      "山傘=山笠",
      "これは規則ではない",
      "  # 末尾のコメント",
    ].join("\n"),
  );
  expect(rules).toEqual([
    { from: "フロント演動", to: "フロントエンド運用" },
    { from: "山傘", to: "山笠" },
  ]);
  expect(invalid).toEqual([{ line: 5, text: "これは規則ではない" }]);
});

// ---------------------------------------------------------------------------
// 置換と時刻
// ---------------------------------------------------------------------------

test("トークンをまたぐ語を置換し、置き換えた区間の時刻をそのまま引き継ぐ", () => {
  // whisper は「フロント」「演動」のように語を割って返す。またげないと役に立たない
  const tokens = [tok("今日", 0, 300), tok("は", 300, 420), tok("フロント", 420, 900), tok("演動", 900, 1200)];
  const { tokens: out, applied } = applyReplacements(tokens, [{ from: "フロント演動", to: "フロントエンド運用" }]);
  expect(transcriptText(out)).toBe("今日はフロントエンド運用");
  // 置換したトークンは、消えた 2 トークンが占めていた 420〜1200ms をそのまま占める
  expect(out.at(-1)).toEqual({ text: "フロントエンド運用", startMs: 420, endMs: 1200 });
  // 触れなかったトークンは 1 つも動かない
  expect(out.slice(0, 2)).toEqual([tok("今日", 0, 300), tok("は", 300, 420)]);
  expect(applied).toEqual([{ from: "フロント演動", to: "フロントエンド運用", count: 1 }]);
});

test("トークンの一部だけが一致したら、残りは文字数で按分した時刻になる", () => {
  // 「山傘」がトークン「山傘祭り」の頭 2 文字にあたる（1 文字 100ms）
  const tokens = [tok("山傘祭り", 1000, 1400)];
  const { tokens: out } = applyReplacements(tokens, [{ from: "山傘", to: "山笠" }]);
  expect(out).toEqual([
    { text: "山笠", startMs: 1000, endMs: 1200 },
    { text: "祭り", startMs: 1200, endMs: 1400 },
  ]);
});

test("同じ語が何度出ても置換し、回数を返す", () => {
  const tokens = [tok("山傘と", 0, 300), tok("山傘", 300, 600)];
  const { tokens: out, applied } = applyReplacements(tokens, [{ from: "山傘", to: "山笠" }]);
  expect(transcriptText(out)).toBe("山笠と山笠");
  expect(applied[0]?.count).toBe(2);
});

test("置換先が空なら語ごと落とす（時刻には空きができる）", () => {
  const tokens = [tok("えーと", 0, 400), tok("そうですね", 400, 900)];
  const { tokens: out } = applyReplacements(tokens, [{ from: "えーと", to: "" }]);
  expect(out).toEqual([tok("そうですね", 400, 900)]);
});

test("規則は渡された順に当たる（前の結果に次が当たる）", () => {
  const tokens = [tok("あ", 0, 100), tok("い", 100, 200)];
  const { tokens: out } = applyReplacements(tokens, [
    { from: "あい", to: "うえ" },
    { from: "うえ", to: "おか" },
  ]);
  expect(transcriptText(out)).toBe("おか");
});

test("置換先が置換元を含んでも回り続けない", () => {
  const tokens = [tok("Fusic", 0, 500)];
  const { tokens: out, applied } = applyReplacements(tokens, [{ from: "Fusic", to: "Fusic株式会社" }]);
  expect(transcriptText(out)).toBe("Fusic株式会社");
  expect(applied[0]?.count).toBe(1);
});

test("当たらなかった規則は count 0 で返る（呼び出し側が警告できる）", () => {
  const { tokens: out, applied } = applyReplacements([tok("こんにちは", 0, 500)], [{ from: "山傘", to: "山笠" }]);
  expect(transcriptText(out)).toBe("こんにちは");
  expect(applied).toEqual([{ from: "山傘", to: "山笠", count: 0 }]);
});

test("特殊トークン（[_BEG_]）は先に落とすので、語の間に挟まっても一致する", () => {
  const tokens = [tok("フロント", 0, 300), tok("[_BEG_]", 300, 300), tok("演動", 300, 600)];
  const { tokens: out } = applyReplacements(tokens, [{ from: "フロント演動", to: "フロントエンド運用" }]);
  expect(out).toEqual([{ text: "フロントエンド運用", startMs: 0, endMs: 600 }]);
});

test("規則が空なら中身は変わらない（特殊トークンの掃除だけ）", () => {
  const tokens = [tok("[_BEG_]", 0, 0), tok("こんにちは", 0, 500)];
  expect(applyReplacements(tokens, []).tokens).toEqual([tok("こんにちは", 0, 500)]);
});

test("サロゲート対（絵文字）を割らない", () => {
  const tokens = [tok("👍です", 0, 300)];
  const { tokens: out } = applyReplacements(tokens, [{ from: "👍", to: "いいね" }]);
  expect(transcriptText(out)).toBe("いいねです");
});

// ---------------------------------------------------------------------------
// 置換 → 整形のやり直し（この機能の目的そのもの）
// ---------------------------------------------------------------------------

/** 字幕の行の切れ目が、すべて語境界（`breakScore()` が負でない）か */
function breaksAreClean(lines: readonly string[]): boolean {
  const body = lines.join("");
  let pos = 0;
  for (const line of lines.slice(0, -1)) {
    pos += line.length;
    if (breakScore(body, pos) < 0) return false;
  }
  return true;
}

test("語が伸びても整形をやり直せば 2 行 x 20 字と語境界が保たれる", () => {
  // 実地で崩れた形: 直すと 2 文字増えて 1 行に収まらなくなる
  const tokens = [
    tok("テーマ", 0, 500),
    tok("は", 500, 700),
    tok("大規模", 700, 1200),
    tok("プロジェクト", 1200, 1900),
    tok("を", 1900, 2000),
    tok("支える", 2000, 2500),
    tok("フロント", 2500, 3000),
    tok("演動", 3000, 3300),
    tok("の", 3300, 3400),
    tok("リアル", 3400, 3900),
    tok("という", 3900, 4300),
    tok("こと", 4300, 4600),
    tok("です", 4600, 4900),
    tok("。", 4900, 5000),
  ];
  const before = formatTranscript(tokens);
  const { tokens: fixed } = applyReplacements(tokens, [{ from: "フロント演動", to: "フロントエンド運用" }]);
  const after = formatTranscript(fixed);

  expect(after.map((c) => c.text).join("")).toContain("フロントエンド運用");
  for (const cue of after) {
    expect(cue.lines.length).toBeLessThanOrEqual(2);
    for (const line of cue.lines) expect([...line].length).toBeLessThanOrEqual(21);
    expect(breaksAreClean(cue.lines)).toBe(true);
  }
  // 話している時刻は動かない（変わるのは折り返しだけ）
  expect(after[0]?.startMs).toBe(before[0]?.startMs);
  expect(after.at(-1)?.endMs).toBe(before.at(-1)?.endMs);
});

// ---------------------------------------------------------------------------
// 保存形式
// ---------------------------------------------------------------------------

test("保存した書き起こしは読み直せて、本文も入っている", () => {
  const tokens = [tok("今日", 0, 300), tok("は", 300, 420)];
  const json = serializeTranscript(tokens, {
    engine: { path: "/opt/homebrew/bin/whisper-cli", source: "path" },
    model: "/models/ggml-small.bin",
    language: "ja",
    vocabulary: ["Fusic"],
    source: "/tmp/a.mp4",
    asset: "rec",
    replacements: [{ from: "山傘", to: "山笠", count: 2 }],
    generatedAt: "2026-09-16T00:00:00.000Z",
  });
  const parsed = parseTranscript(JSON.parse(json));
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.file.version).toBe(TRANSCRIPT_VERSION);
  expect(parsed.file.tokens).toEqual(tokens);
  expect(parsed.file.text).toBe("今日は");
  expect(parsed.file.asset).toBe("rec");
  expect(parsed.file.language).toBe("ja");
  expect(parsed.file.replacements).toEqual([{ from: "山傘", to: "山笠", count: 2 }]);
});

test("montash の書き起こしでないものは理由つきで断る", () => {
  expect(parseTranscript({ transcription: [] })).toHaveProperty("error");
  expect(parseTranscript(null)).toHaveProperty("error");
  const newer = parseTranscript({ format: "montash.transcript", version: 99, tokens: [] });
  expect("error" in newer && newer.error).toContain("newer");
});
