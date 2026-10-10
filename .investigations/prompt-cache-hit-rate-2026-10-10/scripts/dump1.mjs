import fs from "node:fs";
const lines = fs.readFileSync("C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
for (const l of lines) {
  if (!l.includes("cacheRead")) continue;
  const o = JSON.parse(l);
  console.log("type:", o.type, "seq:", o.seq, "top keys:", Object.keys(o), "data keys:", Object.keys(o.data || {}));
  const d = o.data;
  for (const [k, v] of Object.entries(d)) {
    const s = JSON.stringify(v);
    console.log("  data." + k + " = " + (s.length > 400 ? s.slice(0, 400) + " …[len " + s.length + "]" : s));
  }
  // recursively find cacheRead
  const found = [];
  (function walk(x, path) {
    if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (/cacheRead|inputTokens|outputTokens/i.test(k)) found.push(path + "." + k + " = " + JSON.stringify(v));
        walk(v, path + "." + k);
      }
    }
  })(o, "");
  console.log("  >>> found:", found.join(" | ").slice(0, 800));
  break;
}
