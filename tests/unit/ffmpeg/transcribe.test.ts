/**
 * 書き起こしエンジンの探索・引数・出力の解釈（`ffmpeg/transcribe.ts`、docs/03 W-22）。
 * エンジン本体は呼ばない（montash は外部コマンドを呼ぶだけ）。
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode, MontashError } from "../../../src/cli/errors.ts";
import {
  findModel,
  findTranscriber,
  parseVocabulary,
  parseWhisperJson,
  requireModel,
  requireTranscriber,
  TRANSCRIBER_CANDIDATES,
  whisperArgs,
} from "../../../src/ffmpeg/transcribe.ts";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "montash-transcribe-"));
}

/** PATH も montash の置き場も見ない（実機に whisper が入っていても結果が変わらないようにする） */
const NO_PATH = { which: () => null, home: join(tmpdir(), "montash-transcribe-absent") };
const NO_ENV: NodeJS.ProcessEnv = {};

describe("エンジンの探索", () => {
  test("--engine-path が最優先", () => {
    const dir = sandbox();
    const bin = join(dir, "whisper-cli");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(findTranscriber({ enginePath: bin, env: NO_ENV, ...NO_PATH })).toEqual({ path: bin, source: "explicit" });
  });

  test("MONTASH_TRANSCRIBER で指定できる", () => {
    const dir = sandbox();
    const bin = join(dir, "my-whisper");
    writeFileSync(bin, "#!/bin/sh\n");
    expect(findTranscriber({ env: { MONTASH_TRANSCRIBER: bin }, ...NO_PATH })).toEqual({ path: bin, source: "env" });
  });

  test("PATH から既定の候補を順に探す", () => {
    const found = findTranscriber({
      env: NO_ENV,
      which: (name) => (name === "whisper-cpp" ? "/usr/local/bin/whisper-cpp" : null),
    });
    expect(found).toEqual({ path: "/usr/local/bin/whisper-cpp", source: "path" });
  });

  test("--engine で実行ファイル名を変えられる", () => {
    const looked: string[] = [];
    findTranscriber({
      engine: "my-engine",
      env: NO_ENV,
      which: (name) => {
        looked.push(name);
        return null;
      },
    });
    expect(looked).toEqual(["my-engine"]);
  });

  test("既定の候補は whisper-cli が先頭", () => {
    expect(TRANSCRIBER_CANDIDATES[0]).toBe("whisper-cli");
  });

  test("無ければ E_TRANSCRIBER_NOT_FOUND（終了コード 3、導入方法を hint に）", () => {
    let err: MontashError | null = null;
    try {
      requireTranscriber({ env: NO_ENV, ...NO_PATH });
    } catch (e) {
      err = e as MontashError;
    }
    expect(err).toBeInstanceOf(MontashError);
    expect(err?.code).toBe("E_TRANSCRIBER_NOT_FOUND");
    expect(err?.exitCode).toBe(ExitCode.EXTERNAL);
    expect(err?.hint).toContain("whisper.cpp");
    expect(err?.hint).toContain("MONTASH_TRANSCRIBER");
    expect(err?.detail?.looked_for).toEqual([...TRANSCRIBER_CANDIDATES]);
  });

  test("指定したパスに無いときも E_TRANSCRIBER_NOT_FOUND", () => {
    expect(() => requireTranscriber({ enginePath: "/nope/whisper", env: NO_ENV, ...NO_PATH })).toThrow(
      /E_TRANSCRIBER_NOT_FOUND|not found/,
    );
  });
});

describe("モデルの探索", () => {
  test("--model が最優先", () => {
    const dir = sandbox();
    const model = join(dir, "ggml-base.bin");
    writeFileSync(model, "");
    expect(findModel({ model, env: NO_ENV })).toBe(model);
  });

  test("置き場の *.bin を拾う（名前順で最後）", () => {
    const home = sandbox();
    writeFileSync(join(home, "ggml-base.bin"), "");
    writeFileSync(join(home, "ggml-large-v3.bin"), "");
    writeFileSync(join(home, "readme.txt"), "");
    expect(findModel({ env: NO_ENV, home })).toBe(join(home, "ggml-large-v3.bin"));
  });

  test("無ければ E_TRANSCRIBER_MODEL_NOT_FOUND（置き場と入手方法を hint に）", () => {
    const home = join(sandbox(), "empty");
    mkdirSync(home);
    let err: MontashError | null = null;
    try {
      requireModel({ env: NO_ENV, home });
    } catch (e) {
      err = e as MontashError;
    }
    expect(err?.code).toBe("E_TRANSCRIBER_MODEL_NOT_FOUND");
    expect(err?.exitCode).toBe(ExitCode.EXTERNAL);
    expect(err?.hint).toContain("MONTASH_TRANSCRIBER_MODEL");
  });
});

describe("引数の組み立て", () => {
  const base = { model: "/m/ggml.bin", audio: "/tmp/a.wav", outPrefix: "/tmp/out" };

  test("トークン単位のタイムスタンプ付き JSON を要求する", () => {
    const args = whisperArgs(base);
    expect(args).toContain("--output-json-full");
    expect(args.join(" ")).toContain("--output-file /tmp/out");
    expect(args.join(" ")).toContain("--model /m/ggml.bin");
    expect(args.join(" ")).toContain("--file /tmp/a.wav");
  });

  test("--lang は engine の --language になる", () => {
    expect(whisperArgs({ ...base, lang: "ja" }).join(" ")).toContain("--language ja");
    expect(whisperArgs(base).join(" ")).not.toContain("--language");
  });

  test("用語リストは --prompt に渡る（実地で精度が大きく変わった）", () => {
    const args = whisperArgs({ ...base, vocabulary: ["多面観察", " 総括次長 ", ""] });
    expect(args[args.indexOf("--prompt") + 1]).toBe("多面観察、総括次長");
  });

  test("用語リストが空なら --prompt は付けない", () => {
    expect(whisperArgs({ ...base, vocabulary: [] })).not.toContain("--prompt");
  });

  test("--threads を渡せる", () => {
    expect(whisperArgs({ ...base, threads: 4 }).join(" ")).toContain("--threads 4");
  });

  test("--vocabulary の書き方（カンマ・読点・複数指定）", () => {
    expect(parseVocabulary("多面観察,総括次長")).toEqual(["多面観察", "総括次長"]);
    expect(parseVocabulary(["多面観察、総括次長", " 期初面談 "])).toEqual(["多面観察", "総括次長", "期初面談"]);
    expect(parseVocabulary(undefined)).toEqual([]);
  });
});

describe("エンジンの JSON の解釈", () => {
  const full = {
    transcription: [
      {
        offsets: { from: 0, to: 1000 },
        text: "こんにちは。",
        tokens: [
          { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
          { text: "こんにちは", offsets: { from: 0, to: 900 } },
          { text: "。", offsets: { from: 900, to: 1000 } },
        ],
      },
    ],
  };

  test("トークン単位のタイムスタンプを読む", () => {
    expect(parseWhisperJson(full)).toEqual([
      { text: "[_BEG_]", startMs: 0, endMs: 0 },
      { text: "こんにちは", startMs: 0, endMs: 900 },
      { text: "。", startMs: 900, endMs: 1000 },
    ]);
  });

  test("トークンが無ければセグメント単位に落とす", () => {
    const tokens = parseWhisperJson({ transcription: [{ offsets: { from: 100, to: 500 }, text: "はい。" }] });
    expect(tokens).toEqual([{ text: "はい。", startMs: 100, endMs: 500 }]);
  });

  test("壊れた JSON でも落ちない", () => {
    expect(parseWhisperJson(null)).toEqual([]);
    expect(parseWhisperJson({})).toEqual([]);
    expect(parseWhisperJson({ transcription: "x" })).toEqual([]);
    expect(parseWhisperJson({ transcription: [{ tokens: [{ text: "あ" }] }] })).toEqual([]);
  });
});
