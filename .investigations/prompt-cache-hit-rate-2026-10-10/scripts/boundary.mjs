import fs from "node:fs";
const P = "C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/";
const rows = JSON.parse(fs.readFileSync(P + "rows2.json", "utf8"));
const lines = fs.readFileSync(P + "session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq);

// locate the boundary: last request before the first sustained sysChanged
const num = rows.filter((r) => typeof r.cacheR === "number");
const firstBad = num.find((r) => r.sysChanged && r.turn > 10);
console.log("first sustained sysChanged request: seq", firstBad.seq, "turn", firstBad.turn, "step", firstBad.step, new Date(firstBad.time).toISOString());
console.log("its sys seq (system/message event):", firstBad.sysSeq);

const lo = firstBad.seq - 60, hi = firstBad.seq + 5;
console.log("\n=== events seq " + lo + ".." + hi + " ===");
for (const e of evs) {
  if (e.seq < lo || e.seq > hi) continue;
  let extra = "";
  const d = e.data || {};
  if (e.type === "user/message") extra = JSON.stringify(d.content || "").slice(0, 220);
  else if (e.type === "tool/call") extra = d.name + " " + String(d.arguments).slice(0, 220);
  else if (e.type === "tool/result") extra = JSON.stringify((d.message?.content || []).map((c) => c.text).join("").slice(0, 220));
  else if (e.type === "assistant/message") extra = "usage=" + JSON.stringify(d.usage) + " text=" + JSON.stringify((d.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 120));
  else if (e.type === "system/message") extra = "(system prompt emitted, len " + (d.message?.content || []).map((c) => c.text || "").join("").length + ")";
  else if (e.type === "agent/inbox/spliced") extra = "target=" + d.target + " n=" + (d.inserted || []).length + " " + JSON.stringify((d.inserted || [])[0]?.content?.[0]?.text || "").slice(0, 160);
  else extra = JSON.stringify(d).slice(0, 160);
  console.log(`  [${e.seq}] ${e.time ? new Date(e.time).toISOString() : "(no time)"} ${e.type}  ${extra}`);
}
