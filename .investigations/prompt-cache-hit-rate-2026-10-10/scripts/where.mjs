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
const txtOf = (c) => (c || []).map((x) => x.text || "").join("");
const cpl = (a, b) => { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a[i] === b[i]) i++; return i; };

console.log("### " + src.split("\\").slice(-2)[0]);
let prevSys = null;
const diffs = [];
for (const e of evs) {
  if (e.type !== "system/message") continue;
  const t = txtOf(e.data?.message?.content);
  if (prevSys !== null && t !== prevSys) {
    const cp = cpl(prevSys, t);
    diffs.push({ seq: e.seq, len: t.length, cp, pct: cp / t.length * 100, changed: t.slice(cp, cp + 60) });
  }
  prevSys = t;
}
console.log("  system-prompt changes:", diffs.length);
const shown = diffs.slice(-6);
for (const d of shown) console.log(`   seq ${d.seq}: len=${d.len} commonPrefix=${d.cp} (${d.pct.toFixed(1)}% of prompt) firstChangedChars=${JSON.stringify(d.changed)}`);
const pcts = diffs.map((d) => d.pct).sort((a, b) => a - b);
if (pcts.length) console.log(`  commonPrefix position: min ${pcts[0].toFixed(1)}% / median ${pcts[Math.floor(pcts.length / 2)].toFixed(1)}% / max ${pcts[pcts.length - 1].toFixed(1)}%`);

// per-request model
let prov = "?", mdl = "?";
const byModel = new Map();
const missConst = new Map();
for (const e of evs) {
  if (e.type === "request/header") { const c = e.data.header.config; prov = c.provider; mdl = c.model; }
  if (e.type === "assistant/message" && e.data?.usage && typeof e.data.usage.cacheReadTokens === "number") {
    const u = e.data.usage; const prompt = (u.inputTokens || 0) + u.cacheReadTokens;
    const k = prov + "/" + mdl;
    const a = byModel.get(k) || { n: 0, p: 0, c: 0 };
    a.n++; a.p += prompt; a.c += u.cacheReadTokens; byModel.set(k, a);
    if (u.cacheReadTokens / prompt < 0.5) missConst.set(u.cacheReadTokens, (missConst.get(u.cacheReadTokens) || 0) + 1);
  }
}
console.log("  per-model request accounting:");
for (const [k, a] of byModel) console.log(`    ${k.padEnd(34)} n=${String(a.n).padStart(4)} prompt=${a.p.toLocaleString().padStart(15)} HIT=${(a.c / a.p * 100).toFixed(1)}%`);
console.log("  cacheRead values on MISSES (value x count):", [...missConst.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, n]) => v + " x" + n).join(", "));
