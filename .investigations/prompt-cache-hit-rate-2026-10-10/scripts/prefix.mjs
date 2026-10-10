import fs from "node:fs";
import crypto from "node:crypto";
const lines = fs.readFileSync("C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l));
const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 10);

// index request/header by seq to know which provider/model/tools each request used
const headers = evs.filter((e) => e.type === "request/header");
console.log("request/header count:", headers.length);
const sysmsgs = evs.filter((e) => e.type === "system/message");
console.log("system/message count:", sysmsgs.length);

// system prompt hashes + lengths
const sysMeta = sysmsgs.map((e) => {
  const txt = JSON.stringify(e.data.message?.content ?? e.data.message);
  return { seq: e.seq, time: e.time, len: txt.length, hash: h(txt) };
});
const uniqSys = new Map();
for (const s of sysMeta) uniqSys.set(s.hash, (uniqSys.get(s.hash) || 0) + 1);
console.log("\nunique system-prompt hashes:", uniqSys.size);
[...uniqSys.entries()].forEach(([k, v]) => console.log("  ", k, "x", v));

// tools sets
const toolMeta = headers.map((e) => {
  const t = e.data.header?.tools || [];
  return { seq: e.seq, time: e.time, n: t.length, hash: h(JSON.stringify(t)), names: t.map((x) => x.name) };
});
const uniqTools = new Map();
for (const t of toolMeta) uniqTools.set(t.hash, (uniqTools.get(t.hash) || 0) + 1);
console.log("\nunique tool-set hashes:", uniqTools.size);
[...uniqTools.entries()].forEach(([k, v]) => console.log("  ", k, "x", v, "n=", toolMeta.find((t) => t.hash === k).n));

// provider/model per header
console.log("\nheader provider/model sequence:");
let prev = null;
for (const t of toolMeta) {
  const cfg = headers.find((e) => e.seq === t.seq).data.header.config;
  const key = cfg.provider + "/" + cfg.model + " tmp=" + cfg.temperature + " max=" + cfg.maxTokens;
  if (key !== prev) { console.log("  seq", t.seq, new Date(t.time).toISOString(), "->", key); prev = key; }
}
