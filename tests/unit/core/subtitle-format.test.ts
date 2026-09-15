/**
 * 書き起こしトークン → 読める字幕（`core/subtitle-format.ts`、docs/03 W-22）。
 *
 * ここが `montash subtitle generate` の本体の価値なので厚く固定する:
 * 文で切れること / 語の途中で切れないこと / 禁則処理 / 行数・文字数・表示時間 / 重なりの解消。
 */
import { describe, expect, test } from "bun:test";
import {
  applyKinsoku,
  breakScore,
  charClass,
  chunkSentence,
  cleanTokens,
  type FormattedCue,
  formatSrtTime,
  formatTranscript,
  retime,
  SUBTITLE_FORMAT_DEFAULTS,
  sentenceRanges,
  type TranscriptToken,
  toSrt,
  wrapLines,
} from "../../../src/core/subtitle-format.ts";

/** whisper 風のトークン列（1 文字 = `msPerChar` ミリ秒） */
function tokens(pieces: readonly string[], msPerChar = 120, startMs = 0): TranscriptToken[] {
  let t = startMs;
  return pieces.map((text) => {
    const start = t;
    t += [...text].length * msPerChar;
    return { text, startMs: start, endMs: t };
  });
}

/** 実地で問題になった読み上げ（固有名詞・カタカナ語・長い文を含む） */
const TALK = tokens([
  "今日",
  "は",
  "事前",
  "ガ",
  "イダンス",
  "の",
  "内容",
  "に",
  "つい",
  "て",
  "お話し",
  "します",
  "。",
  "多面",
  "観察",
  "の",
  "結果",
  "は",
  "総括",
  "次長",
  "が",
  "まとめ",
  "、",
  "来週",
  "の",
  "会議",
  "で",
  "共有",
  "し",
  "ます",
  "。",
  "よろしく",
  "お願い",
  "します",
  "。",
]);

const ALL_LINES = (cues: readonly FormattedCue[]): string[] => cues.flatMap((c) => c.lines);

describe("文でまとめる", () => {
  test("文（。）ごとに 1 字幕になる", () => {
    const cues = formatTranscript(TALK);
    expect(cues).toHaveLength(3);
    expect(cues.map((c) => c.text.replace(/\n/g, ""))).toEqual([
      "今日は事前ガイダンスの内容についてお話しします。",
      "多面観察の結果は総括次長がまとめ、来週の会議で共有します。",
      "よろしくお願いします。",
    ]);
  });

  test("文の途中では字幕を切らない（各字幕は文末で終わる）", () => {
    for (const cue of formatTranscript(TALK)) expect(cue.text.endsWith("。")).toBe(true);
  });

  test("！？や閉じ括弧も文の終わりとして扱う", () => {
    const text = "本当ですか？「はい」と答えた。終わり！";
    expect(sentenceRanges(text).map(([s, e]) => text.slice(s, e))).toEqual([
      "本当ですか？",
      "「はい」と答えた。",
      "終わり！",
    ]);
  });

  test("文末記号が無ければ 1 文として扱い、長ければ文字数で割る", () => {
    const cues = formatTranscript(
      tokens(["それでは", "本日", "の", "アジェン", "ダ", "を", "確認", "し", "ながら", "進め", "て", "いき", "ます"]),
    );
    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues.map((c) => c.text.replace(/\n/g, "")).join("")).toBe(
      "それでは本日のアジェンダを確認しながら進めていきます",
    );
  });
});

describe("長い文は読点 → 文字数の順に分ける", () => {
  const long = tokens([
    "まず",
    "最初",
    "に",
    "全体",
    "の",
    "流れ",
    "を",
    "説明",
    "し",
    "、",
    "次",
    "に",
    "個別",
    "の",
    "論点",
    "を",
    "整理",
    "し",
    "、",
    "最後",
    "に",
    "今後",
    "の",
    "進め方",
    "を",
    "決め",
    "たい",
    "と",
    "思い",
    "ます",
    "。",
  ]);

  test("読点の直後で分かれる", () => {
    const cues = formatTranscript(long);
    expect(cues.length).toBeGreaterThan(1);
    // 最後の字幕以外は読点で終わる（読点で割ったので）
    for (const cue of cues.slice(0, -1)) expect(cue.text.replace(/\n/g, "").endsWith("、")).toBe(true);
  });

  test("読点で割ってもまだ長ければ文字数で割る", () => {
    const text = "あ".repeat(120);
    const parts = chunkSentence(text, [0, text.length], 40).map(([s, e]) => e - s);
    expect(parts).toEqual([40, 40, 40]);
  });

  test("読点で分けた断片は、収まる限りくっつける", () => {
    const text = "あい、うえ、おかきくけこ。";
    expect(chunkSentence(text, [0, text.length], 40)).toEqual([[0, text.length]]);
  });
});

describe("語の途中で切らない", () => {
  test("カタカナ語の途中では切らない（「事前ガ / イダンス」を防ぐ）", () => {
    for (const line of ALL_LINES(formatTranscript(TALK, { maxCharsPerLine: 8, maxLines: 2 }))) {
      expect(line.startsWith("イダンス")).toBe(false);
      expect(line.endsWith("事前ガ")).toBe(false);
    }
  });

  test("同じ種別が続く途中（カタカナ・漢字・英数字）は区切り候補にならない", () => {
    expect(breakScore("ガイダンス", 2)).toBeLessThan(0); // カタカナ - カタカナ
    expect(breakScore("多面観察", 2)).toBeLessThan(0); // 漢字 - 漢字
    expect(breakScore("2026", 2)).toBeLessThan(0); // 数字 - 数字
    expect(breakScore("montash", 3)).toBeLessThan(0); // 英字 - 英字
    expect(breakScore("見るガイダンス", 2)).toBeGreaterThan(0); // ひらがな → カタカナは語の頭
  });

  test("助詞の直前では切らない", () => {
    expect(breakScore("事前が", 2)).toBeLessThan(0);
    expect(breakScore("次長は", 2)).toBeLessThan(0);
    expect(breakScore("会議まで", 2)).toBeLessThan(0);
    for (const line of ALL_LINES(formatTranscript(TALK, { maxCharsPerLine: 7, maxLines: 2 }))) {
      expect(/^(?:は|が|を|に|へ|と|で|も|の|や|から|まで|より|など)/.test(line)).toBe(false);
    }
  });

  test("どうしても切れない長いカタカナ語は、目標位置で割ってバランスを取る", () => {
    // 1 語で 2 行ぶんを超えるので割るしかない。それでも均等に割る
    const lines = wrapLines("インターナショナルコミュニケーションストラテジー", 20, 2);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).toBe("インターナショナルコミュニケーションストラテジー");
    expect(Math.abs(lines[0]!.length - lines[1]!.length)).toBeLessThanOrEqual(2);
  });

  test("文字種の判定", () => {
    expect(charClass("漢")).toBe("kanji");
    expect(charClass("ア")).toBe("katakana");
    expect(charClass("ー")).toBe("katakana"); // 長音符はカタカナ語の一部
    expect(charClass("あ")).toBe("hiragana");
    expect(charClass("A")).toBe("latin");
    expect(charClass("7")).toBe("digit");
    expect(charClass("、")).toBe("punct");
  });
});

describe("禁則処理", () => {
  const FORBIDDEN_HEAD = [..."、。，．,.:：;；!！?？)）]］}｝〉》」』ーぁぃぅぇぉっゃゅょ・…々"];
  const FORBIDDEN_TAIL = [..."(（[［{｛〈《「『“‘"];

  test("行頭に句読点・閉じ括弧・小書き仮名・長音符を置かない", () => {
    const cues = formatTranscript(TALK, { maxCharsPerLine: 6, maxLines: 2 });
    for (const line of ALL_LINES(cues)) expect(FORBIDDEN_HEAD).not.toContain(line[0] as string);
  });

  test("行末に開き括弧を置かない", () => {
    const lines = wrapLines("彼は「そうですね、きっとそうでしょう」と言った", 12, 2);
    for (const line of lines) expect(FORBIDDEN_TAIL).not.toContain(line.at(-1) as string);
  });

  test("行頭に来てしまった文字は前の行にぶら下げる", () => {
    expect(applyKinsoku(["こんにちは", "。さようなら"])).toEqual(["こんにちは。", "さようなら"]);
    expect(applyKinsoku(["きた", "ーーと言った"])).toEqual(["きたーー", "と言った"]);
  });

  test("行末に来てしまった開き括弧は次の行へ送る", () => {
    expect(applyKinsoku(["彼は「", "そうだ」と言った"])).toEqual(["彼は", "「そうだ」と言った"]);
  });
});

describe("行数・文字数の制約", () => {
  const cases: Array<{ maxCharsPerLine: number; maxLines: number }> = [
    { maxCharsPerLine: 20, maxLines: 2 },
    { maxCharsPerLine: 12, maxLines: 2 },
    { maxCharsPerLine: 8, maxLines: 3 },
    { maxCharsPerLine: 30, maxLines: 1 },
  ];

  for (const opt of cases) {
    test(`最大 ${opt.maxLines} 行 × ${opt.maxCharsPerLine} 字に収まる`, () => {
      const cues = formatTranscript(TALK, opt);
      expect(cues.length).toBeGreaterThan(0);
      for (const cue of cues) {
        expect(cue.lines.length).toBeLessThanOrEqual(opt.maxLines);
        expect(cue.lines.length).toBeGreaterThan(0);
        // 禁則のぶら下げで 1 文字だけ超えることがある
        for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(opt.maxCharsPerLine + 1);
      }
    });
  }

  test("既定は 2 行 × 20 字", () => {
    expect(SUBTITLE_FORMAT_DEFAULTS.maxCharsPerLine).toBe(20);
    expect(SUBTITLE_FORMAT_DEFAULTS.maxLines).toBe(2);
  });

  test("短い本文は 1 行のまま", () => {
    expect(wrapLines("よろしくお願いします。", 20, 2)).toEqual(["よろしくお願いします。"]);
  });

  test("行の長さはできるだけ揃える", () => {
    const lines = wrapLines("今日は事前ガイダンスの内容についてお話しします。", 20, 2);
    expect(lines).toEqual(["今日は事前ガイダンスの", "内容についてお話しします。"]);
  });

  test("文字が 1 つも残らない（元の本文が失われない）", () => {
    const joined = formatTranscript(TALK, { maxCharsPerLine: 9, maxLines: 2 })
      .map((c) => c.lines.join(""))
      .join("");
    expect(joined).toBe(
      "今日は事前ガイダンスの内容についてお話しします。多面観察の結果は総括次長がまとめ、来週の会議で共有します。よろしくお願いします。",
    );
  });

  test("不正な制約は弾く", () => {
    expect(() => formatTranscript(TALK, { maxLines: 0 })).toThrow();
    expect(() => formatTranscript(TALK, { maxCharsPerLine: 0 })).toThrow();
  });
});

describe("表示時間", () => {
  test("既定は 1.2〜5.5 秒", () => {
    expect(SUBTITLE_FORMAT_DEFAULTS.minDurationMs).toBe(1200);
    expect(SUBTITLE_FORMAT_DEFAULTS.maxDurationMs).toBe(5500);
  });

  test("短すぎる表示は下限まで伸ばす", () => {
    const cues = formatTranscript(tokens(["はい", "。"], 50));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.endMs - cues[0]!.startMs).toBe(1200);
  });

  test("長すぎる表示は上限で切る", () => {
    const cues = formatTranscript(tokens(["ええと", "。"], 4000));
    expect(cues[0]!.endMs - cues[0]!.startMs).toBe(5500);
  });

  test("次の字幕が迫っているときは下限より短くてよい（重ねない）", () => {
    const cues = retime(
      [
        { startMs: 0, endMs: 200, lines: ["a"], text: "a" },
        { startMs: 400, endMs: 2000, lines: ["b"], text: "b" },
      ],
      { minDurationMs: 1200, maxDurationMs: 5500, minGapMs: 40 },
    );
    expect(cues[0]!.endMs).toBe(360);
    expect(cues[0]!.endMs).toBeLessThan(cues[1]!.startMs);
  });

  test("字幕どうしが重ならない", () => {
    // トークンの時刻が重なっていても解消される
    const overlapping = [
      { text: "はい。", startMs: 0, endMs: 5000 },
      { text: "いいえ。", startMs: 1000, endMs: 6000 },
    ];
    const cues = formatTranscript(overlapping);
    expect(cues).toHaveLength(2);
    for (let i = 0; i + 1 < cues.length; i++) expect(cues[i]!.endMs).toBeLessThanOrEqual(cues[i + 1]!.startMs);
    for (const cue of cues) expect(cue.endMs).toBeGreaterThan(cue.startMs);
  });

  test("字幕の時刻はトークンの時刻から来る", () => {
    const cues = formatTranscript(tokens(["こんにちは", "。", "さようなら", "。"], 100));
    expect(cues[0]!.startMs).toBe(0);
    // 本文は 0〜600ms。下限まで伸ばしたいが、次が 600ms から始まるので隙間（40ms）の手前で止まる
    expect(cues[0]!.endMs).toBe(560);
    expect(cues[1]!.startMs).toBe(600);
    expect(cues[1]!.endMs).toBe(1800); // 最後なので下限まで伸ばせる
  });
});

describe("トークンの前処理", () => {
  test("特殊トークンを落とす", () => {
    const cleaned = cleanTokens([
      { text: "[_BEG_]", startMs: 0, endMs: 0 },
      { text: "<|ja|>", startMs: 0, endMs: 0 },
      { text: "", startMs: 0, endMs: 0 },
      { text: "はい", startMs: 0, endMs: 100 },
    ]);
    expect(cleaned).toEqual([{ text: "はい", startMs: 0, endMs: 100 }]);
  });

  test("開始時刻が前後しても単調増加に均す", () => {
    const cleaned = cleanTokens([
      { text: "あ", startMs: 500, endMs: 600 },
      { text: "い", startMs: 100, endMs: 200 },
    ]);
    expect(cleaned.map((t) => t.startMs)).toEqual([500, 500]);
    expect(cleaned[1]!.endMs).toBeGreaterThanOrEqual(cleaned[1]!.startMs);
  });

  test("空の入力は空の字幕", () => {
    expect(formatTranscript([])).toEqual([]);
    expect(formatTranscript([{ text: "  ", startMs: 0, endMs: 10 }])).toEqual([]);
  });
});

describe("SRT 出力", () => {
  test("時刻の書式", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(3_723_456)).toBe("01:02:03,456");
    expect(formatSrtTime(-5)).toBe("00:00:00,000");
  });

  test("番号 → 時刻 → 本文 → 空行", () => {
    // 本文は 0〜6000ms だが、上限 5.5 秒で切られる
    const srt = toSrt(formatTranscript(tokens(["こんにちは", "。"], 1000)));
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:05,500\nこんにちは。\n");
  });

  test("複数行の本文はそのまま改行で出る", () => {
    const srt = toSrt(formatTranscript(TALK));
    expect(srt.split("\n\n")).toHaveLength(3);
    expect(srt).toContain("今日は事前ガイダンスの\n内容についてお話しします。");
    expect(srt.startsWith("1\n")).toBe(true);
    expect(srt).toContain("\n3\n");
  });
});
