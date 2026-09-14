import index from "./web/index.html";
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: { "/": index }, development: true, fetch() { return new Response("nf", { status: 404 }); } });
const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
const m = html.match(/src="([^"]+\.js)"/);
const js = m ? await (await fetch(`http://127.0.0.1:${srv.port}${m[1]}`)).text() : "";
console.log("html served:", html.includes("<div id=\"root\">"), "| bundled js served:", js.length > 1000, "| react in bundle:", /react/i.test(js));
srv.stop(true);
console.log("RESULT html-import dev server:", html.includes("root") && js.length > 1000 ? "OK" : "FAIL");
