const big = import.meta.dir + "/big.bin";
await Bun.write(big, new Uint8Array(1_000_000).map((_, i) => i % 251));
const srv = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
    if (url.pathname === "/auto") return new Response(Bun.file(big));            // rely on Bun auto Range?
    if (url.pathname === "/manual") {                                            // manual Range via slice
      const f = Bun.file(big); const r = req.headers.get("range");
      if (!r) return new Response(f);
      const [, s, e] = /bytes=(\d*)-(\d*)/.exec(r)!; const start = s ? +s : 0; const end = e ? Math.min(+e, f.size - 1) : f.size - 1;
      return new Response(f.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${f.size}`, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1) } });
    }
    return new Response("nf", { status: 404 });
  },
  websocket: { open(ws) { ws.send("hello"); }, message(ws, m) { ws.send("echo:" + m); } },
});
const base = `http://127.0.0.1:${srv.port}`;
for (const p of ["/auto", "/manual"]) {
  const res = await fetch(base + p, { headers: { Range: "bytes=100-199" } });
  const len = (await res.arrayBuffer()).byteLength;
  console.log(`${p}: status=${res.status} len=${len} content-range=${res.headers.get("content-range")} accept-ranges=${res.headers.get("accept-ranges")}`);
}
const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
const got: string[] = [];
await new Promise<void>(res => { ws.onmessage = e => { got.push(String(e.data)); if (got.length === 1) ws.send("ping"); if (got.length === 2) { ws.close(); res(); } }; });
console.log("ws:", JSON.stringify(got));
srv.stop(true);
console.log("RESULT ws:", got[1] === "echo:ping" ? "OK" : "FAIL");
