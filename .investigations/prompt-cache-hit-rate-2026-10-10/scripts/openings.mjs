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
let sysText = null, prov = "?", mdl = "?";
const rows = [];
for (const e of evs) {
  if (e.type === "system/message") { const t = txtOf(e.data?.message?.content); if (t !== sysText) sysText = t; }
  if (e.type === "request/header") { prov = e.data.header.config.provider; mdl = e.data.header.config.model; }
  if (e.type === "assistant/message" && e.data?.usage && typeof e.data.usage.cacheReadTokens === "number") {
    const u = e.data.usage; const prompt = (u.inputTokens || 0) + u.cacheReadTokens;
    rows.push({ turn: e.data.turn, step: e.data.step, prompt, cacheR: u.cacheReadTokens, model: prov + "/" + mdl, has: (sysText || "").includes("[team-link 会话资源]") });
  }
}
console.log("### " + src.split("\\").slice(-2)[0]);
const agg = (sel, lbl) => { const p = sel.reduce((a, r) => a + r.prompt, 0), c = sel.reduce((a, r) => a + r.cacheR, 0); if (!sel.length) { console.log("   " + lbl.padEnd(44) + " (none)"); return; } console.log(`   ${lbl.padEnd(44)} n=${String(sel.length).padStart(4)} prompt=${p.toLocaleString().padStart(15)} HIT=${(c / p * 100).toFixed(1)}% full-price=${(p - c).toLocaleString()}`); };
for (const has of [false, true]) {
  const sel = rows.filter((r) => r.has === has);
  console.log(`  --- team-link section ${has ? "PRESENT" : "ABSENT"} ---`);
  for (const m of [...new Set(sel.map((r) => r.model))]) {
    const ms = sel.filter((r) => r.model === m);
    agg(ms, m + " ALL");
    agg(ms.filter((r) => r.step === 1), m + " turn-opening (step 1)");
    agg(ms.filter((r) => r.step !== 1), m + " continuation (step>1)");
  }
}
