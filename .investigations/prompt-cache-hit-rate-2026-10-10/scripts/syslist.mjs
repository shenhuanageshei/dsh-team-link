import fs from "node:fs";
const P = "C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/";
const lines = fs.readFileSync(P + "session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq);
const txtOf = (c) => (c || []).map((x) => x.text || "").join("");
const sysEvs = evs.filter((e) => e.type === "system/message");
console.log("=== all system/message events: seq | time | len | has-section | resource-line ===");
for (const e of sysEvs) {
  const t = txtOf(e.data.message?.content);
  const has = t.includes("[team-link 会话资源]");
  const line = t.split("\n").find((l) => l.startsWith("[team-link 会话资源]")) || "";
  if (e.seq > 2300 || !has) console.log(`  ${String(e.seq).padStart(5)} | ${new Date(e.time).toISOString()} | len=${t.length} | has=${has} | ${line.slice(0, 90)}`);
}
console.log("\ntotal system/message:", sysEvs.length);
const tail = sysEvs.filter((e) => e.seq > 2300);
console.log("events after 2300:", tail.length, " with section:", tail.filter((e) => txtOf(e.data.message?.content).includes("[team-link 会话资源]")).length);
