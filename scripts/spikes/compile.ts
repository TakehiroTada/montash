import html from "./embed.html" with { type: "file" };

console.log("embedded:", await Bun.file(html).text());
