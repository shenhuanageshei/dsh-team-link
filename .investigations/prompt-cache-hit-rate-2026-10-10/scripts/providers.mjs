import fs from "node:fs";
import zlib from "node:zlib";
const src = process.argv[2];
const buf = fs.readFileSync(src);
const MAGIC = 0xfd2fb528;
function frameEnd(b, off) {
  if (b.readUInt32LE(off) !== MAGIC) return -1;
  let p = off + 4; const fhd = b[p++];
  const fcsFlag = (fhd >> 6) & 3, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
  if (!single) p += 1; p += [0, 1, 2, 4][didFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) { const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); p += 3; const last = h & 1, bt = (h >> 1) & 3, bs = (h >> 3) & 0x1fffff; if (bt === 0 || bt === 2) p += bs; else if (bt === 1) p += 1; else return -1; if (last) break; }
  if (checksum) p += 4; return p;
}
let off = 0; const outs = [];
while (off < buf.length) { const end = frameEnd(buf, off); if (end < 0 || end <= off) { const n = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 1); if (n < 0) break; off = n; continue; } try { outs.push(zlib.zstdDecompressSync(buf.subarray(off, end))); } catch {} off = end; }
const evs = Buffer.concat(outs).toString("utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));

const models = new Map(), toolCounts = new Map(), headerCfg = new Map();
let sysCount = 0, firstSys = null;
for (const e of evs) {
  if (e.type === "model/selection") { const k = e.data.provider + "/" + e.data.model; models.set(k, (models.get(k) || 0) + 1); }
  if (e.type === "request/header") {
    const c = e.data.header.config; const k = [c.provider, c.model, "max=" + c.maxTokens, "effort=" + c.reasoningEffort].join(" | ");
    headerCfg.set(k, (headerCfg.get(k) || 0) + 1);
    const n = (e.data.header.tools || []).length; toolCounts.set(n, (toolCounts.get(n) || 0) + 1);
  }
  if (e.type === "system/message") { sysCount++; if (firstSys === null) firstSys = (e.data.message?.content || []).map((c) => c.text).join(""); }
}
console.log("### " + src.split("\\").slice(-2)[0]);
console.log("  model/selection:", [...models.entries()].map(([k, v]) => k + " x" + v).join(" ; "));
console.log("  request/header configs:", [...headerCfg.entries()].map(([k, v]) => k + " x" + v).join(" ; "));
console.log("  tool counts:", [...toolCounts.entries()].map(([k, v]) => k + " x" + v).join(" ; "));
console.log("  system/message events:", sysCount);
if (firstSys) {
  const i = firstSys.indexOf("[team-link 会话资源]");
  console.log("  first system prompt len:", firstSys.length, " section offset:", i, i >= 0 ? "(at " + (i / firstSys.length * 100).toFixed(1) + "% of the prompt)" : "");
  const sysPart = firstSys.slice(0, i >= 0 ? i : 400).slice(0, 400);
  console.log("  system prompt starts with:", JSON.stringify(sysPart.slice(0, 260)));
}
