// A 止血：把 policy.sections.resources 置 false。逐字节保守写回：格式 / 换行 / 缩进与原文一致。
import fs from "node:fs";
import path from "node:path";

const home = process.env.USERPROFILE || process.env.HOME;
const file = path.join(home, ".dsh", "team-link", "policy.json");
const raw = fs.readFileSync(file, "utf8");

// --- 1) 前置读数（改前）---
console.log("=== BEFORE ===");
console.log("bytes           :", Buffer.byteLength(raw, "utf8"));
console.log("BOM             :", raw.charCodeAt(0) === 0xfeff ? "YES (!!)" : "no");
console.log("CRLF count      :", (raw.match(/\r\n/g) || []).length);
console.log("trailing newline:", raw.endsWith("\n") ? "yes" : "no");

const doc = JSON.parse(raw);
console.log("schema          :", doc.schema);
console.log("savedAt         :", doc.savedAt);
console.log("sections (before):", JSON.stringify(doc.policy.sections));

// --- 2) 只改两个字段 ---
const before = JSON.parse(raw);
doc.policy.sections = { ...(doc.policy.sections || {}), resources: false };
doc.savedAt = new Date().toISOString();

const out = JSON.stringify(doc, null, 2) + (raw.endsWith("\n") ? "\n" : "");

// --- 3) 断言：除 savedAt / policy.sections.resources 外，其余逐字段不变 ---
const after = JSON.parse(out);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffs = [];
(function walk(a, b, p) {
  if (deepEqual(a, b)) return;
  const both = a && b && typeof a === "object" && typeof b === "object";
  if (!both) { diffs.push(p + ": " + JSON.stringify(a) + " -> " + JSON.stringify(b)); return; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], p + "." + k);
})(before, after, "$");

console.log("\n=== field-level diff (should be exactly 2) ===");
diffs.forEach((d) => console.log("  " + d));
if (diffs.length !== 2 || !diffs.some((d) => d === "$.savedAt: " + JSON.stringify(before.savedAt) + " -> " + JSON.stringify(after.savedAt)) || !diffs.some((d) => d.startsWith("$.policy.sections.resources:"))) {
  console.error("\n*** ABORT: unexpected diff set — nothing written. ***");
  process.exit(1);
}
if (after.policy.sections.role !== true) { console.error("\n*** ABORT: role switch would change. ***"); process.exit(1); }
if (out.charCodeAt(0) === 0xfeff) { console.error("\n*** ABORT: would write a BOM. ***"); process.exit(1); }

// --- 4) 写回 + 回读 ---
fs.writeFileSync(file, out, "utf8");
const back = fs.readFileSync(file, "utf8");
console.log("\n=== AFTER (readback) ===");
console.log("first 3 bytes   :", [...Buffer.from(back, "utf8").subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
console.log("bytes           :", Buffer.byteLength(back, "utf8"));
console.log("JSON.parse      :", (() => { try { JSON.parse(back); return "OK"; } catch (e) { return "FAIL " + e.message; } })());
console.log("sections (after):", JSON.stringify(JSON.parse(back).policy.sections));
console.log("savedAt  (after):", JSON.parse(back).savedAt);
console.log("teams preserved :", JSON.parse(back).policy.teams.map((t) => t.name).join(", "));
console.log("U+FFFD present  :", back.includes("\uFFFD") ? "YES (!!)" : "no");
