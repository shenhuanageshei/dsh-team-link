// Aggregate the measured per-session numbers (hand-transcribed from analyze.mjs output).
const S = [
  { name: "coordinator d7ca53f8", ws: "mal-analyze-cli", withN: 116, withP: 57025189, withC: 4333888, woN: 207, woP: 53815671, woC: 51797440 },
  { name: "worker-1 944d2b52", ws: "mal-analyze-cli", withN: 145, withP: 62423401, withC: 334080, woN: 625, woP: 214766300, woC: 212667776 },
  { name: "worker-2 c1672114", ws: "mal-analyze-cli", withN: 96, withP: 41466920, withC: 221184, woN: 1036, woP: 383229057, woC: 380868096 },
  { name: "worker-3 ce8aca21", ws: "mal-analyze-cli", withN: 110, withP: 72241001, withC: 4693184, woN: 361, woP: 157098923, woC: 152527296 },
  { name: "worker-4 34504f2d", ws: "mal-analyze-cli", withN: 10, withP: 4428887, withC: 363584, woN: 388, woP: 110313991, woC: 106684672 },
  { name: "旧任 bd04f40b (从未注册)", ws: "mal-analyze-cli", withN: 0, withP: 0, withC: 0, woN: 607, woP: 316823203, woC: 313973504 },
];
const f = (n) => n.toLocaleString();
let wp = 0, wc = 0, wn = 0, op = 0, oc = 0;
console.log("session".padEnd(28), "with-sec n".padStart(10), "prompt".padStart(15), "cacheRead".padStart(14), "HIT".padStart(7), "|", "no-sec HIT".padStart(10));
for (const s of S) {
  wp += s.withP; wc += s.withC; wn += s.withN; op += s.woP; oc += s.woC;
  const wH = s.withP ? (s.withC / s.withP * 100).toFixed(1) + "%" : "—";
  const oH = s.woP ? (s.woC / s.woP * 100).toFixed(1) + "%" : "—";
  console.log(s.name.padEnd(28), String(s.withN).padStart(10), f(s.withP).padStart(15), f(s.withC).padStart(14), wH.padStart(7), "|", oH.padStart(10));
}
console.log("\n=== team 2026-10-08 aggregate ===");
console.log("  requests WITH the section   :", wn, " prompt:", f(wp), " cacheRead:", f(wc), " HIT:", (wc / wp * 100).toFixed(1) + "%");
console.log("  requests WITHOUT the section:", S.reduce((a, s) => a + s.woN, 0), " prompt:", f(op), " cacheRead:", f(oc), " HIT:", (oc / op * 100).toFixed(1) + "%");
const baseHit = oc / op;
const wouldCache = Math.round(wp * baseHit);
console.log("\n  baseline hit rate (no-section requests):", (baseHit * 100).toFixed(1) + "%");
console.log("  tokens that WOULD have been cached:", f(wouldCache));
console.log("  tokens actually cached:            ", f(wc));
console.log("  *** EXTRA full-price tokens:", f(wouldCache - wc), "***");
console.log("  as a share of all prompt tokens billed in these 6 sessions:", ((( wouldCache - wc) / (wp + op)) * 100).toFixed(1) + "%");
