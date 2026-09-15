// montash を import しない自己完結のプラグイン（docs/14 の原則 3）。
export default {
  register(host) {
    host.log("registering spike");
    host.effects.define({
      name: "spike",
      target: "video",
      summary: "test effect from a plugin",
      requires: ["gblur"],
      params: { sigma: { type: "number", describe: "blur radius", default: 3, min: 0, max: 32 } },
      build: (p) => [`gblur=sigma=${p.sigma}`],
    });

    // 汎用プラグイン: CLI コマンドを足す（docs/14 §3.3）。
    // path は名前空間（プラグイン ID の末尾 = "spike"）からの相対なので `montash spike count` になる。
    host.commands.define({
      path: "count",
      summary: "count the clips in the project (from a plugin)",
      run: (ctx) => {
        const clips = (ctx.project?.tracks ?? []).flatMap((t) => t.clips ?? []);
        return { result: { clips: clips.length }, human: `${clips.length} clip(s)` };
      },
    });

    // 状態変更コマンド。project.json はホストが runMutation 経由で書く（原則 4）。
    // プラグインは渡された作業コピーを書き換え、op の要約を返すだけ。
    host.commands.define({
      path: "tag",
      summary: "add a tag to the project (from a plugin)",
      mutates: true,
      positionals: [{ name: "label", describe: "tag to add", required: true }],
      run: (ctx, args) => {
        const label = String(args.label);
        const tags = ctx.project.meta.tags;
        if (tags.includes(label)) return { result: { tags }, summary: `tag ${label} (no change)`, changed: false };
        tags.push(label);
        return { result: { tags }, summary: `add tag "${label}"`, human: `tags: ${tags.join(", ")}` };
      },
    });
  },
};
