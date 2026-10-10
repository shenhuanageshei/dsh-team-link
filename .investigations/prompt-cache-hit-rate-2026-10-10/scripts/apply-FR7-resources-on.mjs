// FR-7 撤止血：把 policy.sections.resources 从 false 改回 true。
// 与 A 止血同一套保守写法：只改两个字段，逐字段 diff 校验，无 BOM，回读确认。
import fs from "node:fs";
import path from "node:path";

const home = process.env.USERPROFILE || process.env.HOME;
const file = path.join(home, ".dsh", "team-link", "policy.json");
const raw = fs.readFileSync(file, "utf8");

console.log("=== BEFORE ===");
console.log("bytes            :", Buffer.byteLength(raw, "utf8"));
console.log("BOM              :", raw.charCodeAt(0) === 0xfeff ? "YES (!!)" : "no");
console.log("savedAt          :", JSON.parse(raw).savedAt);
console.log("sections (before):", JSON.stringify(JSON.parse(raw).policy.sections));

const before = JSON.parse(raw);
const doc = JSON.parse(raw);
doc.policy.sections = { ...(doc.policy.sections || {}), resources: true };
doc.savedAt = new Date().toISOString();
const out = JSON.stringify(doc, null, 2) + (raw.endsWith("\n") ? "\n" : "");

const after = JSON.parse(out);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffs = [];
(function walk(a, b, p) {
  if (deepEqual(a, b)) return;
  const both = a && b && typeof a === "object" && typeof b === "object";
  if (!both) { diffs.push(p + ": " + JSON.stringify(a) + " -> " + JSON.stringify(b)); return; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], p + "." + k);
})(before, after, "$");

console.log("\n=== field-level diff (expect exactly 2) ===");
diffs.forEach((d) => console.log("  " + d));
const wantSavedAt = "$.savedAt: " + JSON.stringify(before.savedAt) + " -> " + JSON.stringify(after.savedAt);
if (diffs.length !== 2 || !diffs.includes(wantSavedAt) || !diffs.includes("$.policy.sections.resources: false -> true")) {
  console.error("\n*** ABORT: unexpected diff set — nothing written. ***");
  process.exit(1);
}
if (after.policy.sections.role !== true) { console.error("\n*** ABORT: role switch changed. ***"); process.exit(1); }
if (out.charCodeAt(0) === 0xfeff) { console.error("\n*** ABORT: would write BOM. ***"); process.exit(1); }

fs.writeFileSync(file, out, "utf8");
const back = fs.readFileSync(file, "utf8");
console.log("\n=== AFTER (readback) ===");
console.log("first 3 bytes    :", [...Buffer.from(back, "utf8").subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
console.log("bytes            :", Buffer.byteLength(back, "utf8"));
console.log("JSON.parse       :", (() => { try { JSON.parse(back); return "OK"; } catch (e) { return "FAIL " + e.message; } })());
console.log("sections (after) :", JSON.stringify(JSON.parse(back).policy.sections));
console.log("teams preserved  :", JSON.parse(back).policy.teams.map((t) => t.name).join(", "));
console.log("U+FFFD present   :", back.includes("\uFFFD") ? "YES (!!)" : "no");
