import fs from "node:fs";
const p = "D:/DSH-Desktop-Official/resources/app.asar";
const buf = fs.readFileSync(p);
const s = buf.toString("latin1");
const needles = process.argv.slice(2);
for (const n of needles) {
  let i = 0, hits = [];
  while ((i = s.indexOf(n, i)) !== -1) { hits.push(i); i += n.length; if (hits.length > 60) break; }
  console.log(`\n=== ${n} : ${hits.length} hit(s) ===`);
  for (const h of hits.slice(0, 6)) {
    console.log("  @" + h + " … " + s.slice(Math.max(0, h - 260), h + 260).replace(/[\r\n]+/g, " ⏎ "));
  }
}
