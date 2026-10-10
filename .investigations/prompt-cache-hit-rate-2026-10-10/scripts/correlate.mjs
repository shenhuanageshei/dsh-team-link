import fs from "node:fs";
import crypto from "node:crypto";
const P = "C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/";
const lines = fs.readFileSync(P + "session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq);
const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
const txtOf = (c) => (c || []).map((x) => x.text || "").join("");

// Build the request timeline: each assistant/message usage = one LLM request (step).
let curSys = null, curSysSeq = -1, curTools = null, curProvider = null, curModel = null;
let sysChangesSinceLastReq = 0;
const rows = [];
let prevReqTime = null;
for (const e of evs) {
  if (e.type === "system/message") {
    const t = txtOf(e.data.message?.content);
    const hh = h(t);
    if (hh !== curSys) { curSys = hh; curSysSeq = e.seq; sysChangesSinceLastReq++; }
  }
  if (e.type === "request/header") {
    const c = e.data?.header?.config || {};
    curTools = h(JSON.stringify(e.data.header.tools || []));
    if (c.provider !== curProvider || c.model !== curModel) { curProvider = c.provider; curModel = c.model; }
  }
  if (e.type === "assistant/message" && e.data?.usage) {
    const u = e.data.usage;
    const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
    rows.push({
      seq: e.seq, turn: e.data.turn, step: e.data.step, time: e.time,
      model: curProvider + "/" + curModel, tools: curTools, sys: curSys, sysSeq: curSysSeq,
      inTok: u.inputTokens, cacheR: u.cacheReadTokens, prompt,
      sysChanged: sysChangesSinceLastReq > 0,
      nSysChanges: sysChangesSinceLastReq,
      gapSec: prevReqTime ? Math.round((e.time - prevReqTime) / 1000) : null,
    });
    prevReqTime = e.time;
    sysChangesSinceLastReq = 0;
  }
}

fs.writeFileSync(P + "rows2.json", JSON.stringify(rows));

const fmt = (n) => (n == null ? "n/a" : n.toLocaleString());
const grp = (sel, label) => {
  const p = sel.reduce((a, r) => a + r.prompt, 0);
  const c = sel.reduce((a, r) => a + (r.cacheR || 0), 0);
  console.log(`  ${label.padEnd(34)} n=${String(sel.length).padStart(3)}  prompt=${fmt(p).padStart(15)}  cacheRead=${fmt(c).padStart(15)}  HIT=${p ? (c / p * 100).toFixed(1) + "%" : "n/a"}`);
  return { p, c };
};
// remove any row with undefined cacheRead (adapter didn't report)
const withCache = rows.filter((r) => typeof r.cacheR === "number");
console.log("requests total:", rows.length, " with numeric cacheReadTokens:", withCache.length, " without:", rows.length - withCache.length);
const noCache = rows.filter((r) => typeof r.cacheR !== "number");
if (noCache.length) {
  console.log("  requests lacking cacheReadTokens (seq):", noCache.map((r) => r.seq).join(","));
  console.log("  -> their models:", [...new Set(noCache.map((r) => r.model))].join(" | "));
}

console.log("\n=== A) split by whether the system prompt changed since the previous request ===");
const a1 = grp(withCache.filter((r) => r.sysChanged), "sys prompt CHANGED before req");
const a2 = grp(withCache.filter((r) => !r.sysChanged), "sys prompt UNCHANGED");

console.log("\n=== B) split by idle gap before the request ===");
for (const [lo, hi, lbl] of [[0, 60, "<60s"], [60, 300, "1-5min"], [300, 1800, "5-30min"], [1800, 1e9, ">30min"]]) {
  grp(withCache.filter((r) => r.gapSec != null && r.gapSec >= lo && r.gapSec < hi), "gap " + lbl);
}

console.log("\n=== C) split by tools-set change ===");
let prevT = null;
for (const r of withCache) { r.toolsChanged = prevT !== null && r.tools !== prevT; prevT = r.tools; }
grp(withCache.filter((r) => r.toolsChanged), "tool set CHANGED");
grp(withCache.filter((r) => !r.toolsChanged), "tool set unchanged");

console.log("\n=== D) cross-tab: sysChanged x gap<5min ===");
grp(withCache.filter((r) => r.sysChanged && r.gapSec != null && r.gapSec < 300), "sysChanged & gap<5min");
grp(withCache.filter((r) => !r.sysChanged && r.gapSec != null && r.gapSec < 300), "sysUnchanged & gap<5min");
grp(withCache.filter((r) => !r.sysChanged && r.gapSec != null && r.gapSec >= 300), "sysUnchanged & gap>=5min");

console.log("\n=== E) per-model ===");
for (const m of [...new Set(withCache.map((r) => r.model))]) grp(withCache.filter((r) => r.model === m), m);

// worst offenders
console.log("\n=== F) 25 lowest-hit requests ===");
console.log(["seq", "turn", "step", "prompt", "cacheR", "hit%", "sysChanged", "gapSec", "model"].join("\t"));
for (const r of [...withCache].sort((a, b) => (a.cacheR / a.prompt) - (b.cacheR / b.prompt)).slice(0, 25)) {
  console.log([r.seq, r.turn, r.step, r.prompt, r.cacheR, (r.cacheR / r.prompt * 100).toFixed(1), r.sysChanged, r.gapSec, r.model].join("\t"));
}
console.log("\n=== G) cost of the miss: tokens billed at full price on sysChanged requests ===");
console.log("  full-price tokens attributable to sysChanged requests:", fmt(a1.p - a1.c));
console.log("  full-price tokens on sysUnchanged requests:", fmt(a2.p - a2.c));
