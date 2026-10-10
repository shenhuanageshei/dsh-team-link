import fs from "node:fs";
import zlib from "node:zlib";

const src = process.argv[2];
const label = process.argv[3] || src;
const buf = fs.readFileSync(src);
const MAGIC = 0xfd2fb528;
function frameEnd(b, off) {
  if (b.readUInt32LE(off) !== MAGIC) return -1;
  let p = off + 4;
  const fhd = b[p++];
  const fcsFlag = (fhd >> 6) & 3, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, didFlag = fhd & 3;
  if (!single) p += 1;
  p += [0, 1, 2, 4][didFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > b.length) return -1;
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); p += 3;
    const last = h & 1, bt = (h >> 1) & 3, bs = (h >> 3) & 0x1fffff;
    if (bt === 0 || bt === 2) p += bs; else if (bt === 1) p += 1; else return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}
let off = 0; const outs = [];
while (off < buf.length) {
  const end = frameEnd(buf, off);
  if (end < 0 || end <= off) { const n = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 1); if (n < 0) break; off = n; continue; }
  try { outs.push(zlib.zstdDecompressSync(buf.subarray(off, end))); } catch {}
  off = end;
}
const evs = Buffer.concat(outs).toString("utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
const txtOf = (c) => (c || []).map((x) => x.text || "").join("");

let sysText = null, lastResourceLine = null, sysChanges = 0, resourceChanges = 0, firstSectionSeq = null;
const rows = [];
for (const e of evs) {
  if (e.type === "system/message") {
    const t = txtOf(e.data?.message?.content);
    if (t !== sysText) {
      sysChanges++;
      const line = t.split("\n").find((l) => l.startsWith("[team-link 会话资源]")) || null;
      if (line !== lastResourceLine && line !== null) resourceChanges++;
      lastResourceLine = line;
      sysText = t;
      if (line !== null && firstSectionSeq === null) firstSectionSeq = e.seq;
    }
  }
  if (e.type === "assistant/message" && e.data?.usage) {
    const u = e.data.usage;
    if (typeof u.cacheReadTokens !== "number") continue;
    const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
    rows.push({
      turn: e.data.turn, step: e.data.step, prompt, cacheR: u.cacheReadTokens,
      hasSection: sysText !== null && sysText.includes("[team-link 会话资源]"),
      resource: lastResourceLine,
    });
  }
}
const agg = (sel, lbl) => {
  const p = sel.reduce((a, r) => a + r.prompt, 0), c = sel.reduce((a, r) => a + r.cacheR, 0);
  console.log(`    ${lbl.padEnd(40)} n=${String(sel.length).padStart(4)} prompt=${p.toLocaleString().padStart(15)} cacheRead=${c.toLocaleString().padStart(15)} HIT=${p ? (c / p * 100).toFixed(1) + "%" : "n/a"}`);
};
console.log("### " + label);
console.log("  requests:", rows.length, " system prompt changes:", sysChanges, " resource-line changes:", resourceChanges, " first seq with section:", firstSectionSeq);
agg(rows, "ALL requests");
agg(rows.filter((r) => r.hasSection), "requests WITH team-link section");
agg(rows.filter((r) => !r.hasSection), "requests WITHOUT team-link section");
console.log("");
