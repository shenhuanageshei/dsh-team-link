const S = [
  { n: "mal · coordinator d7ca53f8", m: "glm-5.3", n1: 116, p: 57025189, c: 4333888, base: 96.2 },
  { n: "mal · worker-1 944d2b52", m: "glm-5.3", n1: 145, p: 62423401, c: 334080, base: 99.0 },
  { n: "mal · worker-2 c1672114", m: "glm-5.3", n1: 96, p: 41466920, c: 221184, base: 99.4 },
  { n: "mal · worker-3 ce8aca21", m: "glm-5.3", n1: 110, p: 72241001, c: 4693184, base: 97.1 },
  { n: "mal · worker-4 34504f2d", m: "glm-5.3", n1: 10, p: 4428887, c: 363584, base: 96.7 },
  { n: "pulse · coordinator fac607b1", m: "glm-5.3", n1: 102, p: 49174140, c: 3814464, base: 98.4 },
  { n: "pulse · worker-1 48c45b1d", m: "glm-5.3", n1: 246, p: 102921074, c: 8973120, base: 99.1 },
  { n: "bac · coordinator a6b13edb", m: "deepseek-flash", n1: 202, p: 82820790, c: 67554944, base: 77.5 },
  { n: "bac · worker-1 be82b003", m: "deepseek-flash", n1: 141, p: 52650315, c: 50708480, base: 99.1 },
];
const f = (n) => n.toLocaleString();
const glm = S.filter((s) => s.m === "glm-5.3");
const ds = S.filter((s) => s.m !== "glm-5.3");
const sum = (a, k) => a.reduce((x, s) => x + s[k], 0);
console.log("=== requests where the team-link section was in the system prompt ===");
for (const s of S) console.log(`  ${s.n.padEnd(32)} ${s.m.padEnd(15)} n=${String(s.n1).padStart(4)} prompt=${f(s.p).padStart(15)} HIT=${(s.c / s.p * 100).toFixed(1)}%`);
console.log("\n--- glm-5.3 (zai) sessions ---");
const gp = sum(glm, "p"), gc = sum(glm, "c");
console.log(`  requests=${sum(glm, "n1")} prompt=${f(gp)} cacheRead=${f(gc)} HIT=${(gc / gp * 100).toFixed(1)}%`);
const gbase = glm.reduce((a, s) => a + s.base * s.p, 0) / gp / 100;
console.log(`  baseline (same sessions without the section) ≈ ${(gbase * 100).toFixed(1)}%`);
console.log(`  would-have-been-cached ≈ ${f(Math.round(gp * gbase))}  →  EXTRA full-price ≈ ${f(Math.round(gp * gbase) - gc)}`);
console.log("\n--- deepseek-flash sessions ---");
const dp = sum(ds, "p"), dc = sum(ds, "c");
console.log(`  requests=${sum(ds, "n1")} prompt=${f(dp)} cacheRead=${f(dc)} HIT=${(dc / dp * 100).toFixed(1)}%`);
console.log("\n=== ALL 9 measured sessions, section-bearing requests ===");
const ap = gp + dp, ac = gc + dc;
console.log(`  n=${sum(S, "n1")} prompt=${f(ap)} cacheRead=${f(ac)} HIT=${(ac / ap * 100).toFixed(1)}%`);
console.log(`  glm-only extra full-price tokens ≈ ${f(Math.round(gp * gbase) - gc)}`);
