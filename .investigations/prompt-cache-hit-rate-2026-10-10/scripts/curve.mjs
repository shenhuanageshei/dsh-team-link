import fs from "node:fs";
import crypto from "node:crypto";
const P = "C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/";
const lines = fs.readFileSync(P + "session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l));
const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);

// ---- timeline of prefix-relevant events in seq order ----
const ev = [...evs].sort((a, b) => a.seq - b.seq);

let curProvider = "?", curModel = "?", curTools = "?", curSys = "?";
const rows = [];
for (const e of ev) {
  if (e.type === "request/header") {
    const c = e.data?.header?.config || {};
    curProvider = c.provider; curModel = c.model;
    curTools = h(JSON.stringify(e.data.header.tools || []));
  }
  if (e.type === "system/message") {
    curSys = h(JSON.stringify(e.data.message?.content ?? e.data.message));
  }
  if (e.type === "assistant/message" && e.data?.usage) {
    const u = e.data.usage;
    const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
    rows.push({
      seq: e.seq, turn: e.data.turn, step: e.data.step, time: e.time,
      provider: curProvider, model: curModel, tools: curTools, sys: curSys,
      inTok: u.inputTokens, cacheR: u.cacheReadTokens, cacheW: u.cacheWriteTokens,
      out: u.outputTokens, prompt,
      hit: prompt ? u.cacheReadTokens / prompt : 0,
    });
  }
}
fs.writeFileSync(P + "rows.json", JSON.stringify(rows, null, 1));

const tot = rows.reduce((a, r) => ({ p: a.p + r.prompt, c: a.c + r.cacheR, i: a.i + r.inTok, o: a.o + r.out }), { p: 0, c: 0, i: 0, o: 0 });
console.log("=== session totals ===");
console.log("requests:", rows.length);
console.log("prompt tokens:", tot.p.toLocaleString(), " cacheRead:", tot.c.toLocaleString(), " cacheMiss(input):", tot.i.toLocaleString(), " output:", tot.o.toLocaleString());
console.log("OVERALL HIT RATE:", (tot.c / tot.p * 100).toFixed(1) + "%");
console.log("cacheWriteTokens total:", rows.reduce((a, r) => a + (r.cacheW || 0), 0));

// per provider/model
const byModel = new Map();
for (const r of rows) {
  const k = r.provider + "/" + r.model;
  const a = byModel.get(k) || { n: 0, p: 0, c: 0, i: 0, o: 0 };
  a.n++; a.p += r.prompt; a.c += r.cacheR; a.i += r.inTok; a.o += r.out;
  byModel.set(k, a);
}
console.log("\n=== by provider/model ===");
for (const [k, a] of byModel) console.log(`  ${k}: n=${a.n} prompt=${a.p.toLocaleString()} hit=${(a.c / a.p * 100).toFixed(1)}%`);

// hit rate buckets
console.log("\n=== hit-rate distribution ===");
const buckets = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 0.9], [0.9, 0.99], [0.99, 1.01]];
for (const [lo, hi] of buckets) {
  const sel = rows.filter((r) => r.hit >= lo && r.hit < hi);
  console.log(`  ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%: ${sel.length} reqs, prompt ${sel.reduce((a, r) => a + r.prompt, 0).toLocaleString()}`);
}

console.log("\n=== per-request table (first 60) ===");
console.log(["seq", "turn", "step", "model", "tools", "sys", "prompt", "cacheR", "inTok", "hit%"].join("\t"));
for (const r of rows.slice(0, 60)) {
  console.log([r.seq, r.turn, r.step, r.model, r.tools, r.sys, r.prompt, r.cacheR, r.inTok, (r.hit * 100).toFixed(1)].join("\t"));
}
