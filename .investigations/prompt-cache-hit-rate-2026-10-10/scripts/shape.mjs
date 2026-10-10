import fs from "node:fs";
const lines = fs.readFileSync("C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const hist = new Map();
const samples = new Map();
for (const l of lines) {
  let o; try { o = JSON.parse(l); } catch { hist.set("<<unparsable>>", (hist.get("<<unparsable>>") || 0) + 1); continue; }
  const k = o.type || o.kind || ("keys:" + Object.keys(o).slice(0, 8).join("+"));
  hist.set(k, (hist.get(k) || 0) + 1);
  if (!samples.has(k)) samples.set(k, l.slice(0, 700));
}
console.log("=== type histogram ===");
[...hist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(7), k));
console.log("\n=== first sample per type ===");
for (const [k, s] of samples) console.log("\n--- " + k + " ---\n" + s);
