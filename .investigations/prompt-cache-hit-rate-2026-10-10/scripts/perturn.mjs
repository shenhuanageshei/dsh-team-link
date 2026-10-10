import fs from "node:fs";
const P = "C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/";
const rows = JSON.parse(fs.readFileSync(P + "rows2.json", "utf8"));
const num = rows.filter((r) => typeof r.cacheR === "number");

// group by turn
const byTurn = new Map();
for (const r of num) {
  if (!byTurn.has(r.turn)) byTurn.set(r.turn, []);
  byTurn.get(r.turn).push(r);
}
let firstStepChanged = 0, laterStepChanged = 0, turnsN = 0;
const anomalies = [];
for (const [t, rs] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
  turnsN++;
  rs.sort((a, b) => a.step - b.step);
  const first = rs[0];
  if (first.sysChanged) firstStepChanged++;
  for (let i = 1; i < rs.length; i++) {
    if (rs[i].sysChanged) { laterStepChanged++; anomalies.push(`turn ${t} step ${rs[i].step}: sysChanged at non-first step`); }
  }
}
console.log("turns:", turnsN, " first-step sysChanged:", firstStepChanged, " non-first-step sysChanged:", laterStepChanged);
console.log("non-first-step anomalies:", anomalies.length);
anomalies.slice(0, 20).forEach((a) => console.log("   ", a));

// hit rate: first step of turn vs rest
const firstSteps = num.filter((r) => r.step === 1);
const laterSteps = num.filter((r) => r.step !== 1);
const agg = (sel, lbl) => {
  const p = sel.reduce((a, r) => a + r.prompt, 0), c = sel.reduce((a, r) => a + r.cacheR, 0);
  console.log(`  ${lbl.padEnd(30)} n=${String(sel.length).padStart(3)} prompt=${p.toLocaleString().padStart(15)} hit=${(c / p * 100).toFixed(1)}%  fullprice=${(p - c).toLocaleString()}`);
};
console.log("\n=== hit rate by position in turn ===");
agg(firstSteps, "step 1 (turn opening)");
agg(laterSteps, "step >1 (continuation)");

console.log("\n=== how many turns have their opening step as the ONLY miss ===");
let turnOpenMiss = 0, turnInnerMiss = 0;
for (const [, rs] of byTurn) {
  const miss = rs.filter((r) => r.cacheR / r.prompt < 0.5);
  if (miss.length) {
    if (miss.every((m) => m.step === 1)) turnOpenMiss++; else turnInnerMiss++;
  }
}
console.log("  turns whose only misses are the opening step:", turnOpenMiss);
console.log("  turns with a miss at a non-opening step:", turnInnerMiss);

console.log("\n=== distribution of sysChanged by turn (first 30 turns) ===");
for (const [t, rs] of [...byTurn.entries()].sort((a, b) => a[0] - b[0]).slice(0, 30)) {
  console.log(`  turn ${String(t).padStart(3)}: steps=${rs.length} sysChangedSteps=[${rs.filter((r) => r.sysChanged).map((r) => r.step).join(",")}] hit=[${rs.map((r) => (r.cacheR / r.prompt * 100).toFixed(0) + "%").join(",")}] prompt=[${rs.map((r) => Math.round(r.prompt / 1000) + "k").join(",")}]`);
}
