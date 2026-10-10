import fs from "node:fs";
import crypto from "node:crypto";
const P = "C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/";
const lines = fs.readFileSync(P + "session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq);
const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);

const sysEvs = evs.filter((e) => e.type === "system/message");
const txtOf = (e) => (e.data.message?.content || []).map((c) => c.text || "").join("");
const texts = sysEvs.map(txtOf);

// character-level diff summary between consecutive system prompts
function commonPrefixLen(a, b) { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a[i] === b[i]) i++; return i; }
function commonSuffixLen(a, b) { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }

console.log("system/message events:", sysEvs.length);
console.log("first prompt len:", texts[0].length, " last prompt len:", texts[texts.length - 1].length);
console.log("\n=== consecutive diffs (first 40) ===");
for (let i = 1; i < texts.length && i <= 40; i++) {
  const a = texts[i - 1], b = texts[i];
  if (a === b) { console.log(i, "IDENTICAL"); continue; }
  const cp = commonPrefixLen(a, b);
  const cs = commonSuffixLen(a, b);
  console.log(`\n#${i} seq=${sysEvs[i].seq} len ${a.length} -> ${b.length}  commonPrefix=${cp} commonSuffix=${cs}`);
  console.log("  changed region OLD: " + JSON.stringify(a.slice(Math.max(0, cp - 60), a.length - cs)).slice(0, 900));
  console.log("  changed region NEW: " + JSON.stringify(b.slice(Math.max(0, cp - 60), b.length - cs)).slice(0, 900));
}
