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
  },
};
