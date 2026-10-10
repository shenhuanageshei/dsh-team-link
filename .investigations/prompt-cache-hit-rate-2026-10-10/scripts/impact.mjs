import fs from "node:fs";
const P = "C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/";
const rows = JSON.parse(fs.readFileSync(P + "rows2.json", "utf8"));
const lines = fs.readFileSync(P + "session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq);
const txtOf = (c) => (c || []).map((x) => x.text || "").join("");

// does the pre-boundary system prompt contain the team-link section?
const sysEvs = evs.filter((e) => e.type === "system/message");
console.log("=== presence of '[team-link 会话资源]' in each system/message event ===");
let firstWith = null;
for (const e of sysEvs) {
  const t = txtOf(e.data.message?.content);
  const has = t.includes("[team-link 会话资源]");
  if (has && !firstWith) { firstWith = e; console.log("  FIRST system prompt containing the section: seq", e.seq, new Date(e.time).toISOString(), "len", t.length); }
  if (!has && firstWith === null) { /* still clean */ }
}
const clean = sysEvs.filter((e) => !txtOf(e.data.message?.content).includes("[team-link 会话资源]"));
const dirty = sysEvs.filter((e) => txtOf(e.data.message?.content).includes("[team-link 会话资源]"));
console.log("  system prompts WITHOUT the section:", clean.length, " WITH the section:", dirty.length);
if (clean.length) console.log("  last clean system prompt: seq", clean[clean.length - 1].seq, new Date(clean[clean.length - 1].time).toISOString());

const BOUND = 1519;
const num = rows.filter((r) => typeof r.cacheR === "number");
const before = num.filter((r) => r.seq < BOUND);
const after = num.filter((r) => r.seq >= BOUND);
const agg = (sel, lbl) => {
  const p = sel.reduce((a, r) => a + r.prompt, 0), c = sel.reduce((a, r) => a + r.cacheR, 0), o = sel.reduce((a, r) => a + r.out, 0);
  console.log(`  ${lbl.padEnd(46)} n=${String(sel.length).padStart(3)} prompt=${p.toLocaleString().padStart(15)} cacheRead=${c.toLocaleString().padStart(15)} HIT=${(c / p * 100).toFixed(1)}%  full-price=${(p - c).toLocaleString().padStart(14)} out=${o.toLocaleString()}`);
  return { p, c, n: sel.length };
};
console.log("\n=== before / after the section got (re)registered at seq " + BOUND + " (turn 64) ===");
const b = agg(before, "turns 1-63 (no team-link section)");
const a = agg(after, "turns 64-112 (section present)");
agg(num, "WHOLE SESSION");
agg(num.filter((r) => r.seq >= BOUND && r.sysChanged), "  of which: sysChanged steps");
agg(num.filter((r) => r.seq >= BOUND && !r.sysChanged), "  of which: sysUnchanged steps");

console.log("\n=== counterfactual ===");
const baseHit = b.c / b.p;
const wouldCache = Math.round(a.p * baseHit);
console.log("  baseline hit rate before registration:", (baseHit * 100).toFixed(1) + "%");
console.log("  tokens that WOULD have been cache hits after registration:", wouldCache.toLocaleString());
console.log("  tokens actually cache-hit after registration:                 ", a.c.toLocaleString());
console.log("  EXTRA full-price tokens caused by the section:", (wouldCache - a.c).toLocaleString());
console.log("  session-wide hit rate actually:", ((num.reduce((x, r) => x + r.cacheR, 0) / num.reduce((x, r) => x + r.prompt, 0)) * 100).toFixed(1) + "%");
console.log("  session-wide hit rate if the section had stayed out:", (((b.c + wouldCache) / (b.p + a.p)) * 100).toFixed(1) + "%");
