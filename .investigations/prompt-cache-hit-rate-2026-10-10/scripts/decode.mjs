import fs from "node:fs";
import zlib from "node:zlib";

const src = "C:/Users/huangchaowen/.dsh/sessions/--D-workspace-mal-analyze-cli--/team-link-2026-10-08-coordinator-d7ca53f8/session.v4.jsonl.zstd";
const buf = fs.readFileSync(src);
console.log("compressed bytes:", buf.length);

// count zstd magic occurrences
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let idx = 0, magics = [];
while ((idx = buf.indexOf(magic, idx)) !== -1) { magics.push(idx); idx += 4; }
console.log("magic occurrences:", magics.length, "first 10 offsets:", magics.slice(0, 10).join(","));

// Try stream decompress (should continue across frames)
const chunks = [];
const dec = zlib.createZstdDecompress();
await new Promise((res, rej) => {
  dec.on("data", (c) => chunks.push(c));
  dec.on("end", res);
  dec.on("error", rej);
  dec.write(buf);
  dec.end();
});
const out = Buffer.concat(chunks).toString("utf8");
console.log("decompressed bytes:", out.length);
const lines = out.split(/\r?\n/).filter((l) => l.length);
console.log("lines:", lines.length);
fs.writeFileSync("C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/session.jsonl", out, "utf8");

const hist = new Map();
let bad = 0;
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    const k = o.type || o.kind || Object.keys(o).join("+").slice(0, 60);
    hist.set(k, (hist.get(k) || 0) + 1);
  } catch { bad++; }
}
console.log("parse failures:", bad);
console.log("--- type histogram ---");
[...hist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(8), k));
