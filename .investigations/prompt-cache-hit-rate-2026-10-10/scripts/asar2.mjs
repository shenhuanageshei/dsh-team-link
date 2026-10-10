import fs from "node:fs";
const p = "D:/DSH-Desktop-Official/resources/app.asar";
const s = fs.readFileSync(p).toString("latin1");
const mode = process.argv[2];
if (mode === "at") {
  const off = Number(process.argv[3]);
  const len = Number(process.argv[4] || 3000);
  console.log(s.slice(off, off + len).replace(/[\r\n]+/g, " ⏎ "));
} else {
  for (const n of process.argv.slice(2)) {
    let i = 0, hits = [];
    while ((i = s.indexOf(n, i)) !== -1) { hits.push(i); i += n.length; if (hits.length > 40) break; }
    console.log(`\n=== ${n} : ${hits.length} hit(s) ===`);
    for (const h of hits.slice(0, 5)) console.log("  @" + h + " … " + s.slice(Math.max(0, h - 200), h + 700).replace(/[\r\n]+/g, " ⏎ "));
  }
}
