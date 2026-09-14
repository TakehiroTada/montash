import yargs from "yargs"; import { hideBin } from "yargs/helpers";
const argv = await yargs(hideBin(["bun","x","clip","trim","c2","--in","+0.5","--ripple","--json","-m","00:12 カット"]))
  .command("clip", "clip ops", y => y.command("trim <id>", "trim", yy => yy.positional("id",{type:"string"}).option("in",{type:"string"}).option("ripple",{type:"boolean"})))
  .option("json",{type:"boolean"}).option("m",{alias:"message",type:"string"}).strict().parse();
console.log("yargs parsed:", JSON.stringify(argv));
console.log("RESULT yargs:", argv.id==="c2" && argv.in==="+0.5" && argv.ripple===true && argv.json===true && argv.message==="00:12 カット" ? "OK":"FAIL");
