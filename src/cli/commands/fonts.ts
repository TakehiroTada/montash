/**
 * `montash fonts list [--filter <str>]`（docs/04 §4, W-06）
 *
 * 読み取りのみ。プロジェクトが無くても使える（テロップのフォント選びは init 前でもあり得る）。
 */
import { listFonts } from "../../ffmpeg/fonts.ts";
import { defineCommand } from "../define-command.ts";

interface Args extends Record<string, unknown> {
  filter?: string;
}

export const fontsList = defineCommand<Args>({
  path: "fonts list",
  summary: "list system font families, styles and files (CJK flagged)",
  workflows: ["W-06"],
  noProject: true,
  options: {
    filter: { type: "string", describe: "case-insensitive substring match on the family name" },
  },
  examples: [{ cmd: "montash fonts list --json" }, { cmd: 'montash fonts list --filter "Noto Sans"' }],
  async handler(ctx, args) {
    const { source, fonts } = await listFonts({
      env: ctx.env,
      ...(args.filter !== undefined ? { filter: String(args.filter) } : {}),
    });
    return {
      result: { source, fonts },
      human:
        fonts.map((f) => `${f.family}  ${f.style}${f.cjk ? "  [cjk]" : ""}  ${f.path}`).join("\n") ||
        `no fonts found (source: ${source})`,
    };
  },
});
