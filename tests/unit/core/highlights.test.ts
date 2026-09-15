/**
 * ハイライト候補の検出（`core/highlights.ts`、docs/03 W-23, docs/13 D-23）。
 *
 * 区間検出は純関数なので、whisper も ffmpeg も無しにここで固定できる。
 * 見るのは「話題の切れ目で割れること」「長さの制約を守ること」「決めるのは人という前提を
 * 崩さないこと（枠の外の候補も消さずに返す）」「根拠が必ず付くこと」。
 */
import { describe, expect, test } from "bun:test";
import {
  cosine,
  extractTerms,
  HIGHLIGHT_DEFAULTS,
  leadSentence,
  type SilenceRange,
  startsWithCue,
  suggestHighlights,
  type TranscriptToken,
  toUtterances,
} from "../../../src/core/highlights.ts";

/**
 * 発話列からトークンを作る。`[text, startSec, endSec]`。
 * 1 発話 = 1 トークンでよい（`toUtterances` は間で繋ぎ直すだけなので粒度に依らない）。
 */
function tokens(rows: readonly [string, number, number][]): TranscriptToken[] {
  return rows.map(([text, start, end]) => ({ text, startMs: start * 1000, endMs: end * 1000 }));
}

/** 無音区間: 発話の隙間をすべて無音にする */
function silenceBetween(rows: readonly [string, number, number][], duration: number): SilenceRange[] {
  const out: SilenceRange[] = [];
  let cursor = 0;
  for (const [, start, end] of rows) {
    if (start > cursor) out.push({ from: cursor, to: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) out.push({ from: cursor, to: duration });
  return out;
}

/**
 * 2 つの話題からなる会議（前半は「山笠」、後半は「決算」）。
 * 境目には 3 秒の間と「では」が入っていて、機械的に見つかるようにしてある。
 */
const MEETING: [string, number, number][] = [
  ["今日は山笠の話をします。", 0, 8],
  ["山笠は毎日走ります。山笠の準備があります。", 9, 20],
  ["山笠の仲間と山笠の練習をしました。", 21, 34],
  ["山笠は有名な祭りです。", 35, 44],
  ["では決算の話に移ります。", 47, 56],
  ["決算の資料を確認しました。決算の締めは来月です。", 57, 70],
  ["決算の数字は経理が集計します。", 71, 84],
  ["決算について質問はありますか。", 85, 96],
];
const MEETING_DURATION = 100;

/**
 * しきい値を既定より上げて「話題の切れ目 1 つだけで割る」状態にする。
 * 既定（0.35）だと同じ話題のなかでも語の入れ替わりで割れるので、
 * 枠・本数・順位の検証はこの 2 分割の状態でやるほうが読みやすい。
 */
function suggest(options = {}) {
  return suggestHighlights(
    { duration: MEETING_DURATION, tokens: tokens(MEETING), silence: silenceBetween(MEETING, MEETING_DURATION) },
    { minDuration: 20, threshold: 0.6, ...options },
  );
}

describe("extractTerms", () => {
  test("字種の連なりを語として拾い、ひらがなは落とす", () => {
    expect(extractTerms("今日は山笠の話をします")).toEqual(["山笠"]);
    expect(extractTerms("テックライブのAWS資格に合格しました")).toEqual(["テックライブ", "AWS", "資格", "合格"]);
  });

  test("1 文字の語と、どの話題にも出る語は手掛かりにならないので落とす", () => {
    expect(extractTerms("私は方を見た")).toEqual([]);
    expect(extractTerms("今週の予定")).toEqual(["予定"]);
  });
});

describe("cosine", () => {
  test("同じ分布は 1、重なりが無ければ 0", () => {
    const a = new Map([["山笠", 3]]);
    expect(cosine(a, new Map([["山笠", 6]]))).toBeCloseTo(1, 6);
    expect(cosine(a, new Map([["決算", 2]]))).toBe(0);
    expect(cosine(a, new Map())).toBe(0);
  });
});

describe("startsWithCue", () => {
  test("話の頭に来る表現だけを拾う（filler は拾わない）", () => {
    expect(startsWithCue("では決算の話に移ります")).toBe("では");
    expect(startsWithCue("、続いて人事のお知らせです")).toBe("続いて");
    expect(startsWithCue("えーとそうですね")).toBeNull();
    expect(startsWithCue("山笠は毎日走ります")).toBeNull();
  });
});

describe("leadSentence", () => {
  test("最初の文をそのまま返す（要約しない）", () => {
    expect(leadSentence("今日は山笠の話です。明日は決算です。", 60)).toBe("今日は山笠の話です。");
  });

  test("句点が無ければ字数で切って … を付ける", () => {
    expect(leadSentence("あいうえおかきくけこ", 5)).toBe("あいうえお…");
    expect(leadSentence("あいうえお", 5)).toBe("あいうえお");
  });
});

describe("toUtterances", () => {
  test("間でまとめる（しきい値より短い隙間は 1 発話にする）", () => {
    const rows: [string, number, number][] = [
      ["あ", 0, 1],
      ["い", 1.2, 2],
      ["う", 5, 6],
    ];
    const utterances = toUtterances({ duration: 10, tokens: tokens(rows) }, 0.6);
    expect(utterances.map((u) => u.text)).toEqual(["あい", "う"]);
    expect(utterances[1]?.gapBefore).toBeCloseTo(3, 6);
  });

  test("書き起こしが無ければ無音区間の補集合を発話とみなす", () => {
    const utterances = toUtterances({ duration: 30, silence: [{ from: 10, to: 20 }] }, 0.6);
    expect(utterances.map((u) => [u.start, u.end])).toEqual([
      [0, 10],
      [20, 30],
    ]);
    expect(utterances.every((u) => u.text === "")).toBe(true);
  });

  test("whisper の特殊トークン（[_BEG_] / [_TT_325]）は本文に混ぜない", () => {
    const utterances = toUtterances(
      {
        duration: 5,
        tokens: tokens([
          ["[_BEG_]", 0, 0],
          ["山笠", 0, 1],
          ["[_TT_325]", 1, 1],
          ["の話", 1, 2],
        ]),
      },
      0.6,
    );
    expect(utterances[0]?.text).toBe("山笠の話");
  });
});

describe("suggestHighlights", () => {
  test("話題の切れ目で割れる（前半＝山笠 / 後半＝決算）", () => {
    const res = suggest();
    expect(res.candidates.length).toBe(2);
    const [first, second] = res.candidates;
    expect(first?.end).toBeLessThanOrEqual(47);
    expect(second?.start).toBeGreaterThanOrEqual(44);
    expect(first?.keywords).toContain("山笠");
    expect(second?.keywords).toContain("決算");
  });

  test("既定値でも話題の切れ目（44〜47 秒）では必ず割れる", () => {
    const res = suggestHighlights({
      duration: MEETING_DURATION,
      tokens: tokens(MEETING),
      silence: silenceBetween(MEETING, MEETING_DURATION),
    });
    const starts = res.candidates.map((c) => c.start);
    expect(starts.some((s) => s >= 44 && s <= 48)).toBe(true);
    // 山笠側の候補に決算の語は入らない（窓がまたがっていない）
    const beforeTopicShift = res.candidates.filter((c) => c.end <= 47);
    expect(beforeTopicShift.length).toBeGreaterThan(0);
    for (const c of beforeTopicShift) expect(c.keywords).not.toContain("決算");
  });

  test("根拠（間・語彙の移り変わり・切り出しの語）が必ず付く", () => {
    const second = suggest().candidates[1];
    expect(second?.evidence.lead_silence_s).toBeCloseTo(3, 1);
    expect(second?.evidence.lexical_shift).toBeGreaterThan(0.5);
    expect(second?.evidence.cue).toBe("では");
    expect(second?.evidence.chars_per_s).toBeGreaterThan(0);
  });

  test("lead は書き起こしの先頭の文そのもの（LLM で要約しない）", () => {
    expect(suggest().candidates[0]?.lead).toBe("今日は山笠の話をします。");
  });

  test("min-length より短い塊は作らない", () => {
    const res = suggest({ minDuration: 90 });
    expect(res.candidates.length).toBe(1);
    expect(res.candidates[0]?.duration).toBeGreaterThanOrEqual(90);
  });

  test("max-length を超える塊は中で一番強い切れ目で割る", () => {
    const res = suggest({ minDuration: 20, threshold: 1, maxDuration: 60 });
    expect(res.candidates.length).toBe(2);
    for (const c of res.candidates) expect(c.duration).toBeLessThanOrEqual(60);
  });

  test("--max（枠）を超える候補は選ばれないが、リストからは消えない（決めるのは人）", () => {
    const res = suggest({ budget: 45 });
    expect(res.candidates.length).toBe(2);
    expect(res.candidates.filter((c) => c.selected).length).toBe(1);
    expect(res.selected_duration).toBeLessThanOrEqual(45);
  });

  test("--count は本数だけを絞る", () => {
    const res = suggest({ count: 1 });
    expect(res.candidates.length).toBe(2);
    expect(res.candidates.filter((c) => c.selected).map((c) => c.rank)).toEqual([1]);
  });

  test("順位は 1 から連番で、すべての候補に付く", () => {
    const ranks = suggest()
      .candidates.map((c) => c.rank)
      .sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2]);
  });

  test("同じ入力からは必ず同じ結果（決定的）", () => {
    expect(JSON.stringify(suggest())).toBe(JSON.stringify(suggest()));
  });

  test("書き起こしが無くても無音区間だけで候補を出す（lead / keywords は空）", () => {
    const silence = silenceBetween(MEETING, MEETING_DURATION);
    const res = suggestHighlights({ duration: MEETING_DURATION, silence }, { minDuration: 20, pause: 2 });
    expect(res.signals.transcript).toBe(false);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(c.lead).toBe("");
      expect(c.keywords).toEqual([]);
    }
  });

  test("無音だらけの区間は発話の割合が下がる", () => {
    const res = suggest();
    for (const c of res.candidates) {
      expect(c.speech_ratio).toBeGreaterThan(0.5);
      expect(c.speech_ratio).toBeLessThanOrEqual(1);
    }
  });

  test("無音区間も書き起こしも無ければ全体を 1 本として返す（割る手掛かりが無いことを隠さない）", () => {
    const res = suggestHighlights({ duration: 60 });
    expect(res.signals).toMatchObject({ transcript: false, silence: false, boundaries: 0 });
    expect(res.candidates.map((c) => [c.start, c.end])).toEqual([[0, 60]]);
    expect(res.candidates[0]?.keywords).toEqual([]);
  });

  test("長さ 0 なら候補は 0 本（例外にはしない）", () => {
    const res = suggestHighlights({ duration: 0 });
    expect(res.candidates).toEqual([]);
    expect(res.signals.utterances).toBe(0);
  });

  test("既定値が result に載る（何で出した候補かが後から分かる）", () => {
    const res = suggestHighlights({ duration: MEETING_DURATION, tokens: tokens(MEETING) });
    expect(res.options.minDuration).toBe(HIGHLIGHT_DEFAULTS.minDuration);
    expect(res.options.threshold).toBe(HIGHLIGHT_DEFAULTS.threshold);
    expect(res.options.budget).toBeNull();
  });

  test("候補は時刻順に並び、重ならない", () => {
    const res = suggest();
    for (let i = 1; i < res.candidates.length; i++) {
      expect(res.candidates[i]?.start).toBeGreaterThanOrEqual(res.candidates[i - 1]?.end ?? 0);
    }
  });

  test("候補が素材の外にはみ出さない", () => {
    const res = suggest();
    expect(res.candidates[0]?.start).toBeGreaterThanOrEqual(0);
    expect(res.candidates.at(-1)?.end).toBeLessThanOrEqual(MEETING_DURATION);
  });
});
