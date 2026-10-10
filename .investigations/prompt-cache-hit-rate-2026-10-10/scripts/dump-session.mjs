import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
const src = process.argv[2];
const N = Number(process.argv[3] || 30);
const buf = fs.readFileSync(src);
const MAGIC = 0xfd2fb528;
function frameEnd(b, off) {
  if (b.readUInt32LE(off) !== MAGIC) return -1;
  let p = off + 4; const fhd = b[p++];
  const fcsFlag = (fhd >> 6) & 3, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
  if (!single) p += 1;
  p += [0, 1, 2, 4][didFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) { const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); p += 3; const last = h & 1, bt = (h >> 1) & 3, bs = (h >> 3) & 0x1fffff; if (bt === 0 || bt === 2) p += bs; else if (bt === 1) p += 1; else return -1; if (last) break; }
  if (checksum) p += 4; return p;
}
let off = 0; const outs = [];
while (off < buf.length) { const end = frameEnd(buf, off); if (end < 0 || end <= off) { const n = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 1); if (n < 0) break; off = n; continue; } try { outs.push(zlib.zstdDecompressSync(buf.subarray(off, end))); } catch {} off = end; }
const evs = Buffer.concat(outs).toString("utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
const txtOf = (c) => (c || []).map((x) => x.text || "").join("");
const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 6);
let sysText = null, resLine = null;
const rows = [];
for (const e of evs) {
  if (e.type === "system/message") { const t = txtOf(e.data?.message?.content); if (t !== sysText) { sysText = t; resLine = t.split("\n").find((l) => l.startsWith("[team-link 会话资源]")) || null; } }
  if (e.type === "assistant/message" && e.data?.usage && typeof e.data.usage.cacheReadTokens === "number") {
    const u = e.data.usage; const prompt = (u.inputTokens || 0) + u.cacheReadTokens;
    rows.push({ seq: e.seq, turn: e.data.turn, step: e.data.step, prompt, cacheR: u.cacheReadTokens, hit: u.cacheReadTokens / prompt * 100, sys: h(sysText || ""), res: resLine });
  }
}
console.log("last " + N + " requests of " + src.split("\\").pop());
console.log(["seq", "turn", "step", "prompt", "cacheR", "hit%", "sysHash", "resLine"].join("\t"));
for (const r of rows.slice(-N)) console.log([r.seq, r.turn, r.step, r.prompt, r.cacheR, r.hit.toFixed(1), r.sys, (r.res || "(none)").slice(0, 78)].join("\t"));
